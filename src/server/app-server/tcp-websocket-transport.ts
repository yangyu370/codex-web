import { WebSocket, type RawData } from "ws";

import type { JsonRpcTransport } from "./json-rpc";

const DEFAULT_MAX_PAYLOAD_BYTES = 8_388_608;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFERED_BYTES = 1_048_576;

export interface TcpWebSocketTransportOptions {
  maxPayloadBytes?: number;
  handshakeTimeoutMs?: number;
  maxBufferedBytes?: number;
}

export function parseManagedLoopbackEndpoint(source: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(source);
  } catch {
    throw new Error("managed app-server endpoint must be a valid URL");
  }
  if (endpoint.protocol !== "ws:") {
    throw new Error("managed app-server endpoint must use ws");
  }
  if (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "[::1]") {
    throw new Error("managed app-server endpoint must use a literal loopback address");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("managed app-server endpoint must not contain credentials");
  }
  if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("managed app-server endpoint must use the root path without query or fragment");
  }
  const port = Number(endpoint.port);
  if (!endpoint.port || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("managed app-server endpoint must contain a valid TCP port");
  }
  return endpoint;
}

export function connectTcpWebSocket(
  source: string,
  options: TcpWebSocketTransportOptions = {},
): Promise<JsonRpcTransport> {
  const endpoint = parseManagedLoopbackEndpoint(source);
  const maxPayloadBytes = boundedPositive(
    options.maxPayloadBytes,
    DEFAULT_MAX_PAYLOAD_BYTES,
    DEFAULT_MAX_PAYLOAD_BYTES,
  );
  const handshakeTimeoutMs = boundedPositive(
    options.handshakeTimeoutMs,
    DEFAULT_HANDSHAKE_TIMEOUT_MS,
    60_000,
  );
  const maxBufferedBytes = boundedNonNegative(
    options.maxBufferedBytes,
    DEFAULT_MAX_BUFFERED_BYTES,
    DEFAULT_MAX_PAYLOAD_BYTES,
  );

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint.href, {
      handshakeTimeout: handshakeTimeoutMs,
      maxPayload: maxPayloadBytes,
      perMessageDeflate: false,
    });
    const messageListeners = new Set<(source: string) => void>();
    const closeListeners = new Set<(reason?: Error) => void>();
    let opened = false;
    let terminal = false;
    let terminalReason: Error | undefined;
    const handshakeTimer = setTimeout(() => {
      const error = new Error(`WebSocket upgrade timed out after ${handshakeTimeoutMs}ms`);
      failBeforeOpen(error);
      socket.terminate();
    }, handshakeTimeoutMs);
    handshakeTimer.unref();

    const finish = (reason?: Error): void => {
      if (terminal) return;
      clearTimeout(handshakeTimer);
      terminal = true;
      terminalReason = reason;
      for (const listener of closeListeners) listener(reason);
      messageListeners.clear();
      closeListeners.clear();
    };
    const failBeforeOpen = (error: Error): void => {
      if (opened || terminal) return;
      clearTimeout(handshakeTimer);
      terminal = true;
      terminalReason = error;
      reject(error);
    };

    socket.once("open", () => {
      if (terminal) return;
      clearTimeout(handshakeTimer);
      opened = true;
      resolve({
        send(payload) {
          if (terminal || socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error("app-server transport is closed"));
          }
          const bytes = Buffer.byteLength(payload, "utf8");
          if (bytes > maxPayloadBytes) {
            return Promise.reject(new Error("Max payload size exceeded"));
          }
          if (socket.bufferedAmount + bytes > maxBufferedBytes) {
            return Promise.reject(new Error("app-server transport backpressure limit reached"));
          }
          return new Promise<void>((resolveSend, rejectSend) => {
            socket.send(payload, (error) => error ? rejectSend(error) : resolveSend());
          });
        },
        close() {
          if (terminal) return;
          terminal = true;
          terminalReason = new Error("WebSocket client shutdown");
          socket.close(1000, "client shutdown");
          messageListeners.clear();
          closeListeners.clear();
        },
        onMessage(listener) {
          if (!terminal) messageListeners.add(listener);
          return () => messageListeners.delete(listener);
        },
        onClose(listener) {
          if (terminal) {
            queueMicrotask(() => listener(terminalReason));
            return () => undefined;
          }
          closeListeners.add(listener);
          return () => closeListeners.delete(listener);
        },
      });
    });

    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (terminal) return;
      if (isBinary) {
        const error = new Error("WebSocket binary messages are not supported");
        finish(error);
        socket.close(1003, "binary messages are not supported");
        return;
      }
      const source = rawDataToString(data);
      if (Buffer.byteLength(source, "utf8") > maxPayloadBytes) {
        const error = new Error("Max payload size exceeded");
        finish(error);
        socket.close(1009, "message too large");
        return;
      }
      for (const listener of messageListeners) listener(source);
    });
    socket.on("error", (error) => {
      if (!opened) {
        failBeforeOpen(error);
      } else {
        finish(error);
      }
    });
    socket.on("close", (code, reason) => {
      const suffix = reason.byteLength > 0 ? `: ${reason.toString("utf8")}` : "";
      const error = terminalReason ?? new Error(`WebSocket closed (${code})${suffix}`);
      if (!opened) {
        failBeforeOpen(error);
      } else {
        finish(error);
      }
    });
  });
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function boundedPositive(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) return 1;
  return Math.min(value, maximum);
}

function boundedNonNegative(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, maximum);
}
