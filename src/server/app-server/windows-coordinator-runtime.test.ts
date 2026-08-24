import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
      const order: string[] = [];
      await Promise.all([
        store.withStartupLock(async () => {
          order.push("first-start");
          await Bun.sleep(10);
          order.push("first-end");
        }),
        store.withStartupLock(async () => { order.push("second"); }),
      ]);
      expect(order).toEqual(["first-start", "first-end", "second"]);
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
  };
}
