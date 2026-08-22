import {
  type BrowserEvent,
  type BrowserRequest,
  type BrowserResponse,
  type DirectoryListing,
  type ModelSummary,
  type PermissionProfileSummary,
  parseClientMessage,
  type ServerMessage,
  type ThreadSummary,
  type WebErrorCode,
} from "../../shared/protocol";
import type { WebState } from "./state";

export interface BrowserActions {
  listDirectory(path?: string): Promise<DirectoryListing>;
  models(): Promise<ModelSummary[]>;
  permissionProfiles(): Promise<PermissionProfileSummary[]>;
  listThreads(cursor?: string): Promise<{ data: ThreadSummary[]; nextCursor: string | null }>;
  startThread(params: { cwd: string; model?: string }): Promise<unknown>;
  resumeThread(threadId: string): Promise<unknown>;
  readThread(threadId: string): Promise<unknown>;
  startTurn(
    threadId: string,
    text: string,
    attachmentSessionId?: string,
    settings?: { model?: string; effort?: string; permissionProfile?: string },
  ): Promise<unknown>;
  interruptTurn(threadId: string, turnId: string): Promise<unknown>;
  updateThreadSettings(
    threadId: string,
    settings: { effort?: string; permissionProfile?: string },
  ): Promise<unknown>;
  startReview(threadId: string): Promise<unknown>;
  resolveApproval(id: string, decision: string, deviceId: string): void;
}

export interface BrowserGatewayOptions {
  maxEvents?: number;
  maxBytes?: number;
  onConnectionCountChanged?: (count: number) => void;
}

type Send = (message: ServerMessage) => void;

export class BrowserGateway {
  readonly #state: WebState;
  readonly #actions: BrowserActions;
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  readonly #onConnectionCountChanged?: (count: number) => void;
  readonly #connections = new Set<Send>();
  readonly #events: Array<{ event: BrowserEvent; bytes: number }> = [];
  readonly #reviewRequests = new Set<string>();
  #eventBytes = 0;

  constructor(
    state: WebState,
    actions: BrowserActions,
    options: BrowserGatewayOptions = {},
  ) {
    this.#state = state;
    this.#actions = actions;
    this.#maxEvents = options.maxEvents ?? 1_000;
    this.#maxBytes = options.maxBytes ?? 2_097_152;
    this.#onConnectionCountChanged = options.onConnectionCountChanged;
    state.onEvent((event) => this.#recordEvent(event));
  }

  connect(send: Send, afterSequence?: number): () => void {
    this.#connections.add(send);
    this.#onConnectionCountChanged?.(this.#connections.size);
    if (afterSequence === undefined) {
      send(this.#state.snapshot());
    } else {
      const earliest = this.#events[0]?.event.sequence;
      const current = this.#state.snapshot().sequence;
      if (
        afterSequence > current ||
        (earliest !== undefined && afterSequence < earliest - 1) ||
        (earliest === undefined && afterSequence < current)
      ) {
        send(this.#state.snapshot());
      } else {
        for (const entry of this.#events) {
          if (entry.event.sequence > afterSequence) {
            send(structuredClone(entry.event));
          }
        }
      }
    }
    let disconnected = false;
    return () => {
      if (disconnected) return;
      disconnected = true;
      this.#connections.delete(send);
      this.#onConnectionCountChanged?.(this.#connections.size);
    };
  }

  async handleMessage(source: string, send: Send, deviceId = "browser"): Promise<void> {
    let request: BrowserRequest;
    try {
      request = parseClientMessage(source);
    } catch (error) {
      send(errorResponse("unknown", error));
      return;
    }
    try {
      const result = await this.#dispatch(request, deviceId);
      send({ kind: "response", id: request.id, result });
    } catch (error) {
      send(errorResponse(request.id, error));
    }
  }

  async #dispatch(request: BrowserRequest, deviceId: string): Promise<unknown> {
    switch (request.method) {
      case "directory.list":
        return this.#actions.listDirectory(optionalString(request.params.path));
      case "model.list":
        return this.#actions.models();
      case "permissionProfile.list":
        return this.#actions.permissionProfiles();
      case "thread.list":
        return this.#actions.listThreads(optionalString(request.params.cursor));
      case "thread.start": {
        const cwd = requiredString(request.params, "cwd");
        const model = optionalString(request.params.model);
        return this.#actions.startThread({ cwd, ...(model ? { model } : {}) });
      }
      case "thread.resume":
        return this.#actions.resumeThread(requiredString(request.params, "threadId"));
      case "thread.read":
        return this.#actions.readThread(requiredString(request.params, "threadId"));
      case "turn.start":
        if (typeof request.params.text !== "string") {
          throw new Error("invalidRequest: text is required");
        }
        {
          const threadId = requiredBoundedString(request.params, "threadId", 512);
          this.#requireWritableThread(threadId);
          const model = optionalBoundedString(request.params, "model", 512);
          const effort = optionalBoundedString(request.params, "effort", 512);
          const permissionProfile = optionalBoundedString(
            request.params,
            "permissionProfile",
            512,
          );
          const settings = {
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            ...(permissionProfile ? { permissionProfile } : {}),
          };
          return this.#actions.startTurn(
          threadId,
          request.params.text,
          optionalString(request.params.attachmentSessionId),
          Object.keys(settings).length > 0 ? settings : undefined,
          );
        }
      case "thread.settings.update": {
        const threadId = requiredBoundedString(request.params, "threadId", 512);
        this.#requireWritableThread(threadId);
        const effort = optionalBoundedString(request.params, "effort", 512);
        const permissionProfile = optionalBoundedString(
          request.params,
          "permissionProfile",
          512,
        );
        if (!effort && !permissionProfile) {
          throw new Error("invalidRequest: task settings update is empty");
        }
        return this.#actions.updateThreadSettings(threadId, {
          ...(effort ? { effort } : {}),
          ...(permissionProfile ? { permissionProfile } : {}),
        });
      }
      case "review.start": {
        const threadId = requiredBoundedString(request.params, "threadId", 512);
        return this.#startReview(threadId);
      }
      case "turn.interrupt": {
        const threadId = requiredBoundedString(request.params, "threadId", 512);
        const turnId = requiredBoundedString(request.params, "turnId", 512);
        this.#requireWritableThread(threadId);
        const activeTurn = this.#state.snapshot().activeTurn;
        if (
          activeTurn?.threadId !== threadId ||
          activeTurn.id !== turnId ||
          activeTurn.status !== "inProgress"
        ) {
          throw new Error("invalidRequest: turn is not the active task turn");
        }
        return this.#actions.interruptTurn(threadId, turnId);
      }
      case "approval.resolve":
        this.#actions.resolveApproval(
          requiredString(request.params, "approvalId"),
          requiredString(request.params, "decision"),
          deviceId,
        );
        return {};
    }
  }

  #requireWritableThread(threadId: string): void {
    if (!this.#state.canAcceptDirectInput(threadId)) {
      throw new Error("invalidRequest: task is not available for direct input");
    }
  }

  async #startReview(threadId: string): Promise<unknown> {
    this.#requireWritableThread(threadId);
    const snapshot = this.#state.snapshot();
    if (
      snapshot.activeTurn?.status === "inProgress" ||
      snapshot.review?.status === "inProgress" ||
      this.#reviewRequests.has(threadId)
    ) {
      throw new Error("invalidRequest: task already has active work");
    }
    this.#reviewRequests.add(threadId);
    try {
      return await this.#actions.startReview(threadId);
    } finally {
      this.#reviewRequests.delete(threadId);
    }
  }

  #recordEvent(event: BrowserEvent): void {
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (bytes <= this.#maxBytes) {
      this.#events.push({ event: structuredClone(event), bytes });
      this.#eventBytes += bytes;
      while (
        this.#events.length > this.#maxEvents ||
        this.#eventBytes > this.#maxBytes
      ) {
        const removed = this.#events.shift();
        if (removed) this.#eventBytes -= removed.bytes;
      }
    } else {
      this.#events.splice(0);
      this.#eventBytes = 0;
    }
    for (const connection of this.#connections) {
      connection(structuredClone(event));
    }
  }
}

