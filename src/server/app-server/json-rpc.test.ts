import { describe, expect, test } from "bun:test";

import { JsonRpcPeer, type JsonRpcServerRequest } from "./json-rpc";

function peerHarness() {
  const inbound = new TransformStream<Uint8Array, Uint8Array>();
  const writer = inbound.writable.getWriter();
  const outbound: string[] = [];
  const peer = new JsonRpcPeer(inbound.readable, {
    write(data) {
      outbound.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      return data.length;
    },
    end() {},
  });
  return {
    peer,
    outbound,
    async send(value: unknown) {
      await writer.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
    },
    async sendRaw(value: string) {
      await writer.write(new TextEncoder().encode(value));
    },
    async close() {
      await writer.close();
    },
  };
}

describe("JsonRpcPeer", () => {
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

  test("records malformed lines and continues with the next message", async () => {
    const harness = peerHarness();
    const errors: string[] = [];
    harness.peer.onProtocolError((error) => errors.push(error.message));
    const result = harness.peer.request("model/list", {});

    await harness.sendRaw("not-json\n");
    await harness.send({ jsonrpc: "2.0", id: 1, result: { data: ["ok"] } });

    expect(await result).toEqual({ data: ["ok"] });
    expect(errors).toEqual(["malformed JSON-RPC line"]);
    await harness.close();
  });

  test("rejects outstanding requests when stdout closes", async () => {
    const harness = peerHarness();
    const result = harness.peer.request("thread/list", {});
    await harness.close();
    await expect(result).rejects.toThrow("app-server stdout closed");
  });
});
