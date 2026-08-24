import type {
  BrowserEvent,
  BrowserSnapshot,
  ModelSummary,
  PendingApproval,
  PermissionProfileSummary,
  ReviewState,
  ThreadSummary,
  ThreadAccess,
  ThreadSettingsSummary,
  VisibleItem,
} from "../../shared/protocol";
import { WEB_PROTOCOL_VERSION } from "../../shared/protocol";
import {
  decodeHistoryItem,
  decodeThread,
  decodeThreadRuntime,
  optionalNumber,
  optionalString,
  record,
} from "../app-server/decoders";
import type { JsonRpcNotification, JsonRpcServerRequest } from "../app-server/json-rpc";

const MAX_VISIBLE_ITEMS = 500;
const MAX_ITEM_BYTES = 262_144;
const MAX_VISIBLE_BYTES = 4_194_304;
const MAX_CATALOG_ENTRIES = 500;
const MAX_METADATA_BYTES = 4_096;
const MAX_PENDING_APPROVALS = 100;
const MAX_APPROVAL_REQUEST_BYTES = 65_536;
const MAX_SNAPSHOT_BYTES = 7_340_032;
const MAX_DIAGNOSTICS = 500;
const MAX_DIAGNOSTIC_BYTES = 16_384;
const MAX_APPROVAL_AUDIT = 500;
const MAX_TURN_DIFF_BYTES = 1_048_576;

export interface ApprovalAuditEntry {
  approvalId: string;
  decision: string;
  deviceId: string;
  threadId: string;
  turnId: string;
  timestamp: number;
}

export interface ClaimedApproval extends PendingApproval {
  requestId: string | number;
  method: string;
  params: Record<string, unknown>;
  decision: string;
}

export class WebState {
  readonly #platform: "macos" | "windows";
  readonly #listeners = new Set<(event: BrowserEvent) => void>();
  readonly #approvalRequests = new Map<string, JsonRpcServerRequest>();
  readonly #diagnostics: string[] = [];
  readonly #approvalAudit: ApprovalAuditEntry[] = [];
  readonly #auditSink?: (type: "diagnostic" | "approval", payload: unknown) => void;
  #sequence = 0;
  #service: BrowserSnapshot["service"];
  #models: ModelSummary[] = [];
  #permissionProfiles: PermissionProfileSummary[] = [];
  #threads: ThreadSummary[] = [];
  #loadedThreadId?: string;
  #threadAccess?: ThreadAccess;
  #activeTurn?: BrowserSnapshot["activeTurn"];
  #visibleItems: VisibleItem[] = [];
  #approvals: PendingApproval[] = [];
  #tokenUsage?: BrowserSnapshot["tokenUsage"];
  #threadSettings?: ThreadSettingsSummary;
  #review?: ReviewState;
  #turnDiff?: BrowserSnapshot["turnDiff"];

  constructor(
    platform: "macos" | "windows",
    auditSink?: (type: "diagnostic" | "approval", payload: unknown) => void,
  ) {
    this.#platform = platform;
    this.#auditSink = auditSink;
    this.#service = { status: "starting", platform };
  }

