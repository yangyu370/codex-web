import { createHash, randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import path from "node:path";

import type { JsonRpcTransport } from "./json-rpc";

const DEFAULT_MAX_PAYLOAD_BYTES = 8_388_608;
const MAX_UPGRADE_BYTES = 16_384;
const WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface UnixWebSocketTransportOptions {
  maxPayloadBytes?: number;
}

export function connectUnixWebSocket(
  socketPath: string,
  options: UnixWebSocketTransportOptions = {},
): Promise<JsonRpcTransport> {
  if (!path.posix.isAbsolute(socketPath)) {
    return Promise.reject(new Error("Unix WebSocket path must be absolute"));
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const key = randomBytes(16).toString("base64");
    let upgradeBuffer = Buffer.alloc(0);
    let settled = false;

    const failUpgrade = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.once("error", failUpgrade);
    socket.once("close", () => failUpgrade(new Error("WebSocket upgrade connection closed")));
    socket.once("connect", () => {
      socket.write([
        "GET / HTTP/1.1",
        "Host: localhost",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", function handleUpgrade(chunk) {
      if (settled) return;
      upgradeBuffer = Buffer.concat([
        upgradeBuffer,
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      ]);
      const headerEnd = upgradeBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (upgradeBuffer.byteLength > MAX_UPGRADE_BYTES) {
          failUpgrade(new Error("WebSocket upgrade response exceeded 16384 bytes"));
        }
        return;
      }
      if (headerEnd > MAX_UPGRADE_BYTES) {
        failUpgrade(new Error("WebSocket upgrade response exceeded 16384 bytes"));
        return;
      }
      const header = upgradeBuffer.subarray(0, headerEnd).toString("latin1");
      const remainder = upgradeBuffer.subarray(headerEnd + 4);
      try {
        validateUpgrade(header, key);
      } catch (error) {
        failUpgrade(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      settled = true;
      socket.off("error", failUpgrade);
      socket.off("data", handleUpgrade);
      const transport = createWebSocketTransport(
        socket,
        options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      );
      if (remainder.byteLength > 0) transport.receive(remainder);
      resolve(transport.value);
    });
  });
}

function validateUpgrade(header: string, key: string): void {
  const lines = header.split("\r\n");
  if (!/^HTTP\/1\.[01] 101(?: |$)/.test(lines[0] ?? "")) {
    throw new Error("WebSocket server rejected the HTTP upgrade");
  }
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  if (headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new Error("WebSocket upgrade header is missing");
  }
  if (!headers.get("connection")?.toLowerCase().split(/\s*,\s*/).includes("upgrade")) {
    throw new Error("WebSocket connection upgrade token is missing");
  }
  const expected = createHash("sha1").update(`${key}${WEB_SOCKET_GUID}`).digest("base64");
  if (headers.get("sec-websocket-accept") !== expected) {
    throw new Error("WebSocket upgrade accept key is invalid");
  }
}

function createWebSocketTransport(
  socket: Socket,
  maxPayloadBytes: number,
): { value: JsonRpcTransport; receive(chunk: Buffer): void } {
  const messageListeners = new Set<(source: string) => void>();
  const closeListeners = new Set<(reason?: Error) => void>();
  let terminal = false;
  let buffer = Buffer.alloc(0);
  let fragmentedChunks: Buffer[] | undefined;
  let fragmentedBytes = 0;

  const finish = (reason?: Error): void => {
    if (terminal) return;
    terminal = true;
    for (const listener of closeListeners) listener(reason);
  };
  const protocolFailure = (message: string, code = 1002): void => {
    if (terminal) return;
    finish(new Error(message));
    try {
      socket.write(encodeClientFrame(0x8, closePayload(code, message)));
    } finally {
      socket.end();
    }
  };
  const emitText = (payload: Buffer): void => {
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    } catch {
      protocolFailure("WebSocket text message is not valid UTF-8", 1007);
      return;
    }
    for (const listener of messageListeners) listener(source);
  };
  const receive = (chunk: Buffer): void => {
    if (terminal) return;
    buffer = Buffer.concat([buffer, chunk]);
    while (!terminal) {
      const frame = readFrame(buffer, maxPayloadBytes);
      if (!frame) return;
      if (frame.error) {
        protocolFailure(frame.error, frame.error === "Max payload size exceeded" ? 1009 : 1002);
        return;
      }
      buffer = buffer.subarray(frame.bytes);
      const { fin, opcode, payload } = frame;
      if (payload.byteLength > maxPayloadBytes) {
        protocolFailure("Max payload size exceeded", 1009);
        return;
      }
      if (opcode >= 0x8 && (!fin || payload.byteLength > 125)) {
        protocolFailure("Malformed WebSocket control frame");
        return;
      }
      if (opcode === 0x8) {
        const code = payload.byteLength >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.byteLength > 2 ? payload.subarray(2).toString("utf8") : "";
        try { socket.write(encodeClientFrame(0x8, payload)); } catch {}
        finish(new Error(`WebSocket closed (${code})${reason ? `: ${reason}` : ""}`));
        socket.end();
      } else if (opcode === 0x9) {
        socket.write(encodeClientFrame(0xa, payload));
      } else if (opcode === 0xa) {
        continue;
      } else if (opcode === 0x2) {
        protocolFailure("WebSocket binary messages are not supported", 1003);
      } else if (opcode === 0x1) {
        if (fragmentedChunks) {
          protocolFailure("Received a new WebSocket data frame during fragmentation");
          return;
        }
        if (fin) {
          emitText(payload);
        } else {
          fragmentedChunks = [payload];
          fragmentedBytes = payload.byteLength;
        }
      } else if (opcode === 0x0) {
        if (!fragmentedChunks) {
          protocolFailure("Received an unexpected WebSocket continuation frame");
          return;
        }
        fragmentedChunks.push(payload);
        fragmentedBytes += payload.byteLength;
        if (fragmentedBytes > maxPayloadBytes) {
          protocolFailure("Max payload size exceeded", 1009);
          return;
        }
        if (fin) {
          const complete = Buffer.concat(fragmentedChunks, fragmentedBytes);
          fragmentedChunks = undefined;
          fragmentedBytes = 0;
          emitText(complete);
        }
      } else {
        protocolFailure("Unsupported WebSocket opcode");
      }
    }
  };

  socket.on("data", receive);
  socket.on("error", (error) => finish(error));
  socket.on("close", () => finish(new Error("WebSocket connection closed")));

  return {
    receive,
    value: {
      send(source) {
        if (terminal) return Promise.reject(new Error("app-server transport is closed"));
        const payload = Buffer.from(source, "utf8");
        if (payload.byteLength > maxPayloadBytes) {
          return Promise.reject(new Error("Max payload size exceeded"));
        }
        return writeFrame(socket, encodeClientFrame(0x1, payload));
      },
      close() {
        if (terminal) return;
        terminal = true;
        const frame = encodeClientFrame(0x8, closePayload(1000, "client shutdown"));
        void writeFrame(socket, frame).finally(() => socket.end());
      },
      onMessage(listener) {
        messageListeners.add(listener);
        return () => messageListeners.delete(listener);
      },
      onClose(listener) {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
    },
  };
}

type FrameResult =
  | { error: string; bytes: 0; fin: false; opcode: 0; payload: Buffer }
  | { bytes: number; fin: boolean; opcode: number; payload: Buffer; error?: undefined };

function readFrame(source: Buffer, maxPayloadBytes: number): FrameResult | undefined {
  if (source.byteLength < 2) return undefined;
  const first = source[0] ?? 0;
  const second = source[1] ?? 0;
  if ((first & 0x70) !== 0) return frameError("WebSocket extensions are not supported");
  if ((second & 0x80) !== 0) return frameError("Server WebSocket frames must not be masked");
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  let headerBytes = 2;
  let payloadBytes = second & 0x7f;
  if (payloadBytes === 126) {
    if (source.byteLength < 4) return undefined;
    payloadBytes = source.readUInt16BE(2);
    headerBytes = 4;
  } else if (payloadBytes === 127) {
    if (source.byteLength < 10) return undefined;
    const value = source.readBigUInt64BE(2);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return frameError("WebSocket frame is too large");
    payloadBytes = Number(value);
    headerBytes = 10;
  }
  if (payloadBytes > maxPayloadBytes) return frameError("Max payload size exceeded");
  if (source.byteLength < headerBytes + payloadBytes) return undefined;
  return {
    bytes: headerBytes + payloadBytes,
    fin,
    opcode,
    payload: source.subarray(headerBytes, headerBytes + payloadBytes),
  };
}

function frameError(error: string): FrameResult {
  return { error, bytes: 0, fin: false, opcode: 0, payload: Buffer.alloc(0) };
}

function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const extended = payload.byteLength <= 125 ? 0 : payload.byteLength <= 65_535 ? 2 : 8;
  const frame = Buffer.alloc(2 + extended + 4 + payload.byteLength);
  frame[0] = 0x80 | opcode;
  if (extended === 0) {
    frame[1] = 0x80 | payload.byteLength;
  } else if (extended === 2) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payload.byteLength, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  }
  const maskOffset = 2 + extended;
  mask.copy(frame, maskOffset);
  for (let index = 0; index < payload.byteLength; index += 1) {
    frame[maskOffset + 4 + index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  return frame;
}

function closePayload(code: number, reason: string): Buffer {
  const text = Buffer.from(reason.slice(0, 123), "utf8").subarray(0, 123);
  const payload = Buffer.alloc(2 + text.byteLength);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return payload;
}

function writeFrame(socket: Socket, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      socket.write(frame, (error) => error ? reject(error) : resolve());
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
