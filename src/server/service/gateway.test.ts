import { describe, expect, test } from "bun:test";

import type { BrowserRequest, ServerMessage } from "../../shared/protocol";
import { WebState } from "./state";
import { BrowserGateway, type BrowserActions } from "./gateway";

function actions(overrides: Partial<BrowserActions> = {}): BrowserActions {
  return {
    listDirectory: async () => ({
      current: { name: "work", path: "/work" },
      roots: [{ name: "Home", path: "/work" }],
      directories: [],
      truncated: false,
    }),
    models: async () => [],
    permissionProfiles: async () => [],
    listThreads: async () => ({ data: [], nextCursor: null }),
    startThread: async () => ({ id: "t1" }),
    openThread: async () => ({ id: "t1" }),
    resumeThread: async () => ({ id: "t1" }),
    readThread: async () => ({ id: "t1" }),
    startTurn: async () => ({ id: "turn1", threadId: "t1", status: "inProgress" }),
    updateThreadSettings: async () => ({}),
    startReview: async () => ({ threadId: "t1", turnId: "review1", status: "inProgress" }),
    interruptTurn: async () => ({}),
    resolveApproval: () => undefined,
    ...overrides,
  };
}

function request(method: BrowserRequest["method"], params: Record<string, unknown> = {}): string {
  return JSON.stringify({ kind: "request", id: "r1", method, params });
}

