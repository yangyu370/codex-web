import { describe, expect, test } from "bun:test";

import type { AppServerProcess, HostPlatform } from "../platform";
import type { JsonRpcTransport } from "./json-rpc";
import { AppServerProcessManager } from "./process-manager";

class MemoryTransport implements JsonRpcTransport {
  readonly outbound: string[] = [];
  closeCount = 0;
  readonly #messageListeners = new Set<(source: string) => void>();
  readonly #closeListeners = new Set<(reason?: Error) => void>();

  send(source: string): void { this.outbound.push(source); }
  close(): void { this.closeCount += 1; }
  onMessage(listener: (source: string) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }
  onClose(listener: (reason?: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }
  receive(value: unknown): void {
    const source = JSON.stringify(value);
    for (const listener of this.#messageListeners) listener(source);
  }
  disconnect(reason = new Error("daemon disconnected")): void {
    for (const listener of this.#closeListeners) listener(reason);
  }
}

function fakeProcess() {
  const stdout = new TransformStream<Uint8Array, Uint8Array>();
  const stderr = new TransformStream<Uint8Array, Uint8Array>();
  const stdoutWriter = stdout.writable.getWriter();
  const stderrWriter = stderr.writable.getWriter();
  const outbound: string[] = [];
  let resolveExit: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const child: AppServerProcess = {
    pid: 77,
    stdin: {
      write(data) {
        outbound.push(typeof data === "string" ? data : new TextDecoder().decode(data));
        return data.length;
      },
      end() {},
    },
    stdout: stdout.readable,
    stderr: stderr.readable,
    exited,
    kill() {},
  };
  return {
    child,
    outbound,
    resolveExit,
    async send(value: unknown) {
      await stdoutWriter.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
    },
    async sendStderr(value: string) {
      await stderrWriter.write(new TextEncoder().encode(value));
    },
  };
}

function fakePlatform(
  processes: ReturnType<typeof fakeProcess>[],
  onTerminate: (process: AppServerProcess) => void = () => undefined,
  kind: HostPlatform["kind"] = "windows",
): HostPlatform {
  return {
    kind,
    arch: "arm64",
    resolveCodexExecutable: async () => "/opt/codex/bin/codex",
    validateWorkingDirectory: async (input) => ({ displayPath: input, resolvedPath: input }),
    spawnAppServer: () => {
      const process = processes.shift();
      if (!process) {
        throw new Error("no fake process available");
      }
      return process.child;
    },
    spawnCommand: () => {
      throw new Error("unexpected lifecycle command");
    },
    terminateProcessTree: async (process) => onTerminate(process),
    homeDirectory: () => "/work",
    dataDirectory: () => "/tmp/codex-web",
    diagnostics: async () => ({ platform: "macos", arch: "arm64" }),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition not reached");
}

describe("AppServerProcessManager", () => {
  test("reports executable discovery failures as unavailable", async () => {
    const platform = fakePlatform([]);
    platform.resolveCodexExecutable = async () => {
      throw new Error("codex not found");
    };
    const manager = new AppServerProcessManager(platform);

    await expect(manager.start()).rejects.toThrow("codex not found");

    expect(manager.snapshot()).toMatchObject({
      status: "unavailable",
      error: "codex not found",
      liveHandoff: "unavailable",
    });
  });

  test("prefers the shared daemon on macOS and leaves it running on stop", async () => {
    const transport = new MemoryTransport();
    const terminated: number[] = [];
    const lifecycleCalls: string[] = [];
    const manager = new AppServerProcessManager(
      fakePlatform([], (child) => terminated.push(child.pid), "macos"),
      {
        version: async () => "codex-cli 1.2.3",
        daemonStart: async (_executable, codexHome) => {
          lifecycleCalls.push(codexHome);
          return {
            socketPath: `${codexHome}/app-server-control/app-server-control.sock`,
            appServerVersion: "1.2.3",
          };
        },
        daemonConnect: async () => transport,
      },
    );

    const starting = manager.start();
    await waitFor(() => transport.outbound.length === 1);
    transport.receive({ jsonrpc: "2.0", id: 1, result: {} });
    await starting;

    expect(lifecycleCalls).toEqual(["/work/.codex"]);
    expect(manager.snapshot()).toMatchObject({
      status: "ready",
      mode: "daemon",
      liveHandoff: "available",
    });

    await manager.stop();
    expect(transport.closeCount).toBe(1);
    expect(terminated).toEqual([]);
  });

  test.each(["lifecycle", "socket"])(
    "falls back to embedded mode after a daemon %s failure",
    async (failure) => {
      const process = fakeProcess();
      const manager = new AppServerProcessManager(
        fakePlatform([process], undefined, "macos"),
        {
          version: async () => "codex-cli 1.2.3",
          daemonStart: async () => {
            if (failure === "lifecycle") throw new Error("daemon start failed");
            return { socketPath: "/work/.codex/app-server-control/socket" };
          },
          daemonConnect: async () => {
            throw new Error("daemon socket failed");
          },
        },
      );

      const starting = manager.start();
      await waitFor(() => process.outbound.length === 1);
      await process.send({ jsonrpc: "2.0", id: 1, result: {} });
      await starting;

      expect(manager.snapshot()).toMatchObject({
        status: "ready",
        mode: "embedded",
        liveHandoff: "unavailable",
      });
      expect(manager.snapshot().error).toContain(
        failure === "lifecycle" ? "daemon start failed" : "daemon socket failed",
      );
    },
  );

  test("never invokes daemon lifecycle startup on Windows", async () => {
    const process = fakeProcess();
    let daemonStarts = 0;
    const manager = new AppServerProcessManager(fakePlatform([process]), {
      version: async () => "codex-cli 1.2.3",
      daemonStart: async () => {
        daemonStarts += 1;
        throw new Error("must not run");
      },
    });

    const starting = manager.start();
    await waitFor(() => process.outbound.length === 1);
    await process.send({ jsonrpc: "2.0", id: 1, result: {} });
    await starting;

    expect(daemonStarts).toBe(0);
    expect(manager.snapshot()).toMatchObject({
      mode: "embedded",
      liveHandoff: "unavailable",
    });
  });

  test("reconnects the shared daemon with bounded backoff", async () => {
    const first = new MemoryTransport();
    const second = new MemoryTransport();
    const transports = [first, second];
    const delays: number[] = [];
    let lifecycleStarts = 0;
    const manager = new AppServerProcessManager(fakePlatform([], undefined, "macos"), {
      version: async () => "codex-cli 1.2.3",
      daemonStart: async () => {
        lifecycleStarts += 1;
        return { socketPath: "/work/.codex/app-server-control/socket" };
      },
      daemonConnect: async () => {
        const transport = transports.shift();
        if (!transport) throw new Error("no daemon transport available");
        return transport;
      },
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    });
    const starting = manager.start();
    await waitFor(() => first.outbound.length === 1);
    first.receive({ jsonrpc: "2.0", id: 1, result: {} });
    await starting;

    first.disconnect();
    await waitFor(() => second.outbound.length === 1);
    second.receive({ jsonrpc: "2.0", id: 1, result: {} });
    await waitFor(() => manager.snapshot().status === "ready");

    expect(delays).toEqual([250]);
    expect(lifecycleStarts).toBe(2);
    expect(manager.snapshot()).toMatchObject({ mode: "daemon", liveHandoff: "available" });
  });

  test("becomes ready only after initialize and initialized handshake", async () => {
    const process = fakeProcess();
    const manager = new AppServerProcessManager(fakePlatform([process]), {
      version: async () => "codex-cli 1.2.3",
    });

    const starting = manager.start();
    await waitFor(() => process.outbound.length === 1);
    expect(JSON.parse(process.outbound[0] ?? "null")).toMatchObject({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codex-web", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    });
    expect(manager.snapshot().status).toBe("starting");

    await process.send({ jsonrpc: "2.0", id: 1, result: { userAgent: "codex" } });
    await starting;
    expect(JSON.parse(process.outbound[1] ?? "null")).toEqual({
      jsonrpc: "2.0",
      method: "initialized",
    });
    expect(manager.snapshot()).toMatchObject({
      status: "ready",
      codexVersion: "codex-cli 1.2.3",
    });
  });

  test("bounds stderr diagnostics to the newest 256 KiB", async () => {
    const process = fakeProcess();
    const manager = new AppServerProcessManager(fakePlatform([process]), {
      version: async () => "codex-cli 1.2.3",
    });
    const starting = manager.start();
    await waitFor(() => process.outbound.length === 1);
    await process.send({ jsonrpc: "2.0", id: 1, result: {} });
    await starting;

    await process.sendStderr(`old-marker${"x".repeat(270_000)}new-marker`);
    await waitFor(() => manager.diagnostics().includes("new-marker"));
    expect(manager.diagnostics()).not.toContain("old-marker");
    expect(new TextEncoder().encode(manager.diagnostics()).byteLength).toBeLessThanOrEqual(
      262_144,
    );
  });

  test("cleans up a child that rejects initialization", async () => {
    const process = fakeProcess();
    const terminated: number[] = [];
    const manager = new AppServerProcessManager(
      fakePlatform([process], (child) => terminated.push(child.pid)),
      { version: async () => "codex-cli 1.2.3" },
    );
    const starting = manager.start();
    await waitFor(() => process.outbound.length === 1);
    await process.send({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "incompatible initialize" },
    });

    await expect(starting).rejects.toThrow("incompatible initialize");
    expect(terminated).toEqual([77]);
    expect(manager.snapshot().status).toBe("unavailable");
  });

  test("restarts after an unexpected exit without replaying app requests", async () => {
    const first = fakeProcess();
    const second = fakeProcess();
    const delays: number[] = [];
    const manager = new AppServerProcessManager(fakePlatform([first, second]), {
      version: async () => "codex-cli 1.2.3",
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    const firstStart = manager.start();
    await waitFor(() => first.outbound.length === 1);
    await first.send({ jsonrpc: "2.0", id: 1, result: {} });
    await firstStart;

    first.resolveExit(1);
    await waitFor(() => second.outbound.length === 1);
    expect(delays).toEqual([250]);
    expect(second.outbound.map((line) => JSON.parse(line).method)).toEqual(["initialize"]);
    await second.send({ jsonrpc: "2.0", id: 1, result: {} });
    await waitFor(() => manager.snapshot().status === "ready");
  });

  test("continues bounded backoff across repeated relaunch failures", async () => {
    const first = fakeProcess();
    const recovered = fakeProcess();
    const platform = fakePlatform([first, recovered]);
    const spawn = platform.spawnAppServer.bind(platform);
    let attempts = 0;
    platform.spawnAppServer = (executable, env) => {
      attempts += 1;
      if (attempts === 2 || attempts === 3) throw new Error("temporary launch failure");
      return spawn(executable, env);
    };
    const delays: number[] = [];
    const manager = new AppServerProcessManager(platform, {
      version: async () => "codex-cli 1.2.3",
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    });
    const firstStart = manager.start();
    await waitFor(() => first.outbound.length === 1);
    await first.send({ jsonrpc: "2.0", id: 1, result: {} });
    await firstStart;

    first.resolveExit(1);
    await waitFor(() => recovered.outbound.length === 1);

    expect(attempts).toBe(4);
    expect(delays).toEqual([250, 1_000, 4_000]);
  });

  test("keeps restart recovery single-flight when a replacement exits during initialize", async () => {
    const first = fakeProcess();
    const second = fakeProcess();
    const recovered = fakeProcess();
    const unexpected = fakeProcess();
    const manager = new AppServerProcessManager(
      fakePlatform([first, second, recovered, unexpected]),
      { version: async () => "codex-cli 1.2.3", sleep: async () => undefined },
    );
    const initial = manager.start();
    await waitFor(() => first.outbound.length === 1);
    await first.send({ jsonrpc: "2.0", id: 1, result: {} });
    await initial;

    first.resolveExit(1);
    await waitFor(() => second.outbound.length === 1);
    second.resolveExit(2);
    await waitFor(() => recovered.outbound.length === 1);
    await recovered.send({ jsonrpc: "2.0", id: 1, result: {} });
    await waitFor(() => manager.snapshot().status === "ready");
    await Bun.sleep(5);

    expect(unexpected.outbound).toEqual([]);
  });

  test("forces process-tree cleanup after the graceful shutdown period", async () => {
    const process = fakeProcess();
    const terminated: number[] = [];
    const manager = new AppServerProcessManager(
      fakePlatform([process], (child) => terminated.push(child.pid)),
      { version: async () => "codex-cli 1.2.3" },
    );
    const starting = manager.start();
    await waitFor(() => process.outbound.length === 1);
    await process.send({ jsonrpc: "2.0", id: 1, result: {} });
    await starting;

    await manager.stop(0);
    expect(terminated).toEqual([77]);
    expect(manager.snapshot().status).toBe("unavailable");
  });
});
