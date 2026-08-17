import { describe, expect, test } from "bun:test";

import type { BrowserRequest, ServerMessage } from "../../shared/protocol";
import { WebState } from "./state";
import { BrowserGateway, type BrowserActions } from "./gateway";

function actions(overrides: Partial<BrowserActions> = {}): BrowserActions {
  return {
    models: async () => [],
    listThreads: async () => ({ data: [], nextCursor: null }),
    startThread: async () => ({ id: "t1" }),
    resumeThread: async () => ({ id: "t1" }),
    readThread: async () => ({ id: "t1" }),
    startTurn: async () => ({ id: "turn1", threadId: "t1", status: "inProgress" }),
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
