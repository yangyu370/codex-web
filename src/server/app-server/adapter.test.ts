import { describe, expect, test } from "bun:test";

import type { JsonRpcNotification, JsonRpcServerRequest } from "./json-rpc";
import { CodexAdapter, type RpcClient } from "./adapter";
import { decodeModelList, decodeThread } from "./decoders";
import { WebState } from "../service/state";

class ExpectedRpcClient implements RpcClient {
  #notification?: (notification: JsonRpcNotification) => void;
  #serverRequest?: (request: JsonRpcServerRequest) => void;
  readonly responses: Array<{ id: string | number; result: unknown }> = [];

  constructor(
    private readonly expectedMethod: string,
    private readonly result: unknown,
    private readonly expectedParams?: unknown,
  ) {}

  request(method: string, params: unknown): Promise<unknown> {
    if (method !== this.expectedMethod) {
      return Promise.reject(new Error(`unexpected method ${method}`));
    }
    if (
      this.expectedParams !== undefined &&
      JSON.stringify(params) !== JSON.stringify(this.expectedParams)
    ) {
      return Promise.reject(
        new Error(`unexpected params ${JSON.stringify(params)}`),
      );
    }
    return Promise.resolve(this.result);
  }

  respond(id: string | number, result: unknown): void {
    this.responses.push({ id, result });
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.#notification = listener;
    return () => undefined;
  }

  onServerRequest(listener: (request: JsonRpcServerRequest) => void): () => void {
    this.#serverRequest = listener;
    return () => undefined;
  }

  emitNotification(notification: JsonRpcNotification): void {
    this.#notification?.(notification);
  }

  emitServerRequest(request: JsonRpcServerRequest): void {
    this.#serverRequest?.(request);
  }
}

describe("tolerant decoders", () => {
  test("keeps required thread fields and tolerates newer fields", () => {
    expect(
      decodeThread({
        id: "t1",
        preview: "hello",
        name: "Web UI",
        createdAt: 10,
        updatedAt: 20,
        cwd: "/work/codex",
        status: { type: "idle" },
        futureField: true,
      }),
    ).toEqual({
      id: "t1",
      title: "Web UI",
      preview: "hello",
      createdAt: 10,
      updatedAt: 20,
      cwd: "/work/codex",
      status: "idle",
    });
  });

  test("normalizes the model list while ignoring hidden models", () => {
    expect(
      decodeModelList({
        data: [
          {
            id: "gpt-5.6",
            displayName: "GPT-5.6",
            description: "Frontier coding",
            hidden: false,
            isDefault: true,
            futureField: "ignored",
          },
          { id: "hidden", displayName: "Hidden", hidden: true },
        ],
      }),
    ).toEqual([
      {
        id: "gpt-5.6",
        displayName: "GPT-5.6",
        description: "Frontier coding",
        isDefault: true,
      },
    ]);
  });

  test("fails only the affected decode when a required field is missing", () => {
    expect(() => decodeThread({ preview: "missing id" })).toThrow(
      "compatibilityError: thread.id",
    );
  });
});

describe("WebState", () => {
  test("builds an assistant message from item start and deltas", () => {
    const state = new WebState("macos");
    state.applyNotification({
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn1",
        item: { type: "agentMessage", id: "item1", text: "" },
      },
    });
    state.applyNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "turn1", itemId: "item1", delta: "Hello" },
    });

    expect(state.snapshot().visibleItems).toEqual([
      {
        id: "item1",
        type: "message",
        role: "assistant",
        text: "Hello",
        streaming: true,
      },
    ]);
  });

  test("bounds command output and marks truncation explicitly", () => {
    const state = new WebState("macos");
    state.applyNotification({
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn1",
        item: {
          type: "commandExecution",
          id: "cmd1",
          command: "bun test",
          cwd: "/work",
          status: "inProgress",
          aggregatedOutput: null,
        },
      },
    });
    state.applyNotification({
      method: "item/commandExecution/outputDelta",
      params: { threadId: "t1", turnId: "turn1", itemId: "cmd1", delta: "x".repeat(300_000) },
    });

    const item = state.snapshot().visibleItems[0];
    expect(item).toMatchObject({ id: "cmd1", type: "command", truncated: true });
    expect(new TextEncoder().encode(item && "output" in item ? item.output : "").byteLength).toBe(
      262_144,
    );
  });

  test("claims an approval once and reports later decisions as already resolved", () => {
    const state = new WebState("windows");
    const approval = state.addApproval({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "t1",
        turnId: "turn1",
        itemId: "cmd1",
        command: "npm install",
        cwd: "C:\\work",
        availableDecisions: ["accept", "decline"],
      },
    });

    expect(state.claimApproval(approval.id, "accept")).toMatchObject({
      requestId: "approval-1",
      decision: "accept",
    });
    expect(() => state.claimApproval(approval.id, "decline")).toThrow("alreadyResolved");
  });
});

