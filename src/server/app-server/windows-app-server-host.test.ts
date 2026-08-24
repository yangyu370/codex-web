import { expect, test } from "bun:test";

import {
  runWindowsAppServerHost,
  type WindowsAppServerHostRuntime,
} from "./windows-app-server-host";

test("hosts the native app-server with bounded diagnostics and generation lease", async () => {
  const leases: Array<{ generation: string; hostPid: number; nativePid: number }> = [];
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
  }]);
  expect(Buffer.byteLength(diagnostics)).toBeLessThanOrEqual(262_144);
  expect(diagnostics).not.toContain("old-marker");
  expect(diagnostics).toContain("new-marker");
});

function stream(source: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(source));
      controller.close();
    },
  });
}
