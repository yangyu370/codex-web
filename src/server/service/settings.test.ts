import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SettingsStore } from "./settings";

describe("SettingsStore", () => {
  test("persists only bounded non-secret preferences with atomic replacement", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codex-web-settings-"));
    try {
      const store = new SettingsStore(directory);
      const paths = Array.from({ length: 30 }, (_, index) => `/work/${index}`);
      await store.save({
        recentDirectories: paths,
        model: "gpt-5.6",
        theme: "dark",
        commandOutput: "must not be persisted",
      } as never);

      expect(await store.read()).toEqual({
        recentDirectories: paths.slice(0, 20),
        model: "gpt-5.6",
        theme: "dark",
      });
      expect(await readFile(path.join(directory, "settings.json"), "utf8")).not.toContain(
        "must not be persisted",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("returns defaults for missing or malformed settings", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codex-web-settings-"));
    try {
      const store = new SettingsStore(directory);
      expect(await store.read()).toEqual({ recentDirectories: [] });
      await Bun.write(path.join(directory, "settings.json"), "not-json");
      expect(await store.read()).toEqual({ recentDirectories: [] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("drops oversized paths and does not read oversized settings files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codex-web-settings-"));
    try {
      const store = new SettingsStore(directory);
      await store.save({ recentDirectories: ["/ok", `/${"x".repeat(5_000)}`] });
      expect(await store.read()).toEqual({ recentDirectories: ["/ok"] });

      await Bun.write(path.join(directory, "settings.json"), "x".repeat(20_000));
      expect(await store.read()).toEqual({ recentDirectories: [] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
