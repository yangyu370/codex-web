import { expect, test } from "bun:test";

import {
  runWindowsAppServerHost,
  type WindowsHostControlResponse,
  type WindowsAppServerHostRuntime,
  type WindowsProcessIdentity,
} from "./windows-app-server-host";

test("hosts the native app-server with bounded diagnostics and generation lease", async () => {
  const leases: Array<{
    generation: string;
    hostPid: number;
    nativePid: number;
    hostIdentity: WindowsProcessIdentity;
    nativeIdentity: WindowsProcessIdentity;
  }> = [];
  let diagnostics = "";
  const runtime: WindowsAppServerHostRuntime = {
    hostPid: 41,
    now: () => 1_000,
    spawn(command, env) {
      expect(command).toEqual([
        "C:\\Tools\\codex.exe",
        "app-server",
        "--listen",
        "ws://127.0.0.1:4500",
      ]);
      expect(env.CODEX_HOME).toBe("C:\\Users\\dev\\.codex");
      return {
        pid: 42,
        stdout: stream("old-marker" + "x".repeat(270_000)),
        stderr: stream("new-marker"),
        exited: Promise.resolve(7),
        kill() {},
      };
    },
    async writeLease(lease) { leases.push(lease); },
    async describeProcess(pid) {
      return identity(pid, pid === 42 ? 41 : 0, pid === 42
        ? "C:\\Tools\\codex.exe"
        : "C:\\Tools\\bun.exe");
    },
    async readControlRequest() { return undefined; },
    async writeControlResponse() {},
    async stopProcessTree() {},
    async sleep() {},
    async writeDiagnostics(value) { diagnostics = value; },
  };

  const exitCode = await runWindowsAppServerHost({
    endpoint: "ws://127.0.0.1:4500",
    codexHome: "C:\\Users\\dev\\.codex",
    executable: "C:\\Tools\\codex.exe",
    generation: "generation-1",
  }, runtime);

  expect(exitCode).toBe(7);
  expect(leases).toEqual([{
    generation: "generation-1",
    hostPid: 41,
    nativePid: 42,
    hostIdentity: identity(41, 0, "C:\\Tools\\bun.exe"),
    nativeIdentity: identity(42, 41, "C:\\Tools\\codex.exe"),
  }]);
  expect(Buffer.byteLength(diagnostics)).toBeLessThanOrEqual(262_144);
  expect(diagnostics).not.toContain("old-marker");
  expect(diagnostics).toContain("new-marker");
});

test("stops the verified native process tree through the generation control channel", async () => {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  const responses: WindowsHostControlResponse[] = [];
  let stoppedPid: number | undefined;
  let nativeIdentityChecks = 0;
  const runtime: WindowsAppServerHostRuntime = {
    hostPid: 41,
    now: Date.now,
    spawn: () => ({
      pid: 42,
      stdout: stream(""),
      stderr: stream(""),
      exited,
      kill() {},
    }),
    async writeLease() {},
    async describeProcess(pid) {
      if (pid === 42) nativeIdentityChecks += 1;
      return identity(pid, pid === 42 ? 41 : 0, pid === 42
        ? "C:\\Tools\\codex.exe"
        : "C:\\Tools\\bun.exe");
    },
    async readControlRequest() {
      return {
        schemaVersion: 1,
        action: "stop",
        nonce: "nonce-1",
        generation: "generation-1",
        hostPid: 41,
        nativePid: 42,
      } as const;
    },
    async writeControlResponse(response) { responses.push(response); },
    async stopProcessTree(child) {
      stoppedPid = child.pid;
      resolveExit(0);
    },
    async sleep() {},
    async writeDiagnostics() {},
  };

  await expect(runWindowsAppServerHost({
    endpoint: "ws://127.0.0.1:4500",
    codexHome: "C:\\Users\\dev\\.codex",
    executable: "C:\\Tools\\codex.exe",
    generation: "generation-1",
  }, runtime)).resolves.toBe(0);

  expect(stoppedPid).toBe(42);
  expect(nativeIdentityChecks).toBe(2);
  expect(responses).toEqual([{ action: "stop", status: "stopped", nonce: "nonce-1",
    schemaVersion: 1, generation: "generation-1", hostPid: 41, nativePid: 42 }]);
});

test("keeps the control monitor alive after a transient response write failure", async () => {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  let writes = 0;
  const runtime: WindowsAppServerHostRuntime = {
    hostPid: 41,
    now: Date.now,
    spawn: () => ({ pid: 42, stdout: stream(""), stderr: stream(""), exited, kill() {} }),
    async writeLease() {},
    async describeProcess(pid) {
      return identity(pid, pid === 42 ? 41 : 0, pid === 42
        ? "C:\\Tools\\codex.exe"
        : "C:\\Tools\\bun.exe");
    },
    async readControlRequest() {
      return {
        schemaVersion: 1,
        action: "probe",
        nonce: "nonce-retry",
        generation: "generation-1",
        hostPid: 41,
        nativePid: 42,
      } as const;
    },
    async writeControlResponse() {
      writes += 1;
      if (writes === 1) throw new Error("transient rename failure");
      resolveExit(0);
    },
    async stopProcessTree() {},
    async sleep() {},
    async writeDiagnostics() {},
  };

  await runWindowsAppServerHost({
    endpoint: "ws://127.0.0.1:4500",
    codexHome: "C:\\Users\\dev\\.codex",
    executable: "C:\\Tools\\codex.exe",
    generation: "generation-1",
  }, runtime);

  expect(writes).toBe(2);
});

function identity(
  pid: number,
  parentPid: number,
  executablePath: string,
): WindowsProcessIdentity {
  return {
    pid,
    parentPid,
    creationDate: `20260825-${pid}`,
    executablePath,
    commandLine: `${executablePath} command`,
  };
}

function stream(source: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(source));
      controller.close();
    },
  });
}
