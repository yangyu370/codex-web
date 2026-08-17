import type {
  BrowserEvent,
  BrowserSnapshot,
  ModelSummary,
  PendingApproval,
  ThreadSummary,
  VisibleItem,
} from "../../shared/protocol";
import { decodeThread, optionalNumber, optionalString, record } from "../app-server/decoders";
import type { JsonRpcNotification, JsonRpcServerRequest } from "../app-server/json-rpc";

const MAX_VISIBLE_ITEMS = 500;
const MAX_ITEM_BYTES = 262_144;
const MAX_DIAGNOSTICS = 500;

export interface ClaimedApproval extends PendingApproval {
  method: string;
  params: Record<string, unknown>;
  decision: string;
}

export class WebState {
  readonly #platform: "macos" | "windows";
  readonly #listeners = new Set<(event: BrowserEvent) => void>();
  readonly #approvalRequests = new Map<string, JsonRpcServerRequest>();
  readonly #diagnostics: string[] = [];
  #sequence = 0;
  #service: BrowserSnapshot["service"];
  #models: ModelSummary[] = [];
  #threads: ThreadSummary[] = [];
  #loadedThreadId?: string;
  #activeTurn?: BrowserSnapshot["activeTurn"];
  #visibleItems: VisibleItem[] = [];
  #approvals: PendingApproval[] = [];
  #tokenUsage?: BrowserSnapshot["tokenUsage"];

  constructor(platform: "macos" | "windows") {
    this.#platform = platform;
    this.#service = { status: "starting", platform };
  }

