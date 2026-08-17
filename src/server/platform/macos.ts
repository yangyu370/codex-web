import path from "node:path";

import {
  type HostPlatform,
  PlatformError,
  type PlatformRuntime,
} from "./types";

export function createMacPlatform(runtime: PlatformRuntime): HostPlatform {
  return {
    kind: "macos",
    arch: runtime.arch,

    async resolveCodexExecutable(configuredPath) {
      const executable = configuredPath ?? (await runtime.resolveOnPath("codex"));
      if (!path.posix.isAbsolute(executable)) {
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
      if (!path.posix.isAbsolute(input)) {
        throw new PlatformError(
          "invalidWorkingDirectory",
          "macOS working directory must be absolute",
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
      return runtime.terminateTree("macos", child);
    },

    dataDirectory() {
      return path.posix.join(
        runtime.homedir,
        "Library",
        "Application Support",
        "codex-web",
      );
    },

    async diagnostics() {
      return { platform: "macos", arch: runtime.arch };
    },
  };
}
