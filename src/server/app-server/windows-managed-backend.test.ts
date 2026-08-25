import { describe, expect, test } from "bun:test";

import type { HostPlatform } from "../platform";
import type { JsonRpcTransport } from "./json-rpc";
import {
  parseWindowsSharedPolicy,
  WindowsManagedBackend,
} from "./windows-managed-backend";
import {
  appServerVersionFromInitialize,
  codexVersionAtLeast,
} from "./windows-version";

describe("parseWindowsSharedPolicy", () => {
  test("defaults to auto and accepts the three supported policies", () => {
    expect(parseWindowsSharedPolicy(undefined)).toBe("auto");
    expect(parseWindowsSharedPolicy("auto")).toBe("auto");
    expect(parseWindowsSharedPolicy("required")).toBe("required");
    expect(parseWindowsSharedPolicy("off")).toBe("off");
  });

  test("rejects unknown policies", () => {
    expect(() => parseWindowsSharedPolicy("enabled")).toThrow("auto, required, or off");
  });
});

test("WindowsManagedBackend returns managed TCP connection metadata", async () => {
  const transport = memoryTransport();
  const backend = new WindowsManagedBackend(platform(), {
    env: {
      CODEX_HOME: "C:\\Users\\dev\\.codex",
      CODEX_WEB_APP_SERVER_URL: "ws://127.0.0.1:4600",
    },
    coordinatorFactory(options) {
      expect(options).toMatchObject({
        endpoint: "ws://127.0.0.1:4600",
        codexHome: "C:\\Users\\dev\\.codex",
        executable: "C:\\Tools\\codex.exe",
        cliVersion: "codex-cli 0.150.0",
      });
      return {
        ensure: async () => ({
          endpoint: options.endpoint,
          cliVersion: options.cliVersion,
          appServerVersion: "codex-cli 0.149.1",
          restartRequired: true,
          hostPid: 101,
          nativePid: 102,
        }),
      };
    },
    connect: async () => transport,
  });

  await expect(backend.ensureAndConnect({
    executable: "C:\\Tools\\codex.exe",
    cliVersion: "codex-cli 0.150.0",
    env: {},
  })).resolves.toEqual({
    info: {
      backend: "managedTcp",
      endpoint: { kind: "tcp", url: "ws://127.0.0.1:4600" },
      cliVersion: "codex-cli 0.150.0",
      appServerVersion: "codex-cli 0.149.1",
      restartRequired: true,
    },
    transport,
  });
});

test("Windows shared mode enforces the first compatible Codex version", async () => {
  expect(codexVersionAtLeast("codex-cli 0.149.1", "0.149.1")).toBeTrue();
  expect(codexVersionAtLeast("codex-cli 0.149.0", "0.149.1")).toBeFalse();
  expect(appServerVersionFromInitialize({
    userAgent: "codex-web-lifecycle/0.150.2 (Windows 11; x86_64) codex_cli_rs/0.150.2",
  })).toBe("codex-cli 0.150.2");

  const backend = new WindowsManagedBackend(platform(), {
    env: {},
    coordinatorFactory: () => ({ ensure: async () => { throw new Error("must not start"); } }),
  });
  await expect(backend.ensureAndConnect({
    executable: "C:\\Tools\\codex.exe",
    cliVersion: "codex-cli 0.149.0",
    env: {},
  })).rejects.toThrow("0.149.1 or newer");
});

function platform(): HostPlatform {
  return {
    kind: "windows",
    arch: "x64",
    resolveCodexExecutable: async () => "C:\\Tools\\codex.exe",
    validateWorkingDirectory: async (input) => ({ displayPath: input, resolvedPath: input }),
    spawnAppServer: () => { throw new Error("not used"); },
    spawnCommand: () => { throw new Error("not used"); },
    terminateProcessTree: async () => undefined,
    homeDirectory: () => "C:\\Users\\dev",
    dataDirectory: () => "C:\\Data\\Codex Web",
    diagnostics: async () => ({ platform: "windows", arch: "x64" }),
  };
}

function memoryTransport(): JsonRpcTransport {
  return {
    send() {},
    close() {},
    onMessage() { return () => undefined; },
    onClose() { return () => undefined; },
  };
}
