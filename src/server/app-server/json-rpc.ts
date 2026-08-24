export interface JsonRpcServerRequest {
  id: string | number;
  method: string;
  params: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface JsonRpcPeerOptions {
  requestTimeoutMs?: number;
  maxPendingRequests?: number;
}

export interface JsonRpcTransport {
  send(source: string): void | Promise<void>;
  close(): void;
  onMessage(listener: (source: string) => void): () => void;
  onClose(listener: (reason?: Error) => void): () => void;
}

const MAX_ERROR_DATA_BYTES = 16_384;
const MAX_ERROR_MESSAGE_BYTES = 4_096;

export class JsonRpcResponseError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcResponseError";
  }
}

export class JsonRpcPeer {
  readonly #transport: JsonRpcTransport;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #notificationListeners = new Set<
    (notification: JsonRpcNotification) => void
  >();
  readonly #serverRequestListeners = new Set<
    (request: JsonRpcServerRequest) => void
  >();
  readonly #protocolErrorListeners = new Set<(error: Error) => void>();
  #nextRequestId = 1;
  #closed = false;
  readonly #requestTimeoutMs: number;
  readonly #maxPendingRequests: number;
  readonly #unsubscribeMessage: () => void;
  readonly #unsubscribeClose: () => void;

  constructor(
    transport: JsonRpcTransport,
    options: JsonRpcPeerOptions = {},
  ) {
    this.#transport = transport;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#maxPendingRequests = options.maxPendingRequests ?? 128;
    this.#unsubscribeMessage = transport.onMessage((source) => this.#handleMessage(source));
    this.#unsubscribeClose = transport.onClose((reason) => {
      this.#handleTransportClose(reason ?? new Error("app-server transport closed"));
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error("app-server transport is closed"));
    }
    if (this.#pending.size >= this.#maxPendingRequests) {
      return Promise.reject(new JsonRpcResponseError(-32001, "app-server request limit reached"));
    }
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(new Error(`app-server request ${method} timed out`));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
    });
    this.#write({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  notify(method: string, params?: unknown): void {
    this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: string | number, result: unknown): void {
    this.#write({ jsonrpc: "2.0", id, result });
  }

  respondError(
    id: string | number,
    error: { code: number; message: string; data?: unknown },
  ): void {
    this.#write({ jsonrpc: "2.0", id, error });
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  onServerRequest(listener: (request: JsonRpcServerRequest) => void): () => void {
    this.#serverRequestListeners.add(listener);
    return () => this.#serverRequestListeners.delete(listener);
  }

  onProtocolError(listener: (error: Error) => void): () => void {
    this.#protocolErrorListeners.add(listener);
    return () => this.#protocolErrorListeners.delete(listener);
  }

  close(reason = new Error("app-server transport closed")): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#unsubscribeMessage();
    this.#unsubscribeClose();
    this.#rejectPending(reason);
    this.#transport.close();
  }

  #write(message: unknown): void {
    if (this.#closed) return;
    try {
      const send = this.#transport.send(JSON.stringify(message));
      if (send instanceof Promise) {
        void send.catch((error: unknown) => {
          this.close(error instanceof Error ? error : new Error(String(error)));
        });
      }
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #handleTransportClose(reason: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeMessage();
    this.#unsubscribeClose();
    this.#rejectPending(reason);
  }

  #handleMessage(source: string): void {
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      this.#emitProtocolError(new Error("malformed JSON-RPC message"));
      return;
    }
    if (!isRecord(value)) {
      this.#emitProtocolError(new Error("invalid JSON-RPC envelope"));
      return;
    }

    if ((typeof value.id === "number" || typeof value.id === "string") && "method" in value) {
      if (typeof value.method !== "string") {
        this.#emitProtocolError(new Error("invalid JSON-RPC envelope"));
        return;
      }
      const request = { id: value.id, method: value.method, params: value.params ?? {} };
      for (const listener of this.#serverRequestListeners) {
        listener(request);
      }
      return;
    }

    if (typeof value.id === "number" && ("result" in value || "error" in value)) {
      const pending = this.#pending.get(value.id);
      if (!pending) {
        this.#emitProtocolError(new Error(`unknown JSON-RPC response id ${value.id}`));
        return;
      }
      this.#pending.delete(value.id);
      clearTimeout(pending.timeout);
      if ("error" in value) {
        pending.reject(jsonRpcResponseError(value.error));
      } else {
        pending.resolve(value.result);
      }
      return;
    }

    if (typeof value.method === "string" && !("id" in value)) {
      const notification = { method: value.method, params: value.params ?? {} };
      for (const listener of this.#notificationListeners) {
        listener(notification);
      }
      return;
    }

    this.#emitProtocolError(new Error("invalid JSON-RPC envelope"));
  }

  #emitProtocolError(error: Error): void {
    for (const listener of this.#protocolErrorListeners) {
      listener(error);
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRpcResponseError(value: unknown): JsonRpcResponseError {
  if (!isRecord(value)) return new JsonRpcResponseError(-32_000, "app-server rejected request");
  const code = typeof value.code === "number" ? value.code : -32_000;
  const message = boundedErrorMessage(
    typeof value.message === "string" ? value.message : "app-server rejected request",
  );
  return new JsonRpcResponseError(code, message, boundedErrorData(value.data));
}

function boundedErrorMessage(value: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= MAX_ERROR_MESSAGE_BYTES) return value;
  let result = "";
  for (const character of value) {
    if (encoder.encode(result + character).byteLength > MAX_ERROR_MESSAGE_BYTES) break;
    result += character;
  }
  return result;
}

function boundedErrorData(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_ERROR_DATA_BYTES
      ? value
      : { truncated: true };
  } catch {
    return undefined;
  }
}
