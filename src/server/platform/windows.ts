import path from "node:path";

import {
  type HostPlatform,
  PlatformError,
  type PlatformRuntime,
} from "./types";

export function createWindowsPlatform(runtime: PlatformRuntime): HostPlatform {
  return {
    kind: "windows",
    arch: runtime.arch,

    async resolveCodexExecutable(configuredPath) {
      const executable = configuredPath ?? (await runtime.resolveOnPath("codex.exe"));
      if (!isFullyQualifiedWindowsPath(executable)) {
        throw new PlatformError("codexUnavailable", "Codex executable must be absolute");
      }
      try {
        await runtime.access(executable);
      } catch {
        throw new PlatformError("codexUnavailable", `cannot access ${executable}`);
      }
      return runtime.realpath(executable);
    },

    async validateWorkingDirectory(input) {
      if (!isFullyQualifiedWindowsPath(input)) {
        throw new PlatformError(
          "invalidWorkingDirectory",
          "Windows working directory must be drive-letter or UNC absolute",
        );
      }
      try {
        await runtime.access(input);
        if (!(await runtime.isDirectory(input))) {
          throw new Error("not a directory");
        }
        return { displayPath: input, resolvedPath: await runtime.realpath(input) };
      } catch {
        throw new PlatformError(
          "invalidWorkingDirectory",
          `cannot access directory ${input}`,
        );
      }
    },

    spawnAppServer(executable, env) {
      return runtime.spawn([executable, "app-server", "--stdio"], env);
    },

    terminateProcessTree(child) {
      return runtime.terminateTree("windows", child);
    },

    dataDirectory() {
      const localAppData = runtime.env.LOCALAPPDATA;
      if (!localAppData) {
        throw new PlatformError("codexUnavailable", "LOCALAPPDATA is not configured");
      }
      return path.win32.join(localAppData, "Codex Web");
    },

    async diagnostics() {
      return { platform: "windows", arch: runtime.arch };
    },
  };
}

function isFullyQualifiedWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}
