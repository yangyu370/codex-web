import type { AttachmentLimits, AttachmentSummary } from "../../shared/protocol";

const MAX_PATH_BYTES = 4_096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StoredAttachment extends AttachmentSummary {
  storedName: string;
}

export interface StoredAttachmentSession {
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
  files: StoredAttachment[];
  boundThreadId?: string;
  boundTurnId?: string;
}

export function parseStoredSession(
  value: unknown,
  limits: AttachmentLimits,
): StoredAttachmentSession | undefined {
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
    value.totalBytes < 0 ||
    !Array.isArray(value.files)
  ) return undefined;

  const files = value.files.map(parseStoredAttachment);
  const boundThreadId = optionalBoundedString(value.boundThreadId, 512);
  const boundTurnId = optionalBoundedString(value.boundTurnId, 512);
  if (
    files.some((file) => !file) ||
    files.length > limits.files ||
    files.reduce((total, file) => total + (file?.size ?? 0), 0) !== value.totalBytes ||
    value.totalBytes > limits.totalBytes ||
    ((value.state === "consumed") !== Boolean(boundThreadId && boundTurnId))
  ) return undefined;

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
    files: files as StoredAttachment[],
    ...(boundThreadId ? { boundThreadId } : {}),
    ...(boundTurnId ? { boundTurnId } : {}),
  };
}

function parseStoredAttachment(value: unknown): StoredAttachment | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.name !== "string" ||
    byteLength(value.name) > 120 ||
    typeof value.storedName !== "string" ||
    byteLength(value.storedName) > 180 ||
    value.storedName !== `${value.id}-${value.name}` ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    (value.kind !== "text" && value.kind !== "pdf" && value.kind !== "image")
  ) return undefined;
  return {
    id: value.id,
    name: value.name,
    storedName: value.storedName,
    size: value.size,
    kind: value.kind,
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

function optionalBoundedString(value: unknown, maxBytes: number): string | undefined {
  return typeof value === "string" && value.length > 0 && byteLength(value) <= maxBytes
    ? value
    : undefined;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