describe("BrowserGateway", () => {
  test("sends a bounded snapshot on a fresh connection", () => {
    const state = new WebState("macos");
    const gateway = new BrowserGateway(state, actions());
    const sent: ServerMessage[] = [];

    gateway.connect((message) => sent.push(message));
    expect(sent).toEqual([state.snapshot()]);
  });

  test("dispatches correlated browser requests", async () => {
    const state = new WebState("macos");
    const gateway = new BrowserGateway(
      state,
      actions({
        listThreads: async () => ({
          data: [
            {
              id: "t1",
              title: "Task",
              preview: "Task",
              createdAt: 1,
              updatedAt: 2,
            },
          ],
          nextCursor: null,
        }),
      }),
    );
    const sent: ServerMessage[] = [];

    await gateway.handleMessage(request("thread.list"), (message) => sent.push(message));
    expect(sent).toEqual([
      {
        kind: "response",
        id: "r1",
        result: {
          data: [
            {
              id: "t1",
              title: "Task",
              preview: "Task",
              createdAt: 1,
              updatedAt: 2,
            },
          ],
          nextCursor: null,
        },
      },
    ]);
  });

  test("dispatches thread.open to the server-owned access policy", async () => {
    const state = new WebState("windows");
    const calls: string[] = [];
    const gateway = new BrowserGateway(state, actions({
      openThread: async (threadId) => { calls.push(threadId); return { id: threadId }; },
    }));
    const sent: ServerMessage[] = [];

    await gateway.handleMessage(request("thread.open", { threadId: "thread-1" }), (message) => sent.push(message));

    expect(calls).toEqual(["thread-1"]);
    expect(sent).toEqual([{ kind: "response", id: "r1", result: { id: "thread-1" } }]);
  });

  test("lists directories from the Codex host with an optional server path", async () => {
    const state = new WebState("macos");
    const browserActions = {
      ...actions(),
      listDirectory: async (directory?: string) => ({
        current: { name: "projects", path: directory ?? "/srv/projects" },
        roots: [{ name: "Projects", path: "/srv/projects" }],
        directories: [{ name: "codex", path: "/srv/projects/codex" }],
        truncated: false,
      }),
    };
    const gateway = new BrowserGateway(state, browserActions);
    const sent: ServerMessage[] = [];

    await gateway.handleMessage(
      JSON.stringify({
        kind: "request",
        id: "directory-1",
        method: "directory.list",
        params: { path: "/srv/projects" },
      }),
      (message) => sent.push(message),
    );

    expect(sent).toEqual([{
      kind: "response",
      id: "directory-1",
      result: {
        current: { name: "projects", path: "/srv/projects" },
        roots: [{ name: "Projects", path: "/srv/projects" }],
        directories: [{ name: "codex", path: "/srv/projects/codex" }],
        truncated: false,
      },
    }]);
  });

  test("returns safe typed errors with a diagnostic id", async () => {
    const state = new WebState("macos");
    const gateway = new BrowserGateway(state, actions());
    const sent: ServerMessage[] = [];

    await gateway.handleMessage(request("turn.start", {}), (message) => sent.push(message));

    expect(sent[0]).toMatchObject({
      kind: "response",
      id: "r1",
      error: {
        code: "invalidRequest",
        message: "The request is invalid.",
        retryable: false,
        diagnosticId: expect.any(String),
      },
    });
  });

  test("passes only an optional opaque attachment session id to turn start", async () => {
    const state = new WebState("macos");
    makeWritable(state, "t1");
    const calls: unknown[] = [];
    const gateway = new BrowserGateway(state, actions({
      startTurn: async (...args) => { calls.push(args); return { id: "turn1" }; },
    }));
    const sent: ServerMessage[] = [];

    await gateway.handleMessage(request("turn.start", {
      threadId: "t1",
      text: "Review these",
      attachmentSessionId: "11111111-1111-4111-8111-111111111111",
      model: "gpt-5.6",
      effort: "high",
      permissionProfile: ":workspace",
      paths: ["/must/not/pass"],
    }), (message) => sent.push(message));

    expect(calls).toEqual([[
      "t1",
      "Review these",
      "11111111-1111-4111-8111-111111111111",
      {
        model: "gpt-5.6",
        effort: "high",
        permissionProfile: ":workspace",
      },
    ]]);
    expect(sent[0]).toMatchObject({ kind: "response", id: "r1", result: { id: "turn1" } });
  });

  test("dispatches bounded task settings and inline review actions", async () => {
    const state = new WebState("macos");
    makeWritable(state, "t1");
    const calls: unknown[] = [];
    const gateway = new BrowserGateway(state, actions({
      updateThreadSettings: async (...args) => { calls.push(["settings", ...args]); return {}; },
      startReview: async (...args) => { calls.push(["review", ...args]); return {}; },
    }));
    const sent: ServerMessage[] = [];

    await gateway.handleMessage(request("thread.settings.update", {
      threadId: "t1",
      effort: "high",
      permissionProfile: ":workspace",
    }), (message) => sent.push(message));
    await gateway.handleMessage(request("review.start", { threadId: "t1" }), (message) => {
      sent.push(message);
    });

    expect(calls).toEqual([
      ["settings", "t1", { effort: "high", permissionProfile: ":workspace" }],
      ["review", "t1"],
    ]);
    expect(sent).toHaveLength(2);
  });

  test("rejects empty or oversized task setting updates", async () => {
    const state = new WebState("macos");
    makeWritable(state, "t1");
    const calls: unknown[] = [];
    const gateway = new BrowserGateway(state, actions({
      updateThreadSettings: async (...args) => { calls.push(args); return {}; },
    }));
    const sent: ServerMessage[] = [];

    await gateway.handleMessage(request("thread.settings.update", {
      threadId: "t1",
    }), (message) => sent.push(message));
    await gateway.handleMessage(request("thread.settings.update", {
      threadId: "t1",
      effort: "x".repeat(513),
    }), (message) => sent.push(message));

    expect(calls).toEqual([]);
    expect(sent).toHaveLength(2);
    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "response", error: expect.objectContaining({ code: "invalidRequest" }) }),
    ]));
  });

  test("rejects mutations for unloaded or history-only tasks", async () => {
    const state = new WebState("macos");
    state.setThreads([{
      id: "history",
      title: "Desktop history",
      preview: "",
      createdAt: 1,
      updatedAt: 1,
      canAcceptDirectInput: false,
    }]);
    state.loadThread("history", []);
    state.setThreadAccess({
      threadId: "history",
      mode: "historyOnly",
      reason: "activeWriter",
    });
    const approval = state.addApproval({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "history", turnId: "turn-1", itemId: "command-1" },
    });
    const calls: unknown[] = [];
    const gateway = new BrowserGateway(state, actions({
      startTurn: async (...args) => { calls.push(["turn", ...args]); return {}; },
      updateThreadSettings: async (...args) => { calls.push(["settings", ...args]); return {}; },
      startReview: async (...args) => { calls.push(["review", ...args]); return {}; },
      resolveApproval: (...args) => { calls.push(["approval", ...args]); },
    }));
    const sent: ServerMessage[] = [];

    await gateway.handleMessage(request("turn.start", { threadId: "history", text: "Continue" }), (message) => sent.push(message));
    await gateway.handleMessage(request("thread.settings.update", { threadId: "history", effort: "high" }), (message) => sent.push(message));
    await gateway.handleMessage(request("review.start", { threadId: "other" }), (message) => sent.push(message));
    await gateway.handleMessage(request("approval.resolve", {
      approvalId: approval.id,
      decision: "accept",
    }), (message) => sent.push(message));

    expect(calls).toEqual([]);
    expect(sent).toHaveLength(4);
    expect(sent.every((message) => message.kind === "response" && message.error?.code === "invalidRequest")).toBe(true);
  });

  test("interrupts only the authoritative active turn", async () => {
    const state = new WebState("macos");
    makeWritable(state, "t1");
    state.applyNotification({
      method: "turn/started",
      params: { threadId: "t1", turn: { id: "turn1", status: "inProgress" } },
    });
    const calls: unknown[] = [];
    const gateway = new BrowserGateway(state, actions({
      interruptTurn: async (...args) => { calls.push(args); return {}; },
    }));
    const sent: ServerMessage[] = [];

    await gateway.handleMessage(request("turn.interrupt", { threadId: "t1", turnId: "other" }), (message) => sent.push(message));
    await gateway.handleMessage(request("turn.interrupt", { threadId: "t1", turnId: "turn1" }), (message) => sent.push(message));

    expect(calls).toEqual([["t1", "turn1"]]);
    expect(sent[0]).toMatchObject({ kind: "response", error: { code: "invalidRequest" } });
    expect(sent[1]).toMatchObject({ kind: "response", result: {} });
  });

  test("single-flights review and rejects review while a turn is active", async () => {
    const state = new WebState("macos");
    makeWritable(state, "t1");
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const gateway = new BrowserGateway(state, actions({
      startReview: async () => { calls += 1; await pending; return {}; },
    }));
    const sent: ServerMessage[] = [];

    const first = gateway.handleMessage(request("review.start", { threadId: "t1" }), (message) => sent.push(message));
    await Bun.sleep(0);
    const second = gateway.handleMessage(request("review.start", { threadId: "t1" }), (message) => sent.push(message));
    await Bun.sleep(0);
    const callsBeforeRelease = calls;
    release();
    await Promise.all([first, second]);

    expect(callsBeforeRelease).toBe(1);
    expect(sent.some((message) => message.kind === "response" && message.error?.code === "invalidRequest")).toBe(true);

    state.applyNotification({
      method: "turn/started",
      params: { threadId: "t1", turn: { id: "turn1", status: "inProgress" } },
    });
    await gateway.handleMessage(request("review.start", { threadId: "t1" }), (message) => sent.push(message));
    expect(calls).toBe(1);
  });

  test("reports browser connection count changes once per connection", () => {
    const state = new WebState("macos");
    const counts: number[] = [];
    const gateway = new BrowserGateway(state, actions(), {
      onConnectionCountChanged: (count) => counts.push(count),
    });
    const disconnectOne = gateway.connect(() => undefined);
    const disconnectTwo = gateway.connect(() => undefined);

    disconnectOne();
    disconnectOne();
    disconnectTwo();

    expect(counts).toEqual([1, 2, 1, 0]);
  });

  test("replays retained events and falls back to a snapshot after expiry", () => {
    const state = new WebState("macos");
    const gateway = new BrowserGateway(state, actions(), {
      maxEvents: 2,
      maxBytes: 1_000_000,
    });
    state.setModels([{ id: "m1", displayName: "One" }]);
    const firstSequence = state.snapshot().sequence;
    state.setModels([{ id: "m2", displayName: "Two" }]);

    const replayed: ServerMessage[] = [];
    gateway.connect((message) => replayed.push(message), firstSequence);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ kind: "event", sequence: firstSequence + 1 });

    state.setModels([{ id: "m3", displayName: "Three" }]);
    state.setModels([{ id: "m4", displayName: "Four" }]);
    const expired: ServerMessage[] = [];
    gateway.connect((message) => expired.push(message), firstSequence);
    expect(expired).toEqual([state.snapshot()]);
  });

  test("falls back to a snapshot when an oversized event creates a replay gap", () => {
    const state = new WebState("macos");
    const gateway = new BrowserGateway(state, actions(), { maxBytes: 200 });
    state.setModels([{ id: "small", displayName: "Small" }]);
    const beforeOversized = state.snapshot().sequence;
    state.setModels([{ id: "large", displayName: "x".repeat(1_000) }]);
    const sent: ServerMessage[] = [];

    gateway.connect((message) => sent.push(message), beforeOversized);

    expect(sent).toEqual([state.snapshot()]);
  });

  test("returns alreadyResolved to the second approval decision", async () => {
    const state = new WebState("windows");
    makeWritable(state, "t1");
    const approval = state.addApproval({
      id: 9,
      method: "item/fileChange/requestApproval",
      params: { threadId: "t1", turnId: "turn1", itemId: "patch1" },
    });
    const gateway = new BrowserGateway(
      state,
      actions({
        resolveApproval: (id, decision, deviceId) => {
          state.claimApproval(id, decision, deviceId);
        },
      }),
    );
    const first: ServerMessage[] = [];
    const second: ServerMessage[] = [];
    const message = request("approval.resolve", {
      approvalId: approval.id,
      decision: "accept",
    });

    await gateway.handleMessage(message, (value) => first.push(value), "device-one");
    await gateway.handleMessage(message, (value) => second.push(value), "device-two");
    expect(first.at(-1)).toMatchObject({ kind: "response", result: {} });
    expect(second.at(-1)).toMatchObject({
      kind: "response",
      error: { code: "alreadyResolved" },
    });
    expect(state.approvalAudit()[0]?.deviceId).toBe("device-one");
  });
});

function makeWritable(state: WebState, threadId: string): void {
  state.setThreads([{
    id: threadId,
    title: "Writable task",
    preview: "",
    createdAt: 1,
    updatedAt: 1,
    canAcceptDirectInput: true,
  }]);
  state.loadThread(threadId, []);
  state.setThreadAccess({ threadId, mode: "readWrite" });
}
