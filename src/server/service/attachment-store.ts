import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { AttachmentSessionSummary } from "../../shared/protocol";
import type { HostPlatform } from "../platform";

const DEFAULT_TTL_MS = 3_600_000;
const DEFAULT_SWEEP_INTERVAL_MS = 600_000;
const DEFAULT_MAX_SESSIONS = 100;
const MAX_REGISTRY_BYTES = 262_144;
const MAX_PATH_BYTES = 4_096;
const MARKER_NAME = ".codex-web-owner.json";
const REGISTRY_NAME = "attachment-sessions.json";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LIMITS = {
  files: 10,
  fileBytes: 20_971_520,
  totalBytes: 52_428_800,
} as const;

export class AttachmentError extends Error {
  constructor(
    public readonly code:
      | "invalidAttachment"
      | "attachmentTooLarge"
      | "attachmentCapacity"
      | "attachmentExpired",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

export interface AttachmentStoreOptions {
  now?: () => number;
  maxSessions?: number;
  ttlMs?: number;
  sweepIntervalMs?: number;
}

interface StoredSession {
  id: string;
  cwd: string;
  canonicalCwd: string;
  directory: string;
  attachmentsRoot: string;
  projectContainer: string;
  ownerNonce: string;
  createdProjectContainer: boolean;
  createdAt: number;
  expiresAt: number;
  state: "draft" | "starting" | "consumed";
  totalBytes: number;
}

interface OwnershipMarker {
  version: 1;
  nonce: string;
  createdProjectContainer: boolean;
}

export class AttachmentStore {
  readonly #platform: HostPlatform;
  readonly #dataDirectory: string;
  readonly #now: () => number;
  readonly #maxSessions: number;
  readonly #ttlMs: number;
  readonly #sessions = new Map<string, StoredSession>();
  readonly #timer: ReturnType<typeof setInterval>;
  #initialization?: Promise<void>;
  #closed = false;

  constructor(
    platform: HostPlatform,
    dataDirectory: string,
    options: AttachmentStoreOptions = {},
  ) {
    this.#platform = platform;
    this.#dataDirectory = dataDirectory;
    this.#now = options.now ?? Date.now;
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#timer = setInterval(
      () => void this.sweepExpired().catch(() => undefined),
      options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
    );
    this.#timer.unref?.();
  }

  async create(cwd: string): Promise<AttachmentSessionSummary> {
    this.#assertOpen();
    await this.#initialize();
    await this.sweepExpired();
    if (this.#sessions.size >= this.#maxSessions) {
      throw new AttachmentError("attachmentCapacity", "attachment session capacity reached");
    }

    const validated = await this.#platform.validateWorkingDirectory(cwd);
    const root = await this.#ensureAttachmentsRoot(validated.resolvedPath);
    const id = crypto.randomUUID();
    const directory = this.#path().join(root.attachmentsRoot, id);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch {
      throw new AttachmentError("invalidAttachment", "could not create attachment session");
    }
    const createdAt = this.#now();
    const session: StoredSession = {
      id,
      cwd: validated.displayPath,
      canonicalCwd: validated.resolvedPath,
      directory,
      attachmentsRoot: root.attachmentsRoot,
      projectContainer: root.projectContainer,
      ownerNonce: root.marker.nonce,
      createdProjectContainer: root.marker.createdProjectContainer,
      createdAt,
      expiresAt: createdAt + this.#ttlMs,
      state: "draft",
      totalBytes: 0,
    };
    this.#sessions.set(id, session);
    try {
      await this.#persist();
    } catch (error) {
      this.#sessions.delete(id);
      await rm(directory, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
    return this.#summary(session);
  }

  async cancel(sessionId: string): Promise<void> {
    this.#assertSessionId(sessionId);
    await this.#initialize();
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new AttachmentError("attachmentExpired", "attachment session is unavailable");
    }
    await this.#deleteSession(session);
  }

  async sweepExpired(): Promise<void> {
    if (this.#closed) return;
    await this.#initialize();
    const expired = [...this.#sessions.values()]
      .filter((session) => session.expiresAt <= this.#now())
      .slice(0, this.#maxSessions);
    for (const session of expired) {
      try {
        await this.#deleteSession(session);
      } catch {
        this.#sessions.delete(session.id);
        await this.#persist();
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    await this.#initialization;
  }

  async #initialize(): Promise<void> {
    this.#initialization ??= this.#loadRegistry();
    await this.#initialization;
  }

  async #loadRegistry(): Promise<void> {
    await mkdir(this.#dataDirectory, { mode: 0o700, recursive: true });
    const registryPath = this.#registryPath();
    let source: string;
    try {
      if ((await stat(registryPath)).size > MAX_REGISTRY_BYTES) return;
      source = await readFile(registryPath, "utf8");
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      return;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) return;
    for (const value of parsed.sessions.slice(0, this.#maxSessions)) {
      const session = parseStoredSession(value);
      if (session) this.#sessions.set(session.id, session);
    }
  }

  async #ensureAttachmentsRoot(canonicalCwd: string): Promise<{
    attachmentsRoot: string;
    projectContainer: string;
    marker: OwnershipMarker;
  }> {
    const projectContainer = this.#path().join(canonicalCwd, ".codex-web");
    const attachmentsRoot = this.#path().join(projectContainer, "attachments");
    const createdProjectContainer = await ensurePlainDirectory(projectContainer);
    const createdAttachmentsRoot = await ensurePlainDirectory(attachmentsRoot);
    const markerPath = this.#path().join(attachmentsRoot, MARKER_NAME);
    let marker = await readMarker(markerPath);
    if (!marker) {
      if (!createdAttachmentsRoot && (await readdir(attachmentsRoot)).length > 0) {
        throw new AttachmentError(
          "invalidAttachment",
          "pre-existing attachments directory is not owned by Codex Web",
        );
      }
      marker = {
        version: 1,
        nonce: crypto.randomUUID(),
        createdProjectContainer,
      };
      try {
        await writeFile(markerPath, JSON.stringify(marker), { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch {
        marker = await readMarker(markerPath);
        if (!marker) {
          throw new AttachmentError("invalidAttachment", "invalid attachment ownership marker");
        }
      }
    }
    return { attachmentsRoot, projectContainer, marker };
  }

  async #deleteSession(session: StoredSession): Promise<void> {
    await this.#validateSession(session);
    await rm(session.directory, { recursive: true });
    this.#sessions.delete(session.id);
    await this.#persist();
    await this.#removeEmptyOwnedParents(session);
  }

  async #validateSession(session: StoredSession): Promise<void> {
    this.#assertSessionId(session.id);
    const validated = await this.#platform.validateWorkingDirectory(session.cwd);
    if (!this.#equal(validated.resolvedPath, session.canonicalCwd)) {
      throw new AttachmentError("invalidAttachment", "attachment project changed");
    }
    const expectedRoot = this.#path().join(session.canonicalCwd, ".codex-web", "attachments");
    const expectedDirectory = this.#path().join(expectedRoot, session.id);
    if (
      !this.#equal(expectedRoot, session.attachmentsRoot) ||
      !this.#equal(expectedDirectory, session.directory) ||
      byteLength(session.directory) > MAX_PATH_BYTES
    ) {
      throw new AttachmentError("invalidAttachment", "attachment path is invalid");
    }
    const info = await lstat(session.directory).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw new AttachmentError("invalidAttachment", "attachment session is not a directory");
    }
    const canonicalDirectory = await realpath(session.directory).catch(() => undefined);
    if (!canonicalDirectory || !this.#equal(canonicalDirectory, expectedDirectory)) {
      throw new AttachmentError("invalidAttachment", "attachment session escaped its project");
    }
    const marker = await readMarker(this.#path().join(session.attachmentsRoot, MARKER_NAME));
    if (!marker || marker.nonce !== session.ownerNonce) {
      throw new AttachmentError("invalidAttachment", "attachment ownership marker changed");
    }
  }

  async #removeEmptyOwnedParents(session: StoredSession): Promise<void> {
    if (this.#sessionsForRoot(session.attachmentsRoot).length > 0) return;
    const markerPath = this.#path().join(session.attachmentsRoot, MARKER_NAME);
    const marker = await readMarker(markerPath);
    if (!marker || marker.nonce !== session.ownerNonce) return;
    const entries = await readdir(session.attachmentsRoot).catch(() => []);
    if (entries.length !== 1 || entries[0] !== MARKER_NAME) return;
    await unlink(markerPath).catch(() => undefined);
    await rmdir(session.attachmentsRoot).catch(() => undefined);
    if (marker.createdProjectContainer) {
      await rmdir(session.projectContainer).catch(() => undefined);
    }
  }

  #sessionsForRoot(root: string): StoredSession[] {
    return [...this.#sessions.values()].filter((session) => this.#equal(session.attachmentsRoot, root));
  }

  async #persist(): Promise<void> {
    const registryPath = this.#registryPath();
    const temporaryPath = `${registryPath}.${crypto.randomUUID()}.tmp`;
    const source = JSON.stringify({
      version: 1,
      sessions: [...this.#sessions.values()].slice(0, this.#maxSessions),
    });
    if (byteLength(source) > MAX_REGISTRY_BYTES) {
      throw new AttachmentError("attachmentCapacity", "attachment registry capacity reached");
    }
    await writeFile(temporaryPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await rename(temporaryPath, registryPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  #summary(session: StoredSession): AttachmentSessionSummary {
    return {
      id: session.id,
      expiresAt: Math.floor(session.expiresAt / 1_000),
      limits: { ...LIMITS },
    };
  }

  #registryPath(): string {
    return path.join(this.#dataDirectory, REGISTRY_NAME);
  }

  #path(): typeof path.posix | typeof path.win32 {
    return this.#platform.kind === "windows" ? path.win32 : path.posix;
  }

  #equal(left: string, right: string): boolean {
    return this.#platform.kind === "windows"
      ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
      : left === right;
  }

  #assertSessionId(value: string): void {
    if (!UUID_PATTERN.test(value)) {
      throw new AttachmentError("invalidAttachment", "attachment session id is invalid");
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new AttachmentError("attachmentExpired", "attachment store is closed");
    }
  }
}

async function ensurePlainDirectory(directory: string): Promise<boolean> {
  const info = await lstat(directory).catch(() => undefined);
  if (info) {
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new AttachmentError("invalidAttachment", "attachment path is not a plain directory");
    }
    return false;
  }
  try {
    await mkdir(directory, { mode: 0o700 });
    return true;
  } catch {
    const raced = await lstat(directory).catch(() => undefined);
    if (!raced?.isDirectory() || raced.isSymbolicLink()) {
      throw new AttachmentError("invalidAttachment", "could not create attachment directory");
    }
    return false;
  }
}

async function readMarker(markerPath: string): Promise<OwnershipMarker | undefined> {
  let source: string;
  try {
    const info = await lstat(markerPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_024) return undefined;
    source = await readFile(markerPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const value = JSON.parse(source) as unknown;
    if (
      isRecord(value) &&
      value.version === 1 &&
      typeof value.nonce === "string" &&
      UUID_PATTERN.test(value.nonce) &&
      typeof value.createdProjectContainer === "boolean"
    ) {
      return {
        version: 1,
        nonce: value.nonce,
        createdProjectContainer: value.createdProjectContainer,
      };
    }
  } catch {}
  return undefined;
}

function parseStoredSession(value: unknown): StoredSession | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    !boundedString(value.cwd) ||
    !boundedString(value.canonicalCwd) ||
    !boundedString(value.directory) ||
    !boundedString(value.attachmentsRoot) ||
    !boundedString(value.projectContainer) ||
    typeof value.ownerNonce !== "string" ||
    !UUID_PATTERN.test(value.ownerNonce) ||
    typeof value.createdProjectContainer !== "boolean" ||
    !safeTimestamp(value.createdAt) ||
    !safeTimestamp(value.expiresAt) ||
    (value.state !== "draft" && value.state !== "starting" && value.state !== "consumed") ||
    typeof value.totalBytes !== "number" ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes < 0
  ) {
    return undefined;
  }
  return {
    id: value.id,
    cwd: value.cwd,
    canonicalCwd: value.canonicalCwd,
    directory: value.directory,
    attachmentsRoot: value.attachmentsRoot,
    projectContainer: value.projectContainer,
    ownerNonce: value.ownerNonce,
    createdProjectContainer: value.createdProjectContainer,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    state: value.state,
    totalBytes: value.totalBytes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown): value is string {
  return typeof value === "string" && byteLength(value) <= MAX_PATH_BYTES;
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
