import { describe, expect, test } from "bun:test";

import {
  createMacPlatform,
  createWindowsPlatform,
  selectHostPlatform,
  type AppServerProcess,
  type PlatformRuntime,
} from "./index";

const fakeProcess: AppServerProcess = {
  pid: 42,
  stdin: {
    write: () => 0,
    end: () => undefined,
  },
  stdout: new ReadableStream(),
  stderr: new ReadableStream(),
  exited: Promise.resolve(0),
  kill: () => undefined,
};

function runtime(overrides: Partial<PlatformRuntime> = {}): PlatformRuntime {
  return {
    arch: "arm64",
    env: {},
    homedir: "/Users/tester",
    access: async () => undefined,
    isDirectory: async () => true,
    realpath: async (value) => value,
    resolveOnPath: async (name) => `/bin/${name}`,
    spawn: () => fakeProcess,
    terminateTree: async () => undefined,
    ...overrides,
  };
}

describe("selectHostPlatform", () => {
  test("selects the native host implementation", () => {
    expect(selectHostPlatform("darwin", runtime()).kind).toBe("macos");
    expect(
      selectHostPlatform(
        "win32",
        runtime({ homedir: "C:\\Users\\tester" }),
      ).kind,
    ).toBe("windows");
  });

  test("rejects unsupported hosts before launching Codex", () => {
    expect(() => selectHostPlatform("linux", runtime())).toThrow(
      "unsupportedPlatform: linux",
    );
  });
});

describe("working-directory validation", () => {
  test("macOS rejects relative paths without touching the filesystem", async () => {
    let accessCount = 0;
    const platform = createMacPlatform(
      runtime({
        access: async () => {
          accessCount += 1;
        },
      }),
    );

    await expect(platform.validateWorkingDirectory("src")).rejects.toMatchObject({
      code: "invalidWorkingDirectory",
    });
    expect(accessCount).toBe(0);
  });

  test("Windows accepts drive-letter and UNC paths", async () => {
    const platform = createWindowsPlatform(
      runtime({ homedir: "C:\\Users\\tester" }),
    );

    await expect(platform.validateWorkingDirectory("C:\\work\\codex")).resolves.toEqual({
      displayPath: "C:\\work\\codex",
      resolvedPath: "C:\\work\\codex",
    });
    await expect(
      platform.validateWorkingDirectory("\\\\server\\share\\codex"),
    ).resolves.toEqual({
      displayPath: "\\\\server\\share\\codex",
      resolvedPath: "\\\\server\\share\\codex",
    });
  });

  test("rejects a path that is not a directory", async () => {
    const platform = createMacPlatform(runtime({ isDirectory: async () => false }));
    await expect(platform.validateWorkingDirectory("/tmp/file.txt")).rejects.toMatchObject({
      code: "invalidWorkingDirectory",
    });
  });
});

describe("Codex discovery and data directories", () => {
  test("prefers a validated configured executable", async () => {
    const platform = createMacPlatform(runtime());
    await expect(platform.resolveCodexExecutable("/opt/codex/bin/codex")).resolves.toBe(
      "/opt/codex/bin/codex",
    );
  });

  test("uses native default data directories", () => {
    expect(createMacPlatform(runtime()).dataDirectory()).toBe(
      "/Users/tester/Library/Application Support/codex-web",
    );
    expect(
      createWindowsPlatform(
        runtime({
          env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
          homedir: "C:\\Users\\tester",
        }),
      ).dataDirectory(),
    ).toBe("C:\\Users\\tester\\AppData\\Local\\Codex Web");
  });
});

describe("app-server process boundary", () => {
  test("launches the resolved executable with stdio app-server arguments", () => {
    let captured:
      | { command: string[]; env: Record<string, string> }
      | undefined;
    const platform = createMacPlatform(
      runtime({
        spawn: (command, env) => {
          captured = { command, env };
          return fakeProcess;
        },
      }),
    );

    expect(platform.spawnAppServer("/opt/codex/bin/codex", { CODEX_HOME: "/tmp/codex" })).toBe(
      fakeProcess,
    );
    expect(captured).toEqual({
      command: ["/opt/codex/bin/codex", "app-server", "--stdio"],
      env: { CODEX_HOME: "/tmp/codex" },
    });
  });

  test("delegates forced cleanup with the selected host kind", async () => {
    let captured: { kind: "macos" | "windows"; pid: number } | undefined;
    const platform = createWindowsPlatform(
      runtime({
        homedir: "C:\\Users\\tester",
        terminateTree: async (kind, child) => {
          captured = { kind, pid: child.pid };
        },
      }),
    );

    await platform.terminateProcessTree(fakeProcess);
    expect(captured).toEqual({ kind: "windows", pid: 42 });
  });
});
