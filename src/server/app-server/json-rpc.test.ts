import { describe, expect, test } from "bun:test";

import {
  JsonRpcPeer,
  JsonRpcResponseError,
  type JsonRpcServerRequest,
  type JsonRpcTransport,
} from "./json-rpc";

class MemoryJsonRpcTransport implements JsonRpcTransport {
  readonly outbound: string[] = [];
  readonly #messageListeners = new Set<(source: string) => void>();
  readonly #closeListeners = new Set<(reason?: Error) => void>();

  send(source: string): void {
    this.outbound.push(source);
  }

  close(): void {
    this.emitClose();
  }

  onMessage(listener: (source: string) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener: (reason?: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  receive(source: string): void {
    for (const listener of this.#messageListeners) listener(source);
  }

  emitClose(reason?: Error): void {
    for (const listener of this.#closeListeners) listener(reason);
  }
}

function peerHarness() {
  const transport = new MemoryJsonRpcTransport();
  const peer = new JsonRpcPeer(transport);
  return {
    peer,
    outbound: transport.outbound,
    async send(value: unknown) {
      transport.receive(JSON.stringify(value));
    },
    async sendRaw(value: string) {
      transport.receive(value);
    },
    async close() {
      transport.emitClose(new Error("test transport closed"));
    },
  };
}

describe("JsonRpcPeer", () => {
  test("times out bounded adapter requests", async () => {
    const transport = new MemoryJsonRpcTransport();
    const peer = new JsonRpcPeer(transport, { requestTimeoutMs: 1 });

    await expect(peer.request("model/list", {})).rejects.toThrow("timed out");
    transport.emitClose();
  });

  test("rejects overload before writing beyond the in-flight limit", async () => {
    const transport = new MemoryJsonRpcTransport();
    const peer = new JsonRpcPeer(transport, { maxPendingRequests: 1 });

    const first = peer.request("thread/list", {});
    await expect(peer.request("model/list", {})).rejects.toMatchObject({ code: -32001 });
    expect(transport.outbound).toHaveLength(1);
    peer.close();
    await expect(first).rejects.toThrow("transport closed");
  });

  test("correlates responses while forwarding notifications", async () => {
    const harness = peerHarness();
    const notifications: unknown[] = [];
    harness.peer.onNotification((notification) => notifications.push(notification));

    const result = harness.peer.request("model/list", {});
    expect(JSON.parse(harness.outbound[0] ?? "null")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "model/list",
      params: {},
    });
    await harness.send({
      jsonrpc: "2.0",
      method: "thread/started",
      params: { thread: { id: "t1" } },
    });
    await harness.send({ jsonrpc: "2.0", id: 1, result: { data: [] } });

    expect(await result).toEqual({ data: [] });
    expect(notifications).toEqual([
      { method: "thread/started", params: { thread: { id: "t1" } } },
    ]);
    await harness.close();
  });

  test("preserves bounded JSON-RPC error metadata for compatibility classification", async () => {
    const harness = peerHarness();
    const response = harness.peer.request("model/list", {});
    await harness.send({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found", data: { field: "model/list" } },
    });

    await expect(response).rejects.toMatchObject({
      name: "JsonRpcResponseError",
      code: -32601,
      message: "Method not found",
      data: { field: "model/list" },
    } satisfies Partial<JsonRpcResponseError>);
  });

  test("surfaces server-initiated approval requests and writes responses", async () => {
    const harness = peerHarness();
    let received: JsonRpcServerRequest | undefined;
    harness.peer.onServerRequest((request) => {
      received = request;
    });

    await harness.send({
      jsonrpc: "2.0",
      id: "approval-1",
      method: "item/fileChange/requestApproval",
      params: { threadId: "t1", turnId: "turn1" },
    });
    await Bun.sleep(0);
    expect(received).toEqual({
      id: "approval-1",
      method: "item/fileChange/requestApproval",
      params: { threadId: "t1", turnId: "turn1" },
    });

    harness.peer.respond("approval-1", { decision: "accept" });
    expect(JSON.parse(harness.outbound.at(-1) ?? "null")).toEqual({
      jsonrpc: "2.0",
      id: "approval-1",
      result: { decision: "accept" },
    });
    await harness.close();
  });

  test("records malformed messages and continues with the next message", async () => {
    const harness = peerHarness();
    const errors: string[] = [];
    harness.peer.onProtocolError((error) => errors.push(error.message));
    const result = harness.peer.request("model/list", {});

    await harness.sendRaw("not-json");
    await harness.send({ jsonrpc: "2.0", id: 1, result: { data: ["ok"] } });

    expect(await result).toEqual({ data: ["ok"] });
    expect(errors).toEqual(["malformed JSON-RPC message"]);
    await harness.close();
  });

  test("rejects outstanding requests when the transport closes", async () => {
    const harness = peerHarness();
    const result = harness.peer.request("thread/list", {});
    await harness.close();
    await expect(result).rejects.toThrow("test transport closed");
  });
});