  snapshot(): BrowserSnapshot {
    const snapshot: BrowserSnapshot = structuredClone({
      kind: "snapshot",
      protocolVersion: WEB_PROTOCOL_VERSION,
      sequence: this.#sequence,
      service: this.#service,
      models: this.#models,
      permissionProfiles: this.#permissionProfiles,
      threads: this.#threads,
      ...(this.#loadedThreadId ? { loadedThreadId: this.#loadedThreadId } : {}),
      ...(this.#threadAccess ? { threadAccess: this.#threadAccess } : {}),
      ...(this.#activeTurn ? { activeTurn: this.#activeTurn } : {}),
      visibleItems: this.#visibleItems,
      pendingApprovals: this.#approvals.filter((approval) => approval.status === "pending"),
      ...(this.#threadSettings ? { threadSettings: this.#threadSettings } : {}),
      ...(this.#review ? { review: this.#review } : {}),
      ...(this.#turnDiff ? { turnDiff: this.#turnDiff } : {}),
      ...(this.#tokenUsage ? { tokenUsage: this.#tokenUsage } : {}),
    });
    while (snapshot.visibleItems.length > 0 && !fits(JSON.stringify(snapshot), MAX_SNAPSHOT_BYTES)) {
      snapshot.visibleItems.shift();
    }
    return snapshot;
  }

  setService(service: Omit<BrowserSnapshot["service"], "platform">): void {
    this.#service = { ...service, platform: this.#platform };
    this.#emit("service.updated", this.#service);
  }

  setModels(models: ModelSummary[]): void {
    this.#models = models.slice(0, MAX_CATALOG_ENTRIES).flatMap((model) => {
      if (!fits(model.id, 512)) return [];
      return [{
        ...model,
        displayName: boundOldest(model.displayName, MAX_METADATA_BYTES),
        ...(model.description ? { description: boundOldest(model.description, MAX_METADATA_BYTES) } : {}),
      }];
    });
    this.#emit("models.updated", { models: this.#models });
  }

  setPermissionProfiles(profiles: PermissionProfileSummary[]): void {
    this.#permissionProfiles = profiles.slice(0, MAX_CATALOG_ENTRIES).flatMap((profile) => {
      if (!fits(profile.id, 512)) return [];
      return [{
        id: profile.id,
        allowed: profile.allowed,
        ...(profile.description
          ? { description: boundOldest(profile.description, MAX_METADATA_BYTES) }
          : {}),
      }];
    });
    this.#emit("permissionProfiles.updated", { permissionProfiles: this.#permissionProfiles });
  }

  setThreadSettings(settings: ThreadSettingsSummary | undefined): void {
    this.#threadSettings = settings;
    this.#emit("thread.settings.updated", { threadSettings: settings });
  }

  setReview(review: ReviewState | undefined): void {
    this.#review = review;
    this.#emit("review.updated", { review });
  }

  setThreads(threads: ThreadSummary[]): void {
    let next = threads.slice(0, MAX_CATALOG_ENTRIES).flatMap(boundThread);
    const loaded = this.#loadedThreadId
      ? this.#threads.find((thread) => thread.id === this.#loadedThreadId)
      : undefined;
    if (loaded) {
      next = next.map((thread) => thread.id === loaded.id ? { ...loaded, ...thread } : thread);
    }
    this.#threads = loaded && !next.some((thread) => thread.id === loaded.id)
      ? [loaded, ...next].slice(0, MAX_CATALOG_ENTRIES)
      : next;
    this.#emit("threads.updated", { threads: this.#threads });
  }

  upsertThread(thread: ThreadSummary): void {
    this.#upsertThread(thread);
    this.#emit("thread.updated", { thread });
  }

  loadThread(
    threadId: string,
    items: VisibleItem[],
    activeTurn?: BrowserSnapshot["activeTurn"],
    access?: ThreadAccess,
    suppressUnchanged = false,
  ): void {
    if (access && access.threadId !== threadId) {
      throw new Error("invalidRequest: thread access does not match loaded task");
    }
    const previousItems = this.#visibleItems;
    this.#visibleItems = items.slice(-MAX_VISIBLE_ITEMS);
    this.#trimVisibleItems();
    const unchanged = this.#loadedThreadId === threadId &&
      sameValue(this.#visibleItems, previousItems) &&
      sameValue(this.#activeTurn, activeTurn?.threadId === threadId ? activeTurn : undefined) &&
      sameValue(this.#threadAccess, access);
    if (suppressUnchanged && unchanged) {
      this.#visibleItems = previousItems;
      return;
    }
    this.#threadSettings = undefined;
    this.#review = undefined;
    this.#turnDiff = undefined;
    this.#tokenUsage = undefined;
    this.interruptApprovals();
    this.#loadedThreadId = threadId;
    this.#threadAccess = access;
    this.#activeTurn = activeTurn?.threadId === threadId ? activeTurn : undefined;
    this.#emit("thread.loaded", {
      threadId,
      items: this.#visibleItems,
      ...(this.#activeTurn ? { activeTurn: this.#activeTurn } : {}),
      ...(this.#threadAccess ? { threadAccess: this.#threadAccess } : {}),
    });
  }

  setThreadAccess(access: ThreadAccess): void {
    if (access.threadId !== this.#loadedThreadId) {
      throw new Error("invalidRequest: thread access does not match loaded task");
    }
    this.#threadAccess = access;
    this.#emit("thread.access.updated", { threadAccess: access });
  }

  applyNotification(notification: JsonRpcNotification): void {
    try {
      const params = record(notification.params, `${notification.method}.params`);
      if (isTaskScopedNotification(notification.method)) {
        const threadId = optionalString(params.threadId);
        if (!threadId || (this.#loadedThreadId && threadId !== this.#loadedThreadId)) return;
      }
      let changedThread: ThreadSummary | undefined;
      switch (notification.method) {
        case "thread/started":
          changedThread = decodeThread(params.thread);
          this.#upsertThread(changedThread);
          break;
        case "turn/started":
          this.#applyTurnStarted(params);
          break;
        case "turn/completed":
          this.#applyTurnCompleted(params);
          break;
        case "thread/settings/updated":
          this.#applyThreadSettings(params);
          break;
        case "turn/diff/updated":
          this.#applyTurnDiff(params);
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
        case "item/fileChange/patchUpdated":
          this.#applyFileChangePatch(params);
          break;
        case "serverRequest/resolved":
          this.#resolveServerRequest(params.requestId);
          break;
        case "error":
          this.#applyError(params);
          break;
        case "thread/tokenUsage/updated":
          this.#applyTokenUsage(params);
          break;
        default:
          this.addDiagnostic(`unknown notification: ${notification.method}`);
          return;
      }
      const rawItem = typeof params.item === "object" && params.item !== null && !Array.isArray(params.item)
        ? params.item as Record<string, unknown>
        : undefined;
      const itemId = optionalString(rawItem?.id) ?? optionalString(params.itemId);
      const item = itemId ? this.#visibleItems.find((entry) => entry.id === itemId) : undefined;
      this.#emit("work.updated", {
        ...(changedThread ? { thread: changedThread } : {}),
        ...(item ? { item } : {}),
        ...(this.#loadedThreadId ? { loadedThreadId: this.#loadedThreadId } : {}),
        ...(this.#activeTurn ? { activeTurn: this.#activeTurn } : {}),
        ...(this.#tokenUsage ? { tokenUsage: this.#tokenUsage } : {}),
        pendingApprovals: this.#approvals.filter((approval) => approval.status === "pending"),
      });
    } catch (error) {
      this.addDiagnostic(
        `${notification.method}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  addApproval(request: JsonRpcServerRequest): PendingApproval {
    if (this.#approvalRequests.size >= MAX_PENDING_APPROVALS) {
      throw new Error("codexRejected: pending approval limit reached");
    }
    if (!fits(JSON.stringify(request.params), MAX_APPROVAL_REQUEST_BYTES)) {
      throw new Error("codexRejected: approval request is too large");
    }
    const params = record(request.params, `${request.method}.params`);
    const kind = approvalKind(request.method);
    const requestId = request.id;
    if (!fits(String(requestId), 512)) throw new Error("codexRejected: approval id is too large");
    const id = `approval:${String(requestId)}`;
    const available = Array.isArray(params.availableDecisions)
      ? params.availableDecisions
          .filter((value): value is string => typeof value === "string" && fits(value, 128))
          .slice(0, 20)
      : defaultApprovalDecisions(kind);
    const itemId = optionalString(params.itemId);
    const existingItem = itemId
      ? this.#visibleItems.find((item) => item.id === itemId)
      : undefined;
    const approval: PendingApproval = {
      id,
      kind,
      threadId: requiredBoundedString(params, "threadId", 512),
      turnId: requiredBoundedString(params, "turnId", 512),
      ...(itemId ? { itemId } : {}),
      ...(optionalString(params.reason) ? { reason: boundOldest(optionalString(params.reason) ?? "", MAX_METADATA_BYTES) } : {}),
      ...(optionalString(params.cwd) ? { cwd: boundOldest(optionalString(params.cwd) ?? "", MAX_METADATA_BYTES) } : {}),
      ...(optionalString(params.command) ? { command: boundOldest(optionalString(params.command) ?? "", MAX_METADATA_BYTES) } : {}),
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

  claimApproval(id: string, decision: string, deviceId = "browser"): ClaimedApproval {
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
    this.#approvalAudit.push({
      approvalId: id,
      decision,
      deviceId,
      threadId: approval.threadId,
      turnId: approval.turnId,
      timestamp: Date.now(),
    });
    this.#auditSink?.("approval", this.#approvalAudit.at(-1));
    if (this.#approvalAudit.length > MAX_APPROVAL_AUDIT) {
      this.#approvalAudit.splice(0, this.#approvalAudit.length - MAX_APPROVAL_AUDIT);
    }
    const claimed = {
      ...structuredClone(approval),
      requestId: request.id,
      method: request.method,
      params: record(request.params, `${request.method}.params`),
      decision,
    };
    this.#approvals = this.#approvals.filter((entry) => entry.id !== id);
    this.#emit("approval.resolved", {
      approval: {
        id: approval.id,
        decision,
        status: "resolved",
        threadId: approval.threadId,
        turnId: approval.turnId,
      },
    });
    return claimed;
  }

  interruptApprovals(): void {
    let changed = false;
    for (const approval of this.#approvals) {
      if (approval.status === "pending") {
        approval.status = "interrupted";
        changed = true;
      }
    }
    this.#approvalRequests.clear();
    this.#approvals = this.#approvals.filter((approval) => approval.status === "pending");
    if (changed) this.#emit("approvals.interrupted", { pendingApprovals: [] });
  }

  interruptActiveWork(): void {
    this.interruptApprovals();
    if (this.#activeTurn?.status === "inProgress") {
      this.#activeTurn.status = "interrupted";
      this.#emit("turn.interrupted", { snapshot: this.snapshot() });
    }
  }

  approvalAudit(): ApprovalAuditEntry[] {
    return structuredClone(this.#approvalAudit);
  }

  onEvent(listener: (event: BrowserEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  addDiagnostic(message: string): void {
    const bounded = boundNewest(message, MAX_DIAGNOSTIC_BYTES).value;
    this.#diagnostics.push(bounded);
    this.#auditSink?.("diagnostic", { message: bounded });
    if (this.#diagnostics.length > MAX_DIAGNOSTICS) {
      this.#diagnostics.splice(0, this.#diagnostics.length - MAX_DIAGNOSTICS);
    }
  }

  diagnostics(): string[] {
    return this.#diagnostics.slice();
  }

  threadWorkingDirectory(threadId: string): string {
    const cwd = this.#threads.find((thread) => thread.id === threadId)?.cwd;
    if (!cwd) throw new Error("invalidRequest: thread working directory is unavailable");
    return cwd;
  }

  isLoadedThread(threadId: string): boolean {
    return this.#loadedThreadId === threadId;
  }

  canAcceptDirectInput(threadId: string): boolean {
    return this.#loadedThreadId === threadId &&
      this.#threadAccess?.threadId === threadId &&
      this.#threadAccess.mode === "readWrite" &&
      this.#threads.find((thread) => thread.id === threadId)?.canAcceptDirectInput === true;
  }

  #upsertThread(thread: ThreadSummary): void {
    const bounded = boundThread(thread)[0];
    if (!bounded) return;
    this.#threads = [bounded, ...this.#threads.filter((entry) => entry.id !== bounded.id)].slice(0, MAX_CATALOG_ENTRIES);
  }

  #applyTurnStarted(params: Record<string, unknown>): void {
    const turn = record(params.turn, "turn/started.turn");
    const threadId = requiredString(params, "threadId");
    this.#loadedThreadId ??= threadId;
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
    if (this.#review?.threadId === threadId && this.#review.turnId === this.#activeTurn.id) {
      const terminal = this.#activeTurn.status === "inProgress"
        ? "completed"
        : this.#activeTurn.status;
      this.setReview({ ...this.#review, status: terminal });
    }
  }

  #applyThreadSettings(params: Record<string, unknown>): void {
    const threadId = requiredBoundedString(params, "threadId", 512);
    if (threadId !== this.#loadedThreadId) return;
    const settings = decodeThreadRuntime(params.threadSettings, threadId);
    if (!settings) throw new Error("compatibilityError: threadSettings.model");
    this.setThreadSettings(settings);
  }

  #applyTurnDiff(params: Record<string, unknown>): void {
    const threadId = requiredBoundedString(params, "threadId", 512);
    if (threadId !== this.#loadedThreadId) return;
    const turnId = requiredBoundedString(params, "turnId", 512);
    const diff = boundNewest(requiredString(params, "diff"), MAX_TURN_DIFF_BYTES);
    this.#turnDiff = {
      threadId,
      turnId,
      diff: diff.value,
      ...(diff.truncated ? { truncated: true } : {}),
    };
    this.#emit("turn.diff.updated", { turnDiff: this.#turnDiff });
  }

  #applyItem(params: Record<string, unknown>, completed: boolean): void {
    const item = record(params.item, "item");
    const id = requiredString(item, "id");
    const type = requiredString(item, "type");
    let visible: VisibleItem | undefined;
    if (type === "agentMessage") {
      const text = boundNewest(optionalString(item.text) ?? "", MAX_ITEM_BYTES);
      visible = {
        id,
        type: "message",
        role: "assistant",
        text: text.value,
        streaming: !completed,
        ...(text.truncated ? { truncated: true } : {}),
      };
    } else if (type === "userMessage") {
      const text = boundNewest(userMessageText(item.content), MAX_ITEM_BYTES);
      visible = {
        id,
        type: "message",
        role: "user",
        text: text.value,
        streaming: false,
        ...(text.truncated ? { truncated: true } : {}),
      };
    } else if (type === "commandExecution") {
      const status = normalizeItemStatus(optionalString(item.status), completed);
      const output = boundNewest(optionalString(item.aggregatedOutput) ?? "", MAX_ITEM_BYTES);
      visible = {
        id,
        type: "command",
        command: boundOldest(optionalString(item.command) ?? "Command", MAX_METADATA_BYTES),
        ...(optionalString(item.cwd) ? { cwd: boundOldest(optionalString(item.cwd) ?? "", MAX_METADATA_BYTES) } : {}),
        output: output.value,
        status,
        ...(output.truncated ? { truncated: true } : {}),
        ...(optionalNumber(item.exitCode) === undefined
          ? {}
          : { exitCode: optionalNumber(item.exitCode) }),
      };
    } else if (type === "fileChange") {
      const decoded = decodeHistoryItem(item);
      visible = decoded?.type === "fileChange"
        ? { ...decoded, status: normalizeItemStatus(optionalString(item.status), completed) }
        : undefined;
    } else if (type === "enteredReviewMode" || type === "exitedReviewMode") {
      const threadId = requiredBoundedString(params, "threadId", 512);
      const turnId = requiredBoundedString(params, "turnId", 512);
      const text = boundNewest(optionalString(item.review)
        ?? (type === "enteredReviewMode" ? "Reviewing changes" : "Review complete"), MAX_ITEM_BYTES);
      visible = {
        id,
        type: "status",
        text: text.value,
        tone: type === "enteredReviewMode" ? "neutral" : "success",
        ...(text.truncated ? { truncated: true } : {}),
      };
      if (threadId === this.#loadedThreadId) {
        this.setReview({
          threadId,
          turnId,
          status: type === "enteredReviewMode" ? "inProgress" : "completed",
        });
      }
    } else if (type === "reasoning" || type === "plan") {
      const summary = Array.isArray(item.summary)
        ? item.summary.filter((value): value is string => typeof value === "string").join("\n")
        : undefined;
      const text = boundNewest(optionalString(item.text) ?? summary ?? type, MAX_ITEM_BYTES);
      visible = {
        id,
        type: "status",
        text: text.value,
        ...(text.truncated ? { truncated: true } : {}),
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

  #applyFileChangePatch(params: Record<string, unknown>): void {
    const itemId = requiredString(params, "itemId");
    const changes = Array.isArray(params.changes) ? params.changes : [];
    const decoded = decodeHistoryItem({
      id: itemId,
      type: "fileChange",
      status: "inProgress",
      changes,
    });
    if (decoded?.type === "fileChange") {
      this.#replaceVisibleItem({ ...decoded, status: "running" });
    }
  }

  #resolveServerRequest(requestId: unknown): void {
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    const entry = [...this.#approvalRequests.entries()].find(([, request]) => request.id === requestId);
    if (!entry) return;
    const [id] = entry;
    this.#approvalRequests.delete(id);
    this.#approvals = this.#approvals.filter((approval) => approval.id !== id);
  }

  #applyError(params: Record<string, unknown>): void {
    const error = record(params.error, "error");
    const message = boundNewest(optionalString(error.message) ?? "Codex turn failed", MAX_DIAGNOSTIC_BYTES);
    const turnId = requiredString(params, "turnId");
    const threadId = requiredString(params, "threadId");
    this.#replaceVisibleItem({ id: `error:${turnId}`, type: "status", text: message.value, ...(message.truncated ? { truncated: true } : {}) });
    if (params.willRetry !== true) {
      this.#activeTurn = { id: turnId, threadId, status: "failed" };
    }
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
    this.#trimVisibleItems();
  }

  #trimVisibleItems(): void {
    while (visibleItemsBytes(this.#visibleItems) > MAX_VISIBLE_BYTES && this.#visibleItems.length > 1) {
      this.#visibleItems.shift();
    }
  }

  #emit(type: string, payload: unknown): void {
    this.#sequence += 1;
    const event: BrowserEvent = { kind: "event", sequence: this.#sequence, type, payload };
    // Events are fresh per emit and consumed synchronously; listeners treat
    // them as read-only, so they are dispatched without per-listener clones.
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

function isTaskScopedNotification(method: string): boolean {
  return method === "turn/started" ||
    method === "turn/completed" ||
    method === "thread/settings/updated" ||
    method === "turn/diff/updated" ||
    method === "item/started" ||
    method === "item/completed" ||
    method.startsWith("item/") ||
    method === "error" ||
    method === "thread/tokenUsage/updated";
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = optionalString(value[key]);
  if (result === undefined) throw new Error(`compatibilityError: ${key}`);
  return result;
}

function requiredBoundedString(value: Record<string, unknown>, key: string, maxBytes: number): string {
  const result = requiredString(value, key);
  if (!fits(result, maxBytes)) throw new Error(`compatibilityError: ${key}`);
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

function boundOldest(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (encoded[end] ?? 0) >> 6 === 0b10) end -= 1;
  return new TextDecoder().decode(encoded.slice(0, end));
}

function fits(value: string, maxBytes: number): boolean {
  return new TextEncoder().encode(value).byteLength <= maxBytes;
}

function boundThread(thread: ThreadSummary): ThreadSummary[] {
  if (!fits(thread.id, 512)) return [];
  return [{
    ...thread,
    title: boundOldest(thread.title, MAX_METADATA_BYTES),
    preview: boundOldest(thread.preview, MAX_METADATA_BYTES),
    ...(thread.cwd ? { cwd: boundOldest(thread.cwd, MAX_METADATA_BYTES) } : {}),
  }];
}

function visibleItemsBytes(items: VisibleItem[]): number {
  return new TextEncoder().encode(JSON.stringify(items)).byteLength;
}
