import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMacPlatform, type AppServerProcess, type PlatformRuntime } from "../platform";
import { AttachmentStore } from "./attachment-store";

const stores: AttachmentStore[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

describe("AttachmentStore sessions", () => {
  test("creates an opaque draft under the validated server project", async () => {
    const { project, dataDirectory, platform } = await fixture();
    const store = track(new AttachmentStore(platform, dataDirectory, {
      now: () => 1_700_000_000_000,
    }));

    const session = await store.create(project);

    expect(session).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expiresAt: 1_700_003_600,
      limits: {
        files: 10,
        fileBytes: 20_971_520,
        totalBytes: 52_428_800,
      },
    });
    expect((await lstat(path.join(
      project,
      ".codex-web",
      "attachments",
      session.id,
    ))).isDirectory()).toBe(true);
  });

  test("rejects new drafts after the configured host session cap", async () => {
    const { project, dataDirectory, platform } = await fixture();
    const otherProject = await temporaryDirectory("codex-web-project-");
    const store = track(new AttachmentStore(platform, dataDirectory, { maxSessions: 1 }));
    await store.create(project);

    await expect(store.create(otherProject)).rejects.toMatchObject({
      code: "attachmentCapacity",
    });
  });

  test("refuses a symlinked project container before creating a session", async () => {
    const { project, outside, dataDirectory, platform } = await fixture();
    await symlink(outside, path.join(project, ".codex-web"));
    const store = track(new AttachmentStore(platform, dataDirectory));

    await expect(store.create(project)).rejects.toMatchObject({
      code: "invalidAttachment",
    });
    expect(await directoryEntries(outside)).toEqual([]);
  });

  test("removes owned empty parents but preserves a user's project container", async () => {
    const owned = await fixture();
    const ownedStore = track(new AttachmentStore(owned.platform, owned.dataDirectory));
    const ownedSession = await ownedStore.create(owned.project);
    await ownedStore.cancel(ownedSession.id);
    await expect(access(path.join(owned.project, ".codex-web"))).rejects.toBeDefined();

    const existing = await fixture();
    await mkdir(path.join(existing.project, ".codex-web"));
    await writeFile(path.join(existing.project, ".codex-web", "user.txt"), "keep me");
    const existingStore = track(new AttachmentStore(existing.platform, existing.dataDirectory));
    const existingSession = await existingStore.create(existing.project);
    await existingStore.cancel(existingSession.id);

    expect(await Bun.file(path.join(existing.project, ".codex-web", "user.txt")).text())
      .toBe("keep me");
  });

  test("expires a persisted draft after a service restart", async () => {
    const { project, dataDirectory, platform } = await fixture();
    let now = 1_700_000_000_000;
    const first = track(new AttachmentStore(platform, dataDirectory, { now: () => now }));
    const session = await first.create(project);
    await first.close();
    stores.splice(stores.indexOf(first), 1);

    now += 3_600_001;
    const restarted = track(new AttachmentStore(platform, dataDirectory, { now: () => now }));
    await restarted.sweepExpired();

    await expect(access(path.join(
      project,
      ".codex-web",
      "attachments",
      session.id,
    ))).rejects.toBeDefined();
  });

  test("does not follow a session directory replaced by a symlink", async () => {
    const { project, outside, dataDirectory, platform } = await fixture();
    const store = track(new AttachmentStore(platform, dataDirectory));
    const session = await store.create(project);
    const sessionDirectory = path.join(project, ".codex-web", "attachments", session.id);
    await rm(sessionDirectory, { recursive: true });
    await symlink(outside, sessionDirectory);
    await writeFile(path.join(outside, "valuable.txt"), "keep me");

    await expect(store.cancel(session.id)).rejects.toMatchObject({
      code: "invalidAttachment",
    });
    expect(await Bun.file(path.join(outside, "valuable.txt")).text()).toBe("keep me");
  });
});

function track(store: AttachmentStore): AttachmentStore {
  stores.push(store);
  return store;
}

async function fixture() {
  const project = await temporaryDirectory("codex-web-project-");
  const outside = await temporaryDirectory("codex-web-outside-");
  const dataDirectory = await temporaryDirectory("codex-web-data-");
  return { project, outside, dataDirectory, platform: createPlatform(project) };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function directoryEntries(directory: string): Promise<string[]> {
  const glob = new Bun.Glob("*");
  return Array.fromAsync(glob.scan({ cwd: directory, onlyFiles: false }));
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
