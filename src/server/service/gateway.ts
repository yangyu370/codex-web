import {
  type BrowserEvent,
  type BrowserRequest,
  type BrowserResponse,
  type DirectoryListing,
  type ModelSummary,
  parseClientMessage,
  type ServerMessage,
  type ThreadSummary,
  type WebErrorCode,
} from "../../shared/protocol";
import type { WebState } from "./state";

export interface BrowserActions {
  listDirectory(path?: string): Promise<DirectoryListing>;
  models(): Promise<ModelSummary[]>;
  listThreads(cursor?: string): Promise<{ data: ThreadSummary[]; nextCursor: string | null }>;
  startThread(params: { cwd: string; model?: string }): Promise<unknown>;
  resumeThread(threadId: string): Promise<unknown>;
  readThread(threadId: string): Promise<unknown>;
  startTurn(threadId: string, text: string, attachmentSessionId?: string): Promise<unknown>;
  interruptTurn(threadId: string, turnId: string): Promise<unknown>;
  resolveApproval(id: string, decision: string, deviceId: string): void;
}

export interface BrowserGatewayOptions {
  maxEvents?: number;
  maxBytes?: number;
}

type Send = (message: ServerMessage) => void;

export class BrowserGateway {
  readonly #state: WebState;
  readonly #actions: BrowserActions;
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  readonly #connections = new Set<Send>();
  readonly #events: Array<{ event: BrowserEvent; bytes: number }> = [];
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
    state.onEvent((event) => this.#recordEvent(event));
  }

  connect(send: Send, afterSequence?: number): () => void {
    this.#connections.add(send);
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
    return () => this.#connections.delete(send);
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
        return this.#actions.startTurn(
          requiredString(request.params, "threadId"),
          request.params.text,
          optionalString(request.params.attachmentSessionId),
        );
      case "turn.interrupt":
        return this.#actions.interruptTurn(
          requiredString(request.params, "threadId"),
          requiredString(request.params, "turnId"),
        );
      case "approval.resolve":
        this.#actions.resolveApproval(
          requiredString(request.params, "approvalId"),
          requiredString(request.params, "decision"),
          deviceId,
        );
        return {};
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
