import type {
  BrowserEvent,
  BrowserMethod,
  BrowserResponse,
  BrowserSnapshot,
  ServerMessage,
} from "../shared/protocol";
import { createClientStore } from "./store";

export interface SocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(value: string): void;
  close(): void;
}

export interface CodexWebClientOptions {
  reconnectDelays?: number[];
  requestTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "closed";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export class CodexWebClient {
  readonly store;
  readonly #factory: (url: string) => SocketLike;
  readonly #options: Required<CodexWebClientOptions>;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #connectionListeners = new Set<(status: ConnectionStatus) => void>();
  #socket?: SocketLike;
  #nextRequestId = 1;
  #reconnectAttempt = 0;
  #closed = false;
  #connectionStatus: ConnectionStatus = "closed";

  constructor(
    initialSnapshot: BrowserSnapshot,
    factory: (url: string) => SocketLike = (url) =>
      new WebSocket(toWebSocketUrl(url)) as unknown as SocketLike,
    options: CodexWebClientOptions = {},
  ) {
    this.store = createClientStore(initialSnapshot);
    this.#factory = factory;
    this.#options = {
      reconnectDelays: options.reconnectDelays ?? [250, 1_000, 4_000, 10_000],
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
      sleep: options.sleep ?? sleep,
    };
  }

  connect(): void {
    this.#closed = false;
    this.#setConnection("connecting");
    const sequence = this.getSnapshot().sequence;
    const socket = this.#factory(`/ws?after=${sequence}`);
    this.#socket = socket;
    socket.onopen = () => {
      this.#reconnectAttempt = 0;
      this.#setConnection("connected");
    };
    socket.onmessage = (event) => this.#receive(event.data);
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (socket !== this.#socket) return;
      this.#socket = undefined;
      this.#rejectPending(new Error("interrupted: connection closed"));
      if (!this.#closed) {
        this.#setConnection("reconnecting");
        void this.#reconnect();
      }
    };
  }

  close(): void {
    this.#closed = true;
    this.#socket?.close();
    this.#socket = undefined;
    this.#rejectPending(new Error("interrupted: connection closed"));
    this.#setConnection("closed");
  }

  getSnapshot(): BrowserSnapshot {
    return this.store.getState().snapshot;
  }

  subscribe(listener: (snapshot: BrowserSnapshot) => void): () => void {
    return this.store.subscribe((state) => listener(state.snapshot));
  }

  connectionStatus(): ConnectionStatus {
    return this.#connectionStatus;
  }

  subscribeConnection(listener: (status: ConnectionStatus) => void): () => void {
    this.#connectionListeners.add(listener);
    return () => this.#connectionListeners.delete(listener);
  }

