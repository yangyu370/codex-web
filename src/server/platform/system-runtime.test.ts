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
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      environment(),
    );
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
    } finally {
      child.kill("SIGKILL");
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
