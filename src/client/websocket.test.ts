import { describe, expect, test } from "bun:test";

import type { BrowserSnapshot } from "../shared/protocol";
import { CodexWebClient, type SocketLike } from "./websocket";

const snapshot: BrowserSnapshot = {
  kind: "snapshot",
  sequence: 4,
  service: { status: "ready", platform: "macos" },
  models: [],
  threads: [],
  visibleItems: [],
  pendingApprovals: [],
};

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

describe("CodexWebClient", () => {
  test("correlates requests and applies authoritative snapshots", async () => {
    const socket = new FakeSocket();
    const client = new CodexWebClient(snapshot, () => socket);
    client.connect();
    socket.open();

    const response = client.request("model.list", {});
    const request = JSON.parse(socket.sent[0] ?? "null");
    expect(request).toMatchObject({ kind: "request", method: "model.list", params: {} });
    socket.receive({ kind: "response", id: request.id, result: [{ id: "m1" }] });
    await expect(response).resolves.toEqual([{ id: "m1" }]);

    socket.receive({
      ...snapshot,
      sequence: 8,
      visibleItems: [
        { id: "a1", type: "message", role: "assistant", text: "Streaming now" },
      ],
    });
    expect(client.getSnapshot().sequence).toBe(8);
    expect(client.getSnapshot().visibleItems[0]).toMatchObject({ text: "Streaming now" });
  });

  test("reconnects from the latest sequence without replaying pending requests", async () => {
    const sockets: FakeSocket[] = [];
    const urls: string[] = [];
    const client = new CodexWebClient(
      snapshot,
      (url) => {
        urls.push(url);
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      { reconnectDelays: [0] },
    );
    client.connect();
    const firstSocket = sockets[0];
    if (!firstSocket) throw new Error("first socket missing");
    firstSocket.open();
    const pending = client.request("thread.list", {});
    firstSocket.close();
    await expect(pending).rejects.toThrow("interrupted");
    await Bun.sleep(1);
    expect(urls).toEqual(["/ws?after=4", "/ws?after=4"]);
    expect(sockets[1]?.sent).toEqual([]);
  });
});
