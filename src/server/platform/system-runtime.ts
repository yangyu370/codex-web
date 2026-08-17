import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import os from "node:os";

import type { AppServerProcess, PlatformRuntime } from "./types";

export function createSystemRuntime(): PlatformRuntime {
  return {
    arch: process.arch,
    env: process.env,
    homedir: os.homedir(),
    async access(path) {
      await access(path, constants.R_OK | constants.X_OK);
    },
    async isDirectory(path) {
      return (await stat(path)).isDirectory();
    },
    realpath,
    async resolveOnPath(name) {
      const resolved = Bun.which(name);
      if (!resolved) throw new Error(`codexUnavailable: ${name} was not found on PATH`);
      return resolved;
    },
    spawn(command, env) {
      return Bun.spawn(command, {
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }) as unknown as AppServerProcess;
    },
    async terminateTree(kind, child) {
      if (kind === "windows") {
        const taskkill = Bun.spawn(
          ["taskkill.exe", "/PID", String(child.pid), "/T", "/F"],
          { stdout: "ignore", stderr: "ignore" },
        );
        await taskkill.exited;
        return;
      }
      const descendants = await macDescendants(child.pid);
      for (const pid of descendants.reverse()) {
        safeKill(pid, "SIGTERM");
      }
      safeChildKill(child, "SIGTERM");
      await Bun.sleep(100);
      for (const pid of descendants) {
        safeKill(pid, "SIGKILL");
      }
      safeChildKill(child, "SIGKILL");
    },
  };
}

async function macDescendants(parentPid: number): Promise<number[]> {
  const result: number[] = [];
  const queue = [parentPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined) break;
    const process = Bun.spawn(["/usr/bin/pgrep", "-P", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [output, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      process.exited,
    ]);
    if (exitCode !== 0) continue;
    for (const line of output.split("\n")) {
      const childPid = Number(line.trim());
      if (Number.isSafeInteger(childPid) && childPid > 0) {
        result.push(childPid);
        queue.push(childPid);
      }
    }
  }
  return result;
}

function safeKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {}
}

function safeChildKill(child: AppServerProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {}
}
