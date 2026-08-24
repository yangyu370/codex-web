import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { WebSocketServer } from "ws";

import {
  connectTcpWebSocket,
  parseManagedLoopbackEndpoint,
} from "./tcp-websocket-transport";

const closeTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeTasks.splice(0).map((close) => close()));
});

describe("parseManagedLoopbackEndpoint", () => {
  test.each([
    ["ws://127.0.0.1:4500", "ws://127.0.0.1:4500/"],
    ["ws://[::1]:4500", "ws://[::1]:4500/"],
  ])("accepts literal loopback endpoint %s", (source, expected) => {
    expect(parseManagedLoopbackEndpoint(source).href).toBe(expected);
  });

  test.each([
    "http://127.0.0.1:4500",
    "wss://127.0.0.1:4500",
    "ws://localhost:4500",
    "ws://0.0.0.0:4500",
    "ws://user@127.0.0.1:4500",
    "ws://127.0.0.1:4500/native",
    "ws://127.0.0.1:4500/?token=x",
    "ws://127.0.0.1:4500/#fragment",
    "ws://127.0.0.1",
    "ws://127.0.0.1:0",
  ])("rejects unsafe managed endpoint %s", (source) => {
    expect(() => parseManagedLoopbackEndpoint(source)).toThrow();
  });
});

describe("connectTcpWebSocket", () => {
  test("exchanges complete JSON-RPC text messages", async () => {
    const server = await websocketServer();
    server.wss.on("connection", (socket) => {
      socket.on("message", (data, isBinary) => {
        expect(isBinary).toBe(false);
        socket.send(data.toString());
      });
    });
    const transport = await connectTcpWebSocket(server.endpoint);
    const received = new Promise<string>((resolve) => transport.onMessage(resolve));

    await transport.send('{"jsonrpc":"2.0","id":1}');

    expect(await received).toBe('{"jsonrpc":"2.0","id":1}');
    transport.close();
  });

  test("rejects binary messages and reports one terminal reason", async () => {
    const server = await websocketServer();
    server.wss.on("connection", (socket) => socket.send(Buffer.from([1, 2, 3])));
    const transport = await connectTcpWebSocket(server.endpoint);
    const reasons: string[] = [];
    const closed = new Promise<void>((resolve) => transport.onClose((reason) => {
      reasons.push(reason?.message ?? "closed");
      resolve();
    }));

    await closed;
    await Bun.sleep(5);

    expect(reasons).toEqual(["WebSocket binary messages are not supported"]);
  });

  test("enforces the native message payload bound", async () => {
    const server = await websocketServer();
    server.wss.on("connection", (socket) => socket.send("oversized"));
    const transport = await connectTcpWebSocket(server.endpoint, { maxPayloadBytes: 4 });
    const reason = await new Promise<Error | undefined>((resolve) => transport.onClose(resolve));

    expect(reason?.message).toContain("Max payload size exceeded");
  });

  test("rejects sends beyond the configured backpressure budget", async () => {
    const server = await websocketServer();
    const transport = await connectTcpWebSocket(server.endpoint, { maxBufferedBytes: 0 });

    await expect(transport.send("x")).rejects.toThrow("backpressure");
    transport.close();
  });

  test("times out a TCP server that never completes the upgrade", async () => {
    const server = createServer(() => undefined);
    const endpoint = await listen(server);
    closeTasks.push(() => closeNetServer(server));

    await expect(connectTcpWebSocket(endpoint, { handshakeTimeoutMs: 10 }))
      .rejects.toThrow(/timed out|timeout/i);
  });
});

async function websocketServer(): Promise<{
  wss: WebSocketServer;
  endpoint: string;
}> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  const address = wss.address();
  if (typeof address === "string" || address === null) throw new Error("missing TCP address");
  closeTasks.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));
  return { wss, endpoint: `ws://127.0.0.1:${address.port}` };
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("missing TCP address");
  return `ws://127.0.0.1:${address.port}`;
}

function closeNetServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
