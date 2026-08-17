import { describe, expect, test } from "bun:test";

import { createSystemRuntime } from "./system-runtime";

const supported = process.platform === "darwin" || process.platform === "win32";

describe.skipIf(!supported)("system platform runtime", () => {
  test("resolves and launches a native executable with piped stdio", async () => {
    const runtime = createSystemRuntime();
    const bun = await runtime.resolveOnPath(process.platform === "win32" ? "bun.exe" : "bun");
    const child = runtime.spawn([bun, "--version"], environment());
    const [output, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(output.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("terminates a running native process tree", async () => {
    const runtime = createSystemRuntime();
    const child = runtime.spawn(
      [
        process.execPath,
        "-e",
        'const nested = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]); console.log(nested.pid); setInterval(() => {}, 1000)',
      ],
      environment(),
    );
    const reader = child.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    const descendantPid = Number(new TextDecoder().decode(first.value).trim());
    expect(descendantPid).toBeGreaterThan(0);
    try {
      await runtime.terminateTree(
        process.platform === "darwin" ? "macos" : "windows",
        child,
      );
      const exitCode = await Promise.race([
        child.exited,
        Bun.sleep(3_000).then(() => "timeout" as const),
      ]);
      expect(exitCode).not.toBe("timeout");
      for (let attempt = 0; attempt < 100 && processExists(descendantPid); attempt += 1) {
        await Bun.sleep(10);
      }
      expect(processExists(descendantPid)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
    }
  });
});

function environment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
