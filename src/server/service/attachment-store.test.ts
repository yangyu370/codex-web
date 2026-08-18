import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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

describe("AttachmentStore files", () => {
  test("streams sanitized UTF-8 source into the opaque server session", async () => {
    const { project, dataDirectory, platform } = await fixture();
    const store = track(new AttachmentStore(platform, dataDirectory));
    const session = await store.create(project);

    const attachment = await store.addFile(
      session.id,
      "../../notes.ts",
      "application/octet-stream",
      byteStream([new TextEncoder().encode("export const ready = true;\n")]),
      0,
    );

    expect(attachment).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: "notes.ts",
      size: 27,
      kind: "text",
    });
    const files = await sessionFiles(project, session.id);
    expect(files).toHaveLength(1);
    expect(files[0]?.endsWith("-notes.ts")).toBe(true);
    expect(await readFile(path.join(project, ".codex-web", "attachments", session.id, files[0]!), "utf8"))
      .toBe("export const ready = true;\n");
  });

  test("classifies supported image and PDF signatures independently of browser MIME", async () => {
    const { project, dataDirectory, platform } = await fixture();
    const store = track(new AttachmentStore(platform, dataDirectory));
    const session = await store.create(project);
    const fixtures: Array<{ name: string; bytes: number[]; kind: "image" | "pdf" }> = [
      { name: "pixel.png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], kind: "image" },
      { name: "photo.jpg", bytes: [0xff, 0xd8, 0xff, 0xdb], kind: "image" },
      { name: "image.webp", bytes: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], kind: "image" },
      { name: "anim.gif", bytes: [...new TextEncoder().encode("GIF89a")], kind: "image" },
      { name: "requirements.pdf", bytes: [...new TextEncoder().encode("%PDF-1.7\n")], kind: "pdf" },
    ];

    const actual = [];
    for (const fixture of fixtures) {
      actual.push(await store.addFile(
        session.id,
        fixture.name,
        "text/plain",
        byteStream([new Uint8Array(fixture.bytes)]),
      ));
    }

    expect(actual.map(({ name, kind }) => ({ name, kind }))).toEqual(
      fixtures.map(({ name, kind }) => ({ name, kind })),
    );
  });

  test("rejects executable signatures and unrecognized binary content", async () => {
    const { project, dataDirectory, platform } = await fixture();
    const store = track(new AttachmentStore(platform, dataDirectory));
    const session = await store.create(project);
    const rejected = [
      [0x4d, 0x5a, 0x90, 0],
      [0x7f, 0x45, 0x4c, 0x46],
      [0xcf, 0xfa, 0xed, 0xfe],
      [0xff, 0xfe, 0xfd],
      [0x61, 0, 0x62],
    ];

    for (const [index, bytes] of rejected.entries()) {
      await expect(store.addFile(
        session.id,
        `unsafe-${index}.bin`,
        "application/octet-stream",
        byteStream([new Uint8Array(bytes)]),
      )).rejects.toMatchObject({ code: "invalidAttachment" });
    }
    expect(await sessionFiles(project, session.id)).toEqual([]);
  });

  test("enforces actual streamed bytes instead of declared content length", async () => {
    const { project, dataDirectory, platform } = await fixture();
    const store = track(new AttachmentStore(platform, dataDirectory, {
      limits: { files: 10, fileBytes: 4, totalBytes: 10 },
    }));
    const session = await store.create(project);

    await expect(store.addFile(
      session.id,
      "large.txt",
      "text/plain",
      byteStream([new TextEncoder().encode("12345")]),
      0,
    )).rejects.toMatchObject({ code: "attachmentTooLarge" });
    expect(await sessionFiles(project, session.id)).toEqual([]);
  });

  test("enforces file-count, session-byte, and host-byte capacity", async () => {
    const countFixture = await fixture();
    const countStore = track(new AttachmentStore(countFixture.platform, countFixture.dataDirectory, {
      limits: { files: 1, fileBytes: 10, totalBytes: 10 },
    }));
    const countSession = await countStore.create(countFixture.project);
    await countStore.addFile(countSession.id, "one.txt", "text/plain", byteStream([bytes("1")]));
    await expect(countStore.addFile(
      countSession.id,
      "two.txt",
      "text/plain",
      byteStream([bytes("2")]),
    )).rejects.toMatchObject({ code: "attachmentCapacity" });

    const totalFixture = await fixture();
    const totalStore = track(new AttachmentStore(totalFixture.platform, totalFixture.dataDirectory, {
      limits: { files: 10, fileBytes: 10, totalBytes: 5 },
    }));
    const totalSession = await totalStore.create(totalFixture.project);
    await totalStore.addFile(totalSession.id, "four.txt", "text/plain", byteStream([bytes("1234")]));
    await expect(totalStore.addFile(
      totalSession.id,
      "two.txt",
      "text/plain",
      byteStream([bytes("12")]),
    )).rejects.toMatchObject({ code: "attachmentCapacity" });

    const hostFixture = await fixture();
    const secondProject = await temporaryDirectory("codex-web-project-");
    const hostStore = track(new AttachmentStore(hostFixture.platform, hostFixture.dataDirectory, {
      maxHostBytes: 5,
    }));
    const first = await hostStore.create(hostFixture.project);
    const second = await hostStore.create(secondProject);
    await hostStore.addFile(first.id, "four.txt", "text/plain", byteStream([bytes("1234")]));
    await expect(hostStore.addFile(
      second.id,
      "two.txt",
      "text/plain",
      byteStream([bytes("12")]),
    )).rejects.toMatchObject({ code: "attachmentCapacity" });
  });

  test("removes a file, recovers capacity, and leaves no aborted temporary file", async () => {
    const { project, dataDirectory, platform } = await fixture();
    const store = track(new AttachmentStore(platform, dataDirectory, {
      limits: { files: 1, fileBytes: 10, totalBytes: 10 },
    }));
    const session = await store.create(project);
    const first = await store.addFile(
      session.id,
      "CON.txt",
      "text/plain",
      byteStream([bytes("first")]),
    );
    expect(first.name).toBe("_CON.txt");
    await store.removeFile(session.id, first.id);
    await store.addFile(session.id, "next.txt", "text/plain", byteStream([bytes("next")]));

    const failed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes("part"));
        controller.error(new Error("browser disconnected"));
      },
    });
    await store.removeFile(session.id, (await store.getSession(session.id)).attachments[0]!.id);
    await expect(store.addFile(session.id, "broken.txt", "text/plain", failed)).rejects.toThrow(
      "browser disconnected",
    );
    expect(await sessionFiles(project, session.id)).toEqual([]);
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

async function sessionFiles(project: string, sessionId: string): Promise<string[]> {
  return (await readdir(path.join(project, ".codex-web", "attachments", sessionId)))
    .sort();
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
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
