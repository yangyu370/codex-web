import {
  lstat,
  mkdir,
  open,
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

import type {
  AttachmentLimits,
  AttachmentSessionSummary,
  AttachmentSummary,
} from "../../shared/protocol";
import type { HostPlatform } from "../platform";
import { AttachmentError } from "./attachment-error";
import { classifyAttachment, sanitizeAttachmentName } from "./attachment-files";
import type { PreparedAttachmentSession } from "./turn-coordinator";
import {
  parseStoredSession,
  type StoredAttachment,
  type StoredAttachmentSession as StoredSession,
} from "./attachment-registry";

export { AttachmentError } from "./attachment-error";

const DEFAULT_TTL_MS = 3_600_000;
const DEFAULT_SWEEP_INTERVAL_MS = 600_000;
const DEFAULT_MAX_SESSIONS = 100;
const MAX_REGISTRY_BYTES = 1_048_576;
const DEFAULT_MAX_HOST_BYTES = 524_288_000;
const MAX_TERMINAL_TURNS = 256;
const TERMINAL_TURN_TTL_MS = 3_600_000;
const MAX_PATH_BYTES = 4_096;
const MARKER_NAME = ".codex-web-owner.json";
const REGISTRY_NAME = "attachment-sessions.json";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LIMITS = {
  files: 10,
  fileBytes: 20_971_520,
  totalBytes: 52_428_800,
} as const;

export interface AttachmentStoreOptions {
  now?: () => number;
  maxSessions?: number;
  ttlMs?: number;
  sweepIntervalMs?: number;
  limits?: AttachmentLimits;
  maxHostBytes?: number;
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
  readonly #limits: AttachmentLimits;
  readonly #maxHostBytes: number;
  readonly #sessions = new Map<string, StoredSession>();
  readonly #terminalTurns = new Map<string, number>();
  readonly #timer: ReturnType<typeof setInterval>;
  #initialization?: Promise<void>;
  #mutationTail: Promise<void> = Promise.resolve();
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
    this.#limits = options.limits ? { ...options.limits } : { ...LIMITS };
    this.#maxHostBytes = options.maxHostBytes ?? DEFAULT_MAX_HOST_BYTES;
    this.#timer = setInterval(
      () => void this.sweepExpired().catch(() => undefined),
      options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
    );
    this.#timer.unref?.();
  }

  async create(cwd: string): Promise<AttachmentSessionSummary> {
    this.#assertOpen();
    await this.#initialize();
    return this.#withMutationLock(async () => {
      await this.#sweepExpiredUnlocked();
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
        files: [],
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
    });
  }

  async cancel(sessionId: string): Promise<void> {
    this.#assertSessionId(sessionId);
    await this.#initialize();
    await this.#withMutationLock(async () => {
      const session = this.#requireSession(sessionId);
      await this.#deleteSession(session);
    });
  }

  async getSession(
    sessionId: string,
  ): Promise<AttachmentSessionSummary & { attachments: AttachmentSummary[] }> {
    this.#assertSessionId(sessionId);
    await this.#initialize();
    const session = this.#requireSession(sessionId);
    return {
      ...this.#summary(session),
      attachments: session.files.map(({ id, name, size, kind }) => ({ id, name, size, kind })),
    };
  }

  async addFile(
    sessionId: string,
    name: string,
    mediaType: string,
    body: ReadableStream<Uint8Array>,
    declaredLength?: number,
  ): Promise<AttachmentSummary> {
    this.#assertSessionId(sessionId);
    this.#assertOpen();
    await this.#initialize();
    return this.#withMutationLock(async () => {
      const session = this.#requireDraftSession(sessionId);
      await this.#validateSession(session);
      if (session.files.length >= this.#limits.files) {
        throw new AttachmentError("attachmentCapacity", "attachment file capacity reached");
      }
      if (
        declaredLength !== undefined &&
        (!Number.isSafeInteger(declaredLength) || declaredLength < 0)
      ) {
        throw new AttachmentError("invalidAttachment", "attachment length is invalid");
      }
      if (declaredLength !== undefined && declaredLength > this.#limits.fileBytes) {
        throw new AttachmentError("attachmentTooLarge", "attachment exceeds the per-file limit");
      }
      if (
        declaredLength !== undefined &&
        (session.totalBytes + declaredLength > this.#limits.totalBytes ||
          this.#hostBytes() + declaredLength > this.#maxHostBytes)
      ) {
        throw new AttachmentError("attachmentCapacity", "attachment byte capacity reached");
      }

      void mediaType;
      const id = crypto.randomUUID();
      const safeName = sanitizeAttachmentName(name);
      const storedName = `${id}-${safeName}`;
      const temporaryPath = this.#path().join(session.directory, `${id}.uploading`);
      const finalPath = this.#path().join(session.directory, storedName);
      const reader = body.getReader();
      const prefixChunks: Uint8Array[] = [];
      let prefixBytes = 0;
      let size = 0;
      const hostBytes = this.#hostBytes();
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporaryPath, "wx", 0o600);
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          if (!(result.value instanceof Uint8Array)) {
            throw new AttachmentError("invalidAttachment", "attachment stream is invalid");
          }
          size += result.value.byteLength;
          if (size > this.#limits.fileBytes) {
            throw new AttachmentError("attachmentTooLarge", "attachment exceeds the per-file limit");
          }
          if (
            session.totalBytes + size > this.#limits.totalBytes ||
            hostBytes + size > this.#maxHostBytes
          ) {
            throw new AttachmentError("attachmentCapacity", "attachment byte capacity reached");
          }
          if (prefixBytes < 16) {
            const prefix = result.value.subarray(0, Math.min(result.value.byteLength, 16 - prefixBytes));
            prefixChunks.push(prefix.slice());
            prefixBytes += prefix.byteLength;
          }
          await writeAll(handle, result.value);
        }
        await handle.close();
        handle = undefined;
        const kind = await classifyAttachment(temporaryPath, joinBytes(prefixChunks, prefixBytes));
        await rename(temporaryPath, finalPath);
        const attachment: StoredAttachment = { id, name: safeName, storedName, size, kind };
        session.files.push(attachment);
        session.totalBytes += size;
        try {
          await this.#persist();
        } catch (error) {
          session.files.pop();
          session.totalBytes -= size;
          await unlink(finalPath).catch(() => undefined);
          throw error;
        }
        return { id, name: safeName, size, kind };
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        if (handle) await handle.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
    });
  }

  async removeFile(sessionId: string, attachmentId: string): Promise<void> {
    this.#assertSessionId(sessionId);
    this.#assertSessionId(attachmentId);
    await this.#initialize();
    await this.#withMutationLock(async () => {
      const session = this.#requireDraftSession(sessionId);
      await this.#validateSession(session);
      const index = session.files.findIndex((file) => file.id === attachmentId);
      if (index < 0) {
        throw new AttachmentError("invalidAttachment", "attachment is unavailable");
      }
      const attachment = session.files[index]!;
      const filePath = this.#path().join(session.directory, attachment.storedName);
      const deletingPath = `${filePath}.deleting`;
      const info = await lstat(filePath).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink()) {
        throw new AttachmentError("invalidAttachment", "attachment file is invalid");
      }
      await rename(filePath, deletingPath);
      session.files.splice(index, 1);
      session.totalBytes -= attachment.size;
      try {
        await this.#persist();
      } catch (error) {
        session.files.splice(index, 0, attachment);
        session.totalBytes += attachment.size;
        await rename(deletingPath, filePath).catch(() => undefined);
        throw error;
      }
      await unlink(deletingPath).catch(() => undefined);
    });
  }

  async prepareForTurn(sessionId: string, cwd: string): Promise<PreparedAttachmentSession> {
    this.#assertSessionId(sessionId);
    await this.#initialize();
    return this.#withMutationLock(async () => {
      const session = this.#requireDraftSession(sessionId);
      await this.#validateSession(session);
      const validatedCwd = await this.#platform.validateWorkingDirectory(cwd);
      if (!this.#equal(validatedCwd.resolvedPath, session.canonicalCwd)) {
        throw new AttachmentError("invalidAttachment", "attachment project does not match thread");
      }
      if (session.files.length === 0) {
        throw new AttachmentError("invalidAttachment", "attachment session is empty");
      }
      if (session.files.length > this.#limits.files || session.totalBytes > this.#limits.totalBytes) {
        throw new AttachmentError("attachmentCapacity", "attachment session exceeds its limits");
      }
      const attachments = [];
      let totalBytes = 0;
      for (const attachment of session.files) {
        const filePath = this.#path().join(session.directory, attachment.storedName);
        const info = await lstat(filePath).catch(() => undefined);
        const canonicalFile = await realpath(filePath).catch(() => undefined);
        if (
          !info?.isFile() ||
          info.isSymbolicLink() ||
          info.size !== attachment.size ||
          !canonicalFile ||
          !this.#equal(canonicalFile, filePath)
        ) {
          throw new AttachmentError("invalidAttachment", "attachment file changed");
        }
        totalBytes += info.size;
        attachments.push({
          name: attachment.name,
          size: attachment.size,
          kind: attachment.kind,
          path: filePath,
        });
      }
      if (totalBytes !== session.totalBytes) {
        throw new AttachmentError("invalidAttachment", "attachment byte total changed");
      }
      session.state = "starting";
      try {
        await this.#persist();
      } catch (error) {
        session.state = "draft";
        throw error;
      }
      return { sessionId, attachments };
    });
  }

  async releaseTurn(sessionId: string): Promise<void> {
    this.#assertSessionId(sessionId);
    await this.#initialize();
    await this.#withMutationLock(async () => {
      const session = this.#requireSession(sessionId);
      if (session.state === "draft") return;
      if (session.state !== "starting") {
        throw new AttachmentError("attachmentExpired", "attachment session is already consumed");
      }
      session.state = "draft";
      await this.#persist();
    });
  }

  async bindTurn(sessionId: string, threadId: string, turnId: string): Promise<void> {
    this.#assertSessionId(sessionId);
    if (!threadId || !turnId || byteLength(threadId) > 512 || byteLength(turnId) > 512) {
      throw new AttachmentError("invalidAttachment", "turn binding is invalid");
    }
    await this.#initialize();
    await this.#withMutationLock(async () => {
      const session = this.#requireSession(sessionId);
      if (session.state !== "starting") {
        throw new AttachmentError("attachmentExpired", "attachment session cannot be bound");
      }
      const key = turnKey(threadId, turnId);
      this.#pruneTerminalTurns();
      if (this.#terminalTurns.delete(key)) {
        await this.#deleteSession(session);
        return;
      }
      session.state = "consumed";
      session.boundThreadId = threadId;
      session.boundTurnId = turnId;
      try {
        await this.#persist();
      } catch (error) {
        session.state = "starting";
        delete session.boundThreadId;
        delete session.boundTurnId;
        throw error;
      }
    });
  }

  async completeTurn(threadId: string, turnId: string): Promise<void> {
    if (!threadId || !turnId) return;
    await this.#initialize();
    await this.#withMutationLock(async () => {
      const session = [...this.#sessions.values()].find((candidate) =>
        candidate.state === "consumed" &&
        candidate.boundThreadId === threadId &&
        candidate.boundTurnId === turnId,
      );
      if (session) {
        await this.#deleteSession(session);
        return;
      }
      this.#pruneTerminalTurns();
      this.#terminalTurns.delete(turnKey(threadId, turnId));
      this.#terminalTurns.set(turnKey(threadId, turnId), this.#now());
      while (this.#terminalTurns.size > MAX_TERMINAL_TURNS) {
        const oldest = this.#terminalTurns.keys().next().value;
        if (typeof oldest !== "string") break;
        this.#terminalTurns.delete(oldest);
      }
    });
  }

  async sweepExpired(): Promise<void> {
    if (this.#closed) return;
    await this.#initialize();
    await this.#withMutationLock(() => this.#sweepExpiredUnlocked());
  }

  async #sweepExpiredUnlocked(): Promise<void> {
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
    await this.#mutationTail;
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
      const session = parseStoredSession(value, this.#limits);
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
      limits: { ...this.#limits },
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

  #requireSession(sessionId: string): StoredSession {
    const session = this.#sessions.get(sessionId);
    if (!session || session.expiresAt <= this.#now()) {
      throw new AttachmentError("attachmentExpired", "attachment session is unavailable");
    }
    return session;
  }

  #requireDraftSession(sessionId: string): StoredSession {
    const session = this.#requireSession(sessionId);
    if (session.state !== "draft") {
      throw new AttachmentError("attachmentExpired", "attachment session is no longer editable");
    }
    return session;
  }

  #hostBytes(): number {
    return [...this.#sessions.values()].reduce((total, session) => total + session.totalBytes, 0);
  }

  #pruneTerminalTurns(): void {
    const cutoff = this.#now() - TERMINAL_TURN_TTL_MS;
    for (const [key, timestamp] of this.#terminalTurns) {
      if (timestamp >= cutoff) break;
      this.#terminalTurns.delete(key);
    }
  }

  async #withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#mutationTail = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
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

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (bytesWritten === 0) throw new Error("attachment write made no progress");
    offset += bytesWritten;
  }
}

function joinBytes(chunks: Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}