  snapshot(): BrowserSnapshot {
    return structuredClone({
      kind: "snapshot",
      sequence: this.#sequence,
      service: this.#service,
      models: this.#models,
      threads: this.#threads,
      ...(this.#loadedThreadId ? { loadedThreadId: this.#loadedThreadId } : {}),
      ...(this.#activeTurn ? { activeTurn: this.#activeTurn } : {}),
      visibleItems: this.#visibleItems,
      pendingApprovals: this.#approvals.filter((approval) => approval.status === "pending"),
      ...(this.#tokenUsage ? { tokenUsage: this.#tokenUsage } : {}),
    });
  }

  setService(service: Omit<BrowserSnapshot["service"], "platform">): void {
    this.#service = { ...service, platform: this.#platform };
    this.#emit("service.updated", this.#service);
  }

  setModels(models: ModelSummary[]): void {
    this.#models = models.slice();
    this.#emit("models.updated", { models: this.#models });
  }

  setThreads(threads: ThreadSummary[]): void {
    this.#threads = threads.slice(0, 500);
    this.#emit("threads.updated", { threads: this.#threads });
  }

  upsertThread(thread: ThreadSummary): void {
    this.#upsertThread(thread);
    this.#emit("thread.updated", { thread });
  }

  loadThread(threadId: string, items: VisibleItem[]): void {
    this.#loadedThreadId = threadId;
    this.#visibleItems = items.slice(-MAX_VISIBLE_ITEMS);
    this.#emit("thread.loaded", { threadId, items: this.#visibleItems });
  }

  applyNotification(notification: JsonRpcNotification): void {
    try {
      const params = record(notification.params, `${notification.method}.params`);
      switch (notification.method) {
        case "thread/started":
          this.#upsertThread(decodeThread(params.thread));
          break;
        case "turn/started":
          this.#applyTurnStarted(params);
          break;
        case "turn/completed":
          this.#applyTurnCompleted(params);
          break;
        case "item/started":
        case "item/completed":
          this.#applyItem(params, notification.method === "item/completed");
          break;
        case "item/agentMessage/delta":
          this.#appendDelta(params, "message", "text");
          break;
        case "item/commandExecution/outputDelta":
          this.#appendDelta(params, "command", "output");
          break;
        case "item/fileChange/outputDelta":
          this.#appendDelta(params, "fileChange", "diff");
          break;
        case "thread/tokenUsage/updated":
          this.#applyTokenUsage(params);
          break;
        default:
          this.addDiagnostic(`unknown notification: ${notification.method}`);
          return;
      }
      this.#emit(notification.method, { snapshot: this.snapshot() });
    } catch (error) {
      this.addDiagnostic(
        `${notification.method}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  addApproval(request: JsonRpcServerRequest): PendingApproval {
    const params = record(request.params, `${request.method}.params`);
    const kind = approvalKind(request.method);
    const requestId = request.id;
    const id = `approval:${String(requestId)}`;
    const available = Array.isArray(params.availableDecisions)
      ? params.availableDecisions.filter((value): value is string => typeof value === "string")
      : defaultApprovalDecisions(kind);
    const itemId = optionalString(params.itemId);
    const existingItem = itemId
      ? this.#visibleItems.find((item) => item.id === itemId)
      : undefined;
    const approval: PendingApproval = {
      id,
      requestId,
      kind,
      threadId: requiredString(params, "threadId"),
      turnId: requiredString(params, "turnId"),
      ...(itemId ? { itemId } : {}),
      ...(optionalString(params.reason) ? { reason: optionalString(params.reason) } : {}),
      ...(optionalString(params.cwd) ? { cwd: optionalString(params.cwd) } : {}),
      ...(optionalString(params.command) ? { command: optionalString(params.command) } : {}),
      ...(existingItem?.type === "fileChange" && existingItem.diff
        ? { diff: existingItem.diff }
        : {}),
      availableDecisions: available,
      status: "pending",
    };
    this.#approvalRequests.set(id, request);
    this.#approvals = [...this.#approvals.filter((entry) => entry.id !== id), approval];
    this.#emit("approval.pending", { approval });
    return structuredClone(approval);
  }

  claimApproval(id: string, decision: string): ClaimedApproval {
    const approval = this.#approvals.find((entry) => entry.id === id);
    const request = this.#approvalRequests.get(id);
    if (!approval || !request || approval.status !== "pending") {
      throw new Error("alreadyResolved");
    }
    if (!approval.availableDecisions.includes(decision)) {
      throw new Error("invalidRequest: unsupported approval decision");
    }
    approval.status = "resolved";
    approval.decision = decision;
    this.#approvalRequests.delete(id);
    const claimed = {
      ...structuredClone(approval),
      method: request.method,
      params: record(request.params, `${request.method}.params`),
      decision,
    };
    this.#emit("approval.resolved", { approval: claimed });
    return claimed;
  }

  interruptApprovals(): void {
    for (const approval of this.#approvals) {
      if (approval.status === "pending") {
        approval.status = "interrupted";
      }
    }
    this.#approvalRequests.clear();
    this.#emit("approvals.interrupted", {});
  }

  onEvent(listener: (event: BrowserEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  addDiagnostic(message: string): void {
    this.#diagnostics.push(message);
    if (this.#diagnostics.length > MAX_DIAGNOSTICS) {
      this.#diagnostics.splice(0, this.#diagnostics.length - MAX_DIAGNOSTICS);
    }
  }

  diagnostics(): string[] {
    return this.#diagnostics.slice();
  }

  #upsertThread(thread: ThreadSummary): void {
    this.#threads = [thread, ...this.#threads.filter((entry) => entry.id !== thread.id)].slice(
      0,
      500,
    );
  }

  #applyTurnStarted(params: Record<string, unknown>): void {
    const turn = record(params.turn, "turn/started.turn");
    const threadId = requiredString(params, "threadId");
    this.#loadedThreadId = threadId;
    this.#activeTurn = {
      id: requiredString(turn, "id"),
      threadId,
      status: "inProgress",
    };
  }

  #applyTurnCompleted(params: Record<string, unknown>): void {
    const turn = record(params.turn, "turn/completed.turn");
    const threadId = requiredString(params, "threadId");
    this.#activeTurn = {
      id: requiredString(turn, "id"),
      threadId,
      status: normalizeTurnStatus(optionalString(turn.status)),
    };
  }

  #applyItem(params: Record<string, unknown>, completed: boolean): void {
    const item = record(params.item, "item");
    const id = requiredString(item, "id");
    const type = requiredString(item, "type");
    let visible: VisibleItem | undefined;
    if (type === "agentMessage") {
      visible = {
        id,
        type: "message",
        role: "assistant",
        text: optionalString(item.text) ?? "",
        streaming: !completed,
      };
    } else if (type === "userMessage") {
      visible = {
        id,
        type: "message",
        role: "user",
        text: userMessageText(item.content),
        streaming: false,
      };
    } else if (type === "commandExecution") {
      const status = normalizeItemStatus(optionalString(item.status), completed);
      visible = {
        id,
        type: "command",
        command: optionalString(item.command) ?? "Command",
        ...(optionalString(item.cwd) ? { cwd: optionalString(item.cwd) } : {}),
        output: optionalString(item.aggregatedOutput) ?? "",
        status,
        ...(optionalNumber(item.exitCode) === undefined
          ? {}
          : { exitCode: optionalNumber(item.exitCode) }),
      };
    } else if (type === "fileChange") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const first = changes.length > 0 ? record(changes[0], "fileChange.changes[0]") : {};
      visible = {
        id,
        type: "fileChange",
        path: optionalString(first.path) ?? "File changes",
        ...(optionalString(first.diff) ? { diff: optionalString(first.diff) } : {}),
        status: normalizeItemStatus(optionalString(item.status), completed),
      };
    } else if (type === "reasoning" || type === "plan") {
      const summary = Array.isArray(item.summary)
        ? item.summary.filter((value): value is string => typeof value === "string").join("\n")
        : undefined;
      visible = {
        id,
        type: "status",
        text: optionalString(item.text) ?? summary ?? type,
      };
    }
    if (visible) {
      this.#replaceVisibleItem(visible);
    }
  }

  #appendDelta(
    params: Record<string, unknown>,
    itemType: "message" | "command" | "fileChange",
    field: "text" | "output" | "diff",
  ): void {
    const id = requiredString(params, "itemId");
    const delta = requiredString(params, "delta");
    const item = this.#visibleItems.find((entry) => entry.id === id && entry.type === itemType);
    if (!item) {
      this.addDiagnostic(`delta for unknown ${itemType} item ${id}`);
      return;
    }
    const current =
      item.type === "message"
        ? item.text
        : item.type === "command"
          ? item.output
          : item.type === "fileChange"
            ? (item.diff ?? "")
            : "";
    const bounded = boundNewest(`${current}${delta}`, MAX_ITEM_BYTES);
    Object.assign(item, { [field]: bounded.value, ...(bounded.truncated ? { truncated: true } : {}) });
  }

  #applyTokenUsage(params: Record<string, unknown>): void {
    const tokenUsage = record(params.tokenUsage, "tokenUsage");
    const total = record(tokenUsage.total, "tokenUsage.total");
    const used = optionalNumber(total.totalTokens);
    if (used === undefined) {
      throw new Error("compatibilityError: tokenUsage.total.totalTokens");
    }
    const contextWindow = optionalNumber(tokenUsage.modelContextWindow);
    this.#tokenUsage = {
      used,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    };
  }

  #replaceVisibleItem(item: VisibleItem): void {
    const existing = this.#visibleItems.findIndex((entry) => entry.id === item.id);
    if (existing >= 0) {
      this.#visibleItems[existing] = item;
    } else {
      this.#visibleItems.push(item);
      if (this.#visibleItems.length > MAX_VISIBLE_ITEMS) {
        this.#visibleItems.splice(0, this.#visibleItems.length - MAX_VISIBLE_ITEMS);
      }
    }
  }

  #emit(type: string, payload: unknown): void {
    this.#sequence += 1;
    const event: BrowserEvent = { kind: "event", sequence: this.#sequence, type, payload };
    for (const listener of this.#listeners) {
      listener(structuredClone(event));
    }
  }
}

function approvalKind(method: string): PendingApproval["kind"] {
  if (method === "item/commandExecution/requestApproval") return "command";
  if (method === "item/fileChange/requestApproval") return "fileChange";
  if (method === "item/permissions/requestApproval") return "permissions";
  throw new Error(`compatibilityError: unsupported approval method ${method}`);
}

function defaultApprovalDecisions(kind: PendingApproval["kind"]): string[] {
  return kind === "permissions"
    ? ["grantTurn", "grantSession", "decline"]
    : ["accept", "acceptForSession", "decline", "cancel"];
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = optionalString(value[key]);
  if (result === undefined) throw new Error(`compatibilityError: ${key}`);
  return result;
}

function normalizeTurnStatus(value: string | undefined): NonNullable<BrowserSnapshot["activeTurn"]>["status"] {
  if (value === "completed") return "completed";
  if (value === "interrupted") return "interrupted";
  if (value === "failed") return "failed";
  return "inProgress";
}

function normalizeItemStatus(
  value: string | undefined,
  completed: boolean,
): "running" | "completed" | "failed" {
  if (value === "failed" || value === "declined") return "failed";
  if (value === "completed" || completed) return "completed";
  return "running";
}

function userMessageText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return "";
      return optionalString((entry as Record<string, unknown>).text) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

function boundNewest(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return { value, truncated: false };
  let start = encoded.byteLength - maxBytes;
  while (start < encoded.byteLength && (encoded[start] ?? 0) >> 6 === 0b10) start += 1;
  return { value: new TextDecoder().decode(encoded.slice(start)), truncated: true };
}
