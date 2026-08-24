import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createWindowsCoordinatorFileStore,
  windowsCoordinatorInstanceKey,
} from "./windows-coordinator-runtime";
import type { WindowsSharedMetadata } from "./windows-shared-coordinator";

describe("Windows coordinator file store", () => {
  test("namespaces lifecycle files by canonical Codex home", () => {
    expect(windowsCoordinatorInstanceKey("C:\\Users\\dev\\.codex"))
      .not.toBe(windowsCoordinatorInstanceKey("C:\\Users\\dev\\other"));
    expect(windowsCoordinatorInstanceKey("C:\\Users\\dev\\.codex")).toHaveLength(32);
  });

  test("atomically persists strict metadata and rejects malformed state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-web-runtime-"));
    try {
      const store = createWindowsCoordinatorFileStore(root, "C:\\Users\\dev\\.codex");
      const value = metadata();
      await store.writeMetadata(value);
      expect(await store.readMetadata()).toEqual(value);

      await writeFile(store.paths.metadata, "{bad-json", "utf8");
      await expect(store.readMetadata()).rejects.toThrow("malformed lifecycle metadata");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("serializes concurrent startup operations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-web-lock-"));
    try {
      const store = createWindowsCoordinatorFileStore(root, "C:\\Users\\dev\\.codex");
      const completed: string[] = [];
      let active = 0;
      let maximumActive = 0;
      const operation = (name: string) => store.withStartupLock(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Bun.sleep(10);
        completed.push(name);
        active -= 1;
      });
      await Promise.all([
        operation("first"),
        operation("second"),
      ]);
      expect(maximumActive).toBe(1);
      expect([...completed].sort()).toEqual(["first", "second"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recovers an old empty lock left between creation and identity write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-web-stale-lock-"));
    try {
      const store = createWindowsCoordinatorFileStore(root, "C:\\Users\\dev\\.codex");
      await mkdir(store.paths.directory, { recursive: true });
      await writeFile(store.paths.lock, "", "utf8");
      const old = new Date(Date.now() - 20_000);
      await utimes(store.paths.lock, old, old);

      await expect(store.withStartupLock(async () => "recovered")).resolves.toBe("recovered");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function metadata(): WindowsSharedMetadata {
  return {
    schemaVersion: 1,
    endpoint: "ws://127.0.0.1:4500",
    codexHome: "C:\\Users\\dev\\.codex",
    executable: "C:\\Tools\\codex.exe",
    cliVersion: "0.149.1",
    appServerVersion: "0.149.1",
    generation: "generation-1",
    startedAt: 1_777_000_000_000,
    hostPid: 101,
    nativePid: 102,
    hostIdentity: identity(101, 1, "C:\\Tools\\bun.exe"),
    nativeIdentity: identity(102, 101, "C:\\Tools\\codex.exe"),
  };
}

function identity(pid: number, parentPid: number, executablePath: string) {
  return {
    pid,
    parentPid,
    creationDate: `20260825-${pid}`,
    executablePath,
    commandLine: `${executablePath} process ${pid}`,
  };
}
