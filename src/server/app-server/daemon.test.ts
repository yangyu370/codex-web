import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AppServerProcess, PlatformRuntime } from "../platform";
import { parseDaemonStartOutput, startManagedDaemon } from "./daemon";

const codexHome = "/Users/test/.codex";
const socketPath = `${codexHome}/app-server-control/app-server-control.sock`;

describe.skipIf(process.platform !== "darwin")("parseDaemonStartOutput", () => {
  test.each(["started", "alreadyRunning"])("accepts %s daemon lifecycle output", (status) => {
    expect(parseDaemonStartOutput(JSON.stringify({
      status,
      socketPath,
      appServerVersion: "0.147.0",
    }), codexHome)).toEqual({ socketPath, appServerVersion: "0.147.0" });
  });

  test.each([
    ["malformed JSON", "not-json"],
    ["unknown lifecycle status", JSON.stringify({ status: "stopped", socketPath })],
    ["relative socket path", JSON.stringify({ status: "started", socketPath: "control.sock" })],
    ["socket path outside Codex home", JSON.stringify({
      status: "started",
      socketPath: "/tmp/app-server-control.sock",
    })],
  ])("rejects %s", (_label, output) => {
    expect(() => parseDaemonStartOutput(output, codexHome)).toThrow();
  });

  test("accepts a socket under the canonical target of a symlinked Codex home", async () => {
    const root = await mkdtemp("/tmp/cw-daemon-path-");
    const realHome = path.join(root, "real-home");
    const linkedHome = path.join(root, "linked-home");
    const canonicalSocket = path.join(
      realHome,
      "app-server-control",
      "app-server-control.sock",
    );
    try {
      await mkdir(path.dirname(canonicalSocket), { recursive: true });
      await symlink(realHome, linkedHome);

      expect(parseDaemonStartOutput(JSON.stringify({
        status: "started",
        socketPath: canonicalSocket,
      }), linkedHome)).toEqual({
        socketPath: canonicalSocket,
        appServerVersion: undefined,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a symbolic-link daemon socket", async () => {
    const root = await mkdtemp("/tmp/cw-daemon-socket-");
    const home = path.join(root, "home");
    const socket = path.join(home, "app-server-control", "app-server-control.sock");
    const outside = path.join(root, "outside.sock");
    try {
      await mkdir(path.dirname(socket), { recursive: true });
      await writeFile(outside, "not a socket");
      await symlink(outside, socket);

      expect(() => parseDaemonStartOutput(JSON.stringify({
        status: "started",
        socketPath: socket,
      }), home)).toThrow("must not be a symbolic link");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== "darwin")("startManagedDaemon", () => {
  test("spawns the idempotent lifecycle command with the active Codex home", async () => {
    const commands: string[][] = [];
    const environments: Record<string, string>[] = [];
    const runtime = daemonRuntime(() => processWith({
      stdout: JSON.stringify({ status: "started", socketPath }),
    }), commands, environments);

    await expect(startManagedDaemon("/opt/codex/bin/codex", codexHome, runtime)).resolves
      .toEqual({ socketPath, appServerVersion: undefined });
    expect(commands).toEqual([
      ["/opt/codex/bin/codex", "app-server", "daemon", "start"],
    ]);
    expect(environments[0]?.CODEX_HOME).toBe(codexHome);
  });

  test("rejects nonzero lifecycle exits with bounded stderr context", async () => {
    const runtime = daemonRuntime(() => processWith({
      stderr: "daemon unavailable",
      exitCode: 2,
    }));

    await expect(startManagedDaemon("/opt/codex/bin/codex", codexHome, runtime))
      .rejects.toThrow("exited with 2: daemon unavailable");
  });

  test("rejects lifecycle output beyond 64 KiB", async () => {
    const runtime = daemonRuntime(() => processWith({ stdout: "x".repeat(65_537) }));

    await expect(startManagedDaemon("/opt/codex/bin/codex", codexHome, runtime))
      .rejects.toThrow("output exceeded 65536 bytes");
  });
});

function daemonRuntime(
  createProcess: () => AppServerProcess,
  commands: string[][] = [],
  environments: Record<string, string>[] = [],
): Pick<PlatformRuntime, "spawn"> {
  return {
    spawn(command, env) {
      commands.push(command);
      environments.push(env);
      return createProcess();
    },
  };
}

function processWith(options: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): AppServerProcess {
  return {
    pid: 101,
    stdin: { write: () => 0, end: () => undefined },
    stdout: byteStream(options.stdout ?? ""),
    stderr: byteStream(options.stderr ?? ""),
    exited: Promise.resolve(options.exitCode ?? 0),
    kill() {},
  };
}

function byteStream(source: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(source));
      controller.close();
    },
  });
}