  request(method: BrowserMethod, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(new Error("notReady: WebSocket is not connected"));
    }
    const id = `web-${this.#nextRequestId}`;
    this.#nextRequestId += 1;
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(new Error("interrupted: request timed out"));
      }, this.#options.requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
    });
    socket.send(JSON.stringify({ kind: "request", id, method, params }));
    return response;
  }

  #receive(source: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(source) as ServerMessage;
    } catch {
      return;
    }
    if (message.kind === "response") {
      this.#settle(message);
      return;
    }
    if (message.kind === "snapshot") {
      this.store.getState().setSnapshot(message);
      return;
    }
    if (message.kind === "event") {
      this.#applyEvent(message);
    }
  }

  #settle(message: BrowserResponse): void {
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
    } else {
      pending.resolve(message.result);
    }
  }

  #applyEvent(event: BrowserEvent): void {
    const current = this.getSnapshot();
    const payload = isRecord(event.payload) ? event.payload : {};
    if (isSnapshot(payload.snapshot)) {
      this.store.getState().setSnapshot({ ...payload.snapshot, sequence: event.sequence });
      return;
    }
    let next: BrowserSnapshot = { ...current, sequence: event.sequence };
    if (event.type === "models.updated" && Array.isArray(payload.models)) {
      next = { ...next, models: payload.models as BrowserSnapshot["models"] };
    } else if (event.type === "threads.updated" && Array.isArray(payload.threads)) {
      next = { ...next, threads: payload.threads as BrowserSnapshot["threads"] };
    } else if (event.type === "thread.updated" && isRecord(payload.thread)) {
      const thread = payload.thread as unknown as BrowserSnapshot["threads"][number];
      next = {
        ...next,
        threads: [thread, ...next.threads.filter((entry) => entry.id !== thread.id)],
      };
    } else if (event.type === "thread.loaded") {
      const threadId = typeof payload.threadId === "string" ? payload.threadId : undefined;
      const items = Array.isArray(payload.items)
        ? (payload.items as BrowserSnapshot["visibleItems"])
        : [];
      next = { ...next, ...(threadId ? { loadedThreadId: threadId } : {}), visibleItems: items };
    } else if (event.type === "service.updated" && isRecord(event.payload)) {
      next = { ...next, service: event.payload as unknown as BrowserSnapshot["service"] };
    } else if (event.type === "approval.pending" && isRecord(payload.approval)) {
      const approval = payload.approval as unknown as BrowserSnapshot["pendingApprovals"][number];
      next = {
        ...next,
        pendingApprovals: [
          ...next.pendingApprovals.filter((entry) => entry.id !== approval.id),
          approval,
        ],
      };
    } else if (event.type === "approval.resolved" && isRecord(payload.approval)) {
      const id = typeof payload.approval.id === "string" ? payload.approval.id : "";
      next = {
        ...next,
        pendingApprovals: next.pendingApprovals.filter((entry) => entry.id !== id),
      };
    } else if (event.type === "approvals.interrupted") {
      next = { ...next, pendingApprovals: [] };
    } else if (event.type === "work.updated") {
      const item = isRecord(payload.item)
        ? payload.item as unknown as BrowserSnapshot["visibleItems"][number]
        : undefined;
      const thread = isRecord(payload.thread)
        ? payload.thread as unknown as BrowserSnapshot["threads"][number]
        : undefined;
      next = {
        ...next,
        ...(typeof payload.loadedThreadId === "string" ? { loadedThreadId: payload.loadedThreadId } : {}),
        ...(isRecord(payload.activeTurn) ? { activeTurn: payload.activeTurn as unknown as NonNullable<BrowserSnapshot["activeTurn"]> } : {}),
        ...(isRecord(payload.tokenUsage) ? { tokenUsage: payload.tokenUsage as unknown as NonNullable<BrowserSnapshot["tokenUsage"]> } : {}),
        ...(Array.isArray(payload.pendingApprovals) ? { pendingApprovals: payload.pendingApprovals as BrowserSnapshot["pendingApprovals"] } : {}),
        ...(item ? { visibleItems: [...next.visibleItems.filter((entry) => entry.id !== item.id), item] } : {}),
        ...(thread ? { threads: [thread, ...next.threads.filter((entry) => entry.id !== thread.id)] } : {}),
      };
    }
    this.store.getState().setSnapshot(next);
  }

  async #reconnect(): Promise<void> {
    const delays = this.#options.reconnectDelays;
    const delay =
      delays[Math.min(this.#reconnectAttempt, delays.length - 1)] ??
      delays.at(-1) ??
      10_000;
    this.#reconnectAttempt += 1;
    await this.#options.sleep(delay);
    if (!this.#closed && !this.#socket) this.connect();
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #setConnection(status: ConnectionStatus): void {
    if (status === this.#connectionStatus) return;
    this.#connectionStatus = status;
    for (const listener of this.#connectionListeners) listener(status);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSnapshot(value: unknown): value is BrowserSnapshot {
  return isRecord(value) && value.kind === "snapshot";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function toWebSocketUrl(path: string): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
