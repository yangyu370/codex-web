import { describe, expect, test } from "bun:test";

import type { HostPlatform } from "../platform";
import {
  selectSharedAppServerBackend,
  type SharedAppServerBackend,
} from "./shared-backend";

function platform(kind: HostPlatform["kind"]): HostPlatform {
  return {
    kind,
    arch: "x64",
    resolveCodexExecutable: async () => kind === "windows" ? "C:\\codex.exe" : "/opt/codex",
    validateWorkingDirectory: async (input) => ({ displayPath: input, resolvedPath: input }),
    spawnAppServer: () => { throw new Error("not used"); },
    spawnCommand: () => { throw new Error("not used"); },
    terminateProcessTree: async () => undefined,
    homeDirectory: () => kind === "windows" ? "C:\\Users\\dev" : "/Users/dev",
    dataDirectory: () => kind === "windows" ? "C:\\Data\\Codex Web" : "/tmp/codex-web",
    diagnostics: async () => ({ platform: kind, arch: "x64" }),
  };
}

describe("selectSharedAppServerBackend", () => {
  test("keeps macOS on the native daemon backend", () => {
    const backend = selectSharedAppServerBackend(platform("macos"), {
      env: { CODEX_HOME: "/Users/dev/.codex" },
    });

    expect(backend?.kind).toBe("nativeDaemon");
  });

  test("does not select a Windows backend when shared mode is off", () => {
    const unexpected: SharedAppServerBackend = {
      kind: "managedTcp",
      async ensureAndConnect() {
        throw new Error("must not connect");
      },
    };

    expect(selectSharedAppServerBackend(platform("windows"), {
      env: {},
      windowsPolicy: "off",
      windowsBackend: unexpected,
    })).toBeUndefined();
  });

  test("selects the managed TCP backend for Windows auto mode", () => {
    expect(selectSharedAppServerBackend(platform("windows"), {
      env: {},
      windowsPolicy: "auto",
    })?.kind).toBe("managedTcp");
  });
});
