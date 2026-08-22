import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

import { connectUnixWebSocket } from "./unix-websocket-transport";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("connectUnixWebSocket", () => {
  test("upgrades over a Unix socket and exchanges text messages", async () => {
    const harness = await unixWebSocketServer();
    const transportPromise = connectUnixWebSocket(harness.socketPath);
    const serverSocket = await harness.connection;
    const transport = await transportPromise;

    expect(harness.upgrade()).toMatchObject({ url: "/", upgrade: "websocket" });

    const outbound = new Promise<{ source: string; binary: boolean }>((resolve) => {
      serverSocket.once("message", (data, binary) => resolve({
        source: data.toString(),
        binary,
      }));
    });
    await transport.send('{"id":1}');
    await expect(outbound).resolves.toEqual({ source: '{"id":1}', binary: false });

    const inbound = new Promise<string>((resolve) => transport.onMessage(resolve));
    serverSocket.send('{"method":"ready"}');
    await expect(inbound).resolves.toBe('{"method":"ready"}');
    transport.close();
  });

  test("answers server pings with pong", async () => {
    const harness = await unixWebSocketServer();
    const transportPromise = connectUnixWebSocket(harness.socketPath);
    const serverSocket = await harness.connection;
    const transport = await transportPromise;
    const pong = new Promise<Buffer>((resolve) => serverSocket.once("pong", resolve));

    serverSocket.ping("health");

    expect((await pong).toString()).toBe("health");
    transport.close();
  });

  test("rejects binary frames and reports one terminal reason", async () => {
    const harness = await unixWebSocketServer();
    const transportPromise = connectUnixWebSocket(harness.socketPath);
    const serverSocket = await harness.connection;
    const transport = await transportPromise;
    const reasons: string[] = [];
    transport.onClose((reason) => reasons.push(reason?.message ?? "closed"));

    serverSocket.send(Buffer.from("binary"), { binary: true });
    await waitFor(() => reasons.length === 1);

    expect(reasons).toEqual(["WebSocket binary messages are not supported"]);
    await Bun.sleep(5);
    expect(reasons).toHaveLength(1);
  });

  test("enforces the configured payload bound", async () => {
    const harness = await unixWebSocketServer();
    const transportPromise = connectUnixWebSocket(harness.socketPath, { maxPayloadBytes: 16 });
    const serverSocket = await harness.connection;
    const transport = await transportPromise;
    const reasons: string[] = [];
    transport.onClose((reason) => reasons.push(reason?.message ?? "closed"));

    serverSocket.send("x".repeat(17));
    await waitFor(() => reasons.length === 1);

    expect(reasons[0]).toContain("Max payload size exceeded");
  });

  test("forwards remote close exactly once", async () => {
    const harness = await unixWebSocketServer();
    const transportPromise = connectUnixWebSocket(harness.socketPath);
    const serverSocket = await harness.connection;
    const transport = await transportPromise;
    const reasons: string[] = [];
    transport.onClose((reason) => reasons.push(reason?.message ?? "closed"));

    serverSocket.close(1000, "done");
    await waitFor(() => reasons.length === 1);

    expect(reasons).toEqual(["WebSocket closed (1000): done"]);
    await Bun.sleep(5);
    expect(reasons).toHaveLength(1);
  });

  test("times out a socket that never completes the HTTP upgrade", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-web-ws-timeout-"));
    const socketPath = path.join(directory, "app-server.sock");
    const server = createServer();
    server.on("upgrade", (_request, socket) => {
      cleanups.push(async () => { socket.destroy(); });
    });
    await listen(server, socketPath);
    cleanups.push(async () => {
      server.closeAllConnections();
      server.close();
      await rm(directory, { recursive: true, force: true });
    });

    await expect(connectUnixWebSocket(socketPath, { handshakeTimeoutMs: 5 }))
      .rejects.toThrow("WebSocket upgrade timed out");
  });
});

async function unixWebSocketServer(): Promise<{
  socketPath: string;
  connection: Promise<WebSocket>;
  upgrade(): { url?: string; upgrade?: string } | undefined;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-web-ws-"));
  const socketPath = path.join(directory, "app-server.sock");
  const server = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true });
  let upgrade: { url?: string; upgrade?: string } | undefined;
  let resolveConnection: (socket: WebSocket) => void = () => undefined;
  const connection = new Promise<WebSocket>((resolve) => {
    resolveConnection = resolve;
  });
  server.on("upgrade", (request, socket, head) => {
    upgrade = { url: request.url, upgrade: request.headers.upgrade };
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
      resolveConnection(webSocket);
    });
  });
  await listen(server, socketPath);
  cleanups.push(async () => {
    for (const client of webSocketServer.clients) client.terminate();
    webSocketServer.close();
    server.closeAllConnections();
    server.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { socketPath, connection, upgrade: () => upgrade };
}

function listen(server: Server, socketPath: string): Promise<AddressInfo | string | null> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(server.address()));
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("condition not reached");
}