function requiredString(params: Record<string, unknown>, field: string): string {
  const value = optionalString(params[field]);
  if (!value) throw new Error(`invalidRequest: ${field} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredBoundedString(
  params: Record<string, unknown>,
  field: string,
  maxBytes: number,
): string {
  const value = requiredString(params, field);
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new Error(`invalidRequest: ${field} is too large`);
  }
  return value;
}

function optionalBoundedString(
  params: Record<string, unknown>,
  field: string,
  maxBytes: number,
): string | undefined {
  const raw = params[field];
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") throw new Error(`invalidRequest: ${field} must be a string`);
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new Error(`invalidRequest: ${field} is too large`);
  }
  return raw;
}

function errorResponse(id: string, error: unknown): BrowserResponse {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(message);
  return {
    kind: "response",
    id,
    error: {
      code,
      message: safeMessage(code),
      retryable:
        code === "notReady" ||
        code === "codexUnavailable" ||
        (code === "codexRejected" && message.includes("retryable")),
      diagnosticId: crypto.randomUUID(),
    },
  };
}

function errorCode(message: string): WebErrorCode {
  const codes: WebErrorCode[] = [
    "unsupportedPlatform",
    "notReady",
    "notAuthenticated",
    "invalidRequest",
    "invalidWorkingDirectory",
    "codexUnavailable",
    "codexRejected",
    "compatibilityError",
    "interrupted",
    "alreadyResolved",
    "invalidAttachment",
    "attachmentTooLarge",
    "attachmentCapacity",
    "attachmentExpired",
  ];
  return codes.find((code) => message.includes(code)) ?? "internalError";
}

function safeMessage(code: WebErrorCode): string {
  switch (code) {
    case "alreadyResolved":
      return "This approval was already resolved.";
    case "invalidRequest":
      return "The request is invalid.";
    case "invalidWorkingDirectory":
      return "The working directory is unavailable.";
    case "invalidAttachment":
      return "The attachment request is invalid.";
    case "attachmentTooLarge":
      return "An attachment exceeds the allowed size.";
    case "attachmentCapacity":
      return "Attachment capacity was reached.";
    case "attachmentExpired":
      return "The attachment session expired.";
    case "notReady":
      return "Codex is still starting.";
    case "codexUnavailable":
      return "Codex is unavailable.";
    case "compatibilityError":
      return "The installed Codex version is not compatible with this action.";
    default:
      return "The request could not be completed.";
  }
}
