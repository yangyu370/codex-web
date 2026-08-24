import { describe, expect, test } from "bun:test";

import type { BrowserSnapshot } from "../shared/protocol";
import { CodexWebClient, type SocketLike } from "./websocket";

const snapshot: BrowserSnapshot = {
  kind: "snapshot",
  protocolVersion: 2,
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
  test("rejects a request whose correlated response never arrives", async () => {
    const socket = new FakeSocket();
    const client = new CodexWebClient(snapshot, () => socket, { requestTimeoutMs: 5 });
    client.connect();
    socket.open();

    const outcome = await Promise.race([
      client.request("directory.list", {}).then(
        () => "resolved",
        (error: unknown) => error instanceof Error ? error.message : String(error),
      ),
      Bun.sleep(25).then(() => "still-pending"),
    ]);

    expect(outcome).toBe("interrupted: request timed out");
  });

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
    const connectionStates: string[] = [];
    client.subscribeConnection((status) => connectionStates.push(status));
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
    expect(connectionStates).toEqual(["connecting", "connected", "reconnecting", "connecting"]);
  });

  test("removes stale approval cards when native work is interrupted", () => {
    const socket = new FakeSocket();
    const client = new CodexWebClient({
      ...snapshot,
      pendingApprovals: [{
        id: "a1",
        kind: "command",
        threadId: "t1",
        turnId: "turn1",
        availableDecisions: ["accept"],
        status: "pending",
      }],
    }, () => socket);
    client.connect();
    socket.open();
    socket.receive({ kind: "event", sequence: 5, type: "approvals.interrupted", payload: { pendingApprovals: [] } });

    expect(client.getSnapshot().pendingApprovals).toEqual([]);
  });

  test("applies task capability events and lets authoritative snapshots clear them", () => {
    const socket = new FakeSocket();
    const client = new CodexWebClient(snapshot, () => socket);
    client.connect();
    socket.open();
    const settings = {
      threadId: "t1",
      model: "gpt-5.6",
      effort: "high",
      approvalPolicy: "on-request",
      sandbox: "workspaceWrite",
    };
    const turnDiff = { threadId: "t1", turnId: "turn1", diff: "+change" };
    const review = { threadId: "t1", turnId: "review1", status: "inProgress" };
    const profiles = [{ id: ":workspace", allowed: true }];

    socket.receive({
      kind: "event",
      sequence: 7,
      type: "thread.settings.updated",
      payload: { threadSettings: settings },
    });
    socket.receive({
      kind: "event",
      sequence: 8,
      type: "turn.diff.updated",
      payload: { turnDiff },
    });
    socket.receive({
      kind: "event",
      sequence: 9,
      type: "review.updated",
      payload: { review },
    });
    socket.receive({
      kind: "event",
      sequence: 10,
      type: "permissionProfiles.updated",
      payload: { permissionProfiles: profiles },
    });

    expect(client.getSnapshot()).toMatchObject({
      sequence: 10,
      threadSettings: settings,
      turnDiff,
      review,
      permissionProfiles: profiles,
    });

    socket.receive({ ...snapshot, sequence: 11 });
    expect(client.getSnapshot()).not.toHaveProperty("threadSettings");
    expect(client.getSnapshot()).not.toHaveProperty("turnDiff");
    expect(client.getSnapshot()).not.toHaveProperty("review");
  });

  test("projects thread access from loaded and access-only events", () => {
    const socket = new FakeSocket();
    const client = new CodexWebClient(snapshot, () => socket);
    client.connect();
    socket.open();

    socket.receive({
      kind: "event",
      sequence: 20,
      type: "thread.loaded",
      payload: {
        threadId: "t1",
        items: [],
        threadAccess: { threadId: "t1", mode: "historyOnly", reason: "activeWriter" },
      },
    });
    expect(client.getSnapshot().threadAccess).toEqual({
      threadId: "t1",
      mode: "historyOnly",
      reason: "activeWriter",
    });

    socket.receive({
      kind: "event",
      sequence: 21,
      type: "thread.access.updated",
      payload: { threadAccess: { threadId: "t1", mode: "readWrite" } },
    });
    expect(client.getSnapshot().threadAccess).toEqual({ threadId: "t1", mode: "readWrite" });
  });

  test("ignores replayed events at or behind the authoritative sequence", () => {
    const socket = new FakeSocket();
    const client = new CodexWebClient({ ...snapshot, sequence: 7 }, () => socket);
    client.connect();
    socket.open();

    socket.receive({
      kind: "event",
      sequence: 7,
      type: "review.updated",
      payload: {
        review: { threadId: "t1", turnId: "stale", status: "inProgress" },
      },
    });

    expect(client.getSnapshot()).not.toHaveProperty("review");
    expect(client.getSnapshot().sequence).toBe(7);
  });

  test("restores or clears authoritative active work when a thread is reloaded", () => {
    const socket = new FakeSocket();
    const client = new CodexWebClient(snapshot, () => socket);
    client.connect();
    socket.open();

    socket.receive({
      kind: "event",
      sequence: 12,
      type: "thread.loaded",
      payload: {
        threadId: "t1",
        items: [],
        activeTurn: { id: "turn1", threadId: "t1", status: "inProgress" },
      },
    });
    expect(client.getSnapshot().activeTurn).toEqual({ id: "turn1", threadId: "t1", status: "inProgress" });

    socket.receive({
      kind: "event",
      sequence: 13,
      type: "thread.loaded",
      payload: { threadId: "t1", items: [] },
    });
    expect(client.getSnapshot()).not.toHaveProperty("activeTurn");
  });
});
