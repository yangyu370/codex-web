import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMacPlatform, type AppServerProcess, type PlatformRuntime } from "../platform";
import { DirectoryService } from "./directories";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

describe("DirectoryService", () => {
  test("lists only child directories from the server user's home", async () => {
    const home = await temporaryDirectory();
    await Promise.all([
      mkdir(path.join(home, "zeta")),
      mkdir(path.join(home, "alpha")),
      writeFile(path.join(home, "notes.txt"), "not a directory"),
    ]);
    const service = new DirectoryService(createPlatform(home));

    expect(await service.list()).toEqual({
      current: { name: path.basename(home), path: home },
      directories: [
        { name: "alpha", path: path.join(home, "alpha") },
        { name: "zeta", path: path.join(home, "zeta") },
      ],
      roots: [{ name: "Home", path: home }],
      truncated: false,
    });
  });

  test("supports configured server roots and parent navigation within a root", async () => {
    const home = await temporaryDirectory();
    const projects = await temporaryDirectory();
    const nested = path.join(projects, "team", "app");
    await mkdir(nested, { recursive: true });
    const service = new DirectoryService(createPlatform(home), [projects]);

    expect(await service.list(nested)).toMatchObject({
      current: { name: "app", path: nested },
      parent: path.join(projects, "team"),
      roots: [
        { name: "Home", path: home },
        { name: path.basename(projects), path: projects },
      ],
    });
    expect(await service.list(projects)).not.toHaveProperty("parent");
  });

  test("rejects lexical and symlink escapes from every allowed root", async () => {
    const home = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const escape = path.join(home, "escape");
    await symlink(outside, escape);
    const service = new DirectoryService(createPlatform(home));

    await expect(service.list(outside)).rejects.toMatchObject({
      code: "invalidWorkingDirectory",
    });
    await expect(service.list(escape)).rejects.toMatchObject({
      code: "invalidWorkingDirectory",
    });
  });

  test("caps large server directories and discloses truncation", async () => {
    const home = await temporaryDirectory();
    await Promise.all(Array.from({ length: 201 }, (_, index) =>
      mkdir(path.join(home, `project-${String(index).padStart(3, "0")}`))));
    const service = new DirectoryService(createPlatform(home));

    const listing = await service.list();

    expect(listing.directories).toHaveLength(200);
    expect(listing.directories[0]).toEqual({
      name: "project-000",
      path: path.join(home, "project-000"),
    });
    expect(listing.truncated).toBe(true);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-web-directories-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createPlatform(home: string) {
  const unusedProcess = undefined as unknown as AppServerProcess;
  const runtime: PlatformRuntime = {
    arch: "arm64",
    env: {},
    homedir: home,
    access,
    isDirectory: async (value) => (await stat(value)).isDirectory(),
    realpath,
    resolveOnPath: async () => "/opt/codex/bin/codex",
    spawn: () => unusedProcess,
    terminateTree: async () => undefined,
  };
  return createMacPlatform(runtime);
}
