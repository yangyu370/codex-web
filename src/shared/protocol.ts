import { z } from "zod";

export const MAX_BROWSER_MESSAGE_BYTES = 65_536;
export const MAX_SERVER_MESSAGE_BYTES = 8_388_608;

export const browserMethods = [
  "directory.list",
  "model.list",
  "thread.list",
  "thread.start",
  "thread.resume",
  "thread.read",
  "turn.start",
  "turn.interrupt",
  "approval.resolve",
] as const;

export type BrowserMethod = (typeof browserMethods)[number];

export type WebErrorCode =
  | "unsupportedPlatform"
  | "notReady"
  | "notAuthenticated"
  | "invalidRequest"
  | "invalidWorkingDirectory"
  | "codexUnavailable"
  | "codexRejected"
  | "compatibilityError"
  | "interrupted"
  | "alreadyResolved"
  | "internalError";

export interface WebError {
  code: WebErrorCode;
  message: string;
  retryable: boolean;
  diagnosticId?: string;
}

export interface BrowserRequest {
  kind: "request";
  id: string;
  method: BrowserMethod;
  params: Record<string, unknown>;
}

export interface BrowserResponse {
  kind: "response";
  id: string;
  result?: unknown;
  error?: WebError;
}

export interface BrowserEvent<T = unknown> {
  kind: "event";
  sequence: number;
  type: string;
  payload: T;
}

export interface ModelSummary {
  id: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
}

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryListing {
  current: DirectoryEntry;
  parent?: string;
  roots: DirectoryEntry[];
  directories: DirectoryEntry[];
  truncated: boolean;
}

export interface ThreadSummary {
  id: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  cwd?: string;
  status?: string;
}

export type VisibleItem =
  | {
      id: string;
      type: "message";
      role: "user" | "assistant";
      text: string;
      streaming?: boolean;
      truncated?: boolean;
    }
  | {
      id: string;
      type: "command";
      command: string;
      cwd?: string;
      output: string;
      status: "running" | "completed" | "failed";
      exitCode?: number;
      truncated?: boolean;
    }
  | {
      id: string;
      type: "fileChange";
      path: string;
      diff?: string;
      status: "running" | "completed" | "failed";
      truncated?: boolean;
    }
  | {
      id: string;
      type: "status";
      text: string;
      tone?: "neutral" | "success" | "warning" | "error";
      truncated?: boolean;
    };

export interface PendingApproval {
  id: string;
  kind: "command" | "fileChange" | "permissions";
  threadId: string;
  turnId: string;
  itemId?: string;
  reason?: string;
  cwd?: string;
  command?: string;
  diff?: string;
  availableDecisions: string[];
  status: "pending" | "resolved" | "interrupted";
  decision?: string;
}

export interface BrowserSnapshot {
  kind: "snapshot";
  sequence: number;
  service: {
    status: "starting" | "ready" | "restarting" | "unavailable";
    platform: "macos" | "windows";
    codexVersion?: string;
    error?: WebError;
  };
  models: ModelSummary[];
  threads: ThreadSummary[];
  loadedThreadId?: string;
  activeTurn?: {
    id: string;
    threadId: string;
    status: "inProgress" | "completed" | "interrupted" | "failed";
  };
  visibleItems: VisibleItem[];
  pendingApprovals: PendingApproval[];
  tokenUsage?: {
    used: number;
    contextWindow?: number;
  };
}

export type ServerMessage = BrowserResponse | BrowserEvent | BrowserSnapshot;

const requestSchema = z.object({
  kind: z.literal("request"),
  id: z.string().min(1).max(128),
  method: z.enum(browserMethods),
  params: z.record(z.string(), z.unknown()),
});

export function parseClientMessage(source: string): BrowserRequest {
  if (new TextEncoder().encode(source).byteLength > MAX_BROWSER_MESSAGE_BYTES) {
    throw new Error(
      `invalidRequest: message exceeds ${MAX_BROWSER_MESSAGE_BYTES} bytes`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("invalidRequest: malformed JSON");
  }

  const result = requestSchema.safeParse(value);
  if (!result.success) {
    throw new Error("invalidRequest: invalid request envelope");
  }
  return result.data;
}

export function encodeServerMessage(message: ServerMessage): string {
  const encoded = JSON.stringify(message);
  if (new TextEncoder().encode(encoded).byteLength > MAX_SERVER_MESSAGE_BYTES) {
    throw new Error("server message exceeds 8388608 bytes");
  }
  return encoded;
}