describe("CodexAdapter", () => {
  test("maps model/list into the shared model catalog", async () => {
    const rpc = new ExpectedRpcClient("model/list", {
      data: [
        {
          id: "gpt-5.6",
          displayName: "GPT-5.6",
          description: "Frontier coding",
          hidden: false,
          isDefault: true,
        },
      ],
    });
    const state = new WebState("macos");
    const adapter = new CodexAdapter(rpc, state);

    await expect(adapter.models()).resolves.toEqual([
      {
        id: "gpt-5.6",
        displayName: "GPT-5.6",
        description: "Frontier coding",
        isDefault: true,
      },
    ]);
    expect(state.snapshot().models).toHaveLength(1);
  });

  test("maps thread/list and returns normalized summaries", async () => {
    const rpc = new ExpectedRpcClient("thread/list", {
      data: [
        {
          id: "t1",
          preview: "Ship the web UI",
          createdAt: 10,
          updatedAt: 11,
          cwd: "/work",
          status: { type: "idle" },
        },
      ],
      nextCursor: null,
    });
    const state = new WebState("macos");
    const adapter = new CodexAdapter(rpc, state);

    await expect(adapter.listThreads()).resolves.toEqual({
      data: [
        {
          id: "t1",
          title: "Ship the web UI",
          preview: "Ship the web UI",
          createdAt: 10,
          updatedAt: 11,
          cwd: "/work",
          status: "idle",
        },
      ],
      nextCursor: null,
    });
    expect(state.snapshot().threads).toHaveLength(1);
  });

  test("responds to the original JSON-RPC id after atomically resolving approval", () => {
    const rpc = new ExpectedRpcClient("unused", {});
    const state = new WebState("macos");
    const adapter = new CodexAdapter(rpc, state);
    rpc.emitServerRequest({
      id: 9,
      method: "item/fileChange/requestApproval",
      params: { threadId: "t1", turnId: "turn1", itemId: "patch1" },
    });
    const approval = state.snapshot().pendingApprovals[0];
    if (!approval) throw new Error("approval missing");

    adapter.resolveApproval(approval.id, "accept");
    expect(rpc.responses).toEqual([{ id: 9, result: { decision: "accept" } }]);
  });

  test("validates a native directory before starting a thread", async () => {
    const rpc = new ExpectedRpcClient(
      "thread/start",
      {
        thread: {
          id: "t2",
          preview: "",
          createdAt: 30,
          updatedAt: 30,
          cwd: "/real/work",
          status: { type: "idle" },
          turns: [],
        },
      },
      { cwd: "/real/work", model: "gpt-5.6" },
    );
    const state = new WebState("macos");
    const adapter = new CodexAdapter(rpc, state, {
      validateWorkingDirectory: async () => ({
        displayPath: "/alias/work",
        resolvedPath: "/real/work",
      }),
    });

    await expect(
      adapter.startThread({ cwd: "/alias/work", model: "gpt-5.6" }),
    ).resolves.toMatchObject({ id: "t2", cwd: "/real/work" });
    expect(state.snapshot().loadedThreadId).toBe("t2");
  });

  test("loads reconstructed turns when resuming a thread", async () => {
    const rpc = new ExpectedRpcClient(
      "thread/resume",
      {
        thread: {
          id: "t1",
          preview: "Continue",
          createdAt: 1,
          updatedAt: 2,
          cwd: "/work",
          status: { type: "idle" },
          turns: [
            {
              id: "turn1",
              status: "completed",
              items: [
                {
                  type: "agentMessage",
                  id: "message1",
                  text: "Persisted answer",
                },
              ],
            },
          ],
        },
      },
      { threadId: "t1" },
    );
    const state = new WebState("macos");
    const adapter = new CodexAdapter(rpc, state);

    await adapter.resumeThread("t1");
    expect(state.snapshot().visibleItems).toEqual([
      {
        id: "message1",
        type: "message",
        role: "assistant",
        text: "Persisted answer",
        streaming: false,
      },
    ]);
  });

  test("reads durable thread history with includeTurns enabled", async () => {
    const rpc = new ExpectedRpcClient(
      "thread/read",
      {
        thread: {
          id: "t1",
          preview: "Read history",
          createdAt: 1,
          updatedAt: 2,
          cwd: "/work",
          status: { type: "idle" },
          turns: [],
        },
      },
      { threadId: "t1", includeTurns: true },
    );
    const state = new WebState("macos");
    const adapter = new CodexAdapter(rpc, state);

    await expect(adapter.readThread("t1")).resolves.toMatchObject({ id: "t1" });
    expect(state.snapshot().loadedThreadId).toBe("t1");
  });

  test("starts and interrupts a turn with exact app-server params", async () => {
    const startRpc = new ExpectedRpcClient(
      "turn/start",
      { turn: { id: "turn2", status: "inProgress", items: [] } },
      {
        threadId: "t1",
        input: [{ type: "text", text: "Run tests" }],
      },
    );
    const state = new WebState("macos");
    const startAdapter = new CodexAdapter(startRpc, state);
    await expect(startAdapter.startTurn("t1", "Run tests")).resolves.toEqual({
      id: "turn2",
      threadId: "t1",
      status: "inProgress",
    });

    const interruptRpc = new ExpectedRpcClient(
      "turn/interrupt",
      {},
      { threadId: "t1", turnId: "turn2" },
    );
    const interruptAdapter = new CodexAdapter(interruptRpc, state);
    await expect(interruptAdapter.interruptTurn("t1", "turn2")).resolves.toEqual({});
  });
});
