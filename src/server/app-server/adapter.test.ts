import { describe, expect, test } from "bun:test";

import type { JsonRpcNotification, JsonRpcServerRequest } from "./json-rpc";
import { CodexAdapter, type RpcClient } from "./adapter";
import { decodeHistoryItem, decodeModelList, decodeThread } from "./decoders";
import { WebState } from "../service/state";

class ExpectedRpcClient implements RpcClient {
  #notification?: (notification: JsonRpcNotification) => void;
  #serverRequest?: (request: JsonRpcServerRequest) => void;
  #protocolError?: (error: Error) => void;
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
    return this.result instanceof Error ? Promise.reject(this.result) : Promise.resolve(this.result);
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

  onProtocolError(listener: (error: Error) => void): () => void {
    this.#protocolError = listener;
    return () => undefined;
  }

  emitNotification(notification: JsonRpcNotification): void {
    this.#notification?.(notification);
  }

  emitServerRequest(request: JsonRpcServerRequest): void {
    this.#serverRequest?.(request);
  }

  emitProtocolError(error: Error): void {
    this.#protocolError?.(error);
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

  test("bounds oversized content reconstructed from durable history", () => {
    const item = decodeHistoryItem({
      id: "history-command",
      type: "commandExecution",
      command: "build",
      aggregatedOutput: `old${"x".repeat(300_000)}new`,
      status: "completed",
    });

    expect(item).toMatchObject({ type: "command", truncated: true });
    if (item?.type !== "command") throw new Error("command item missing");
    expect(new TextEncoder().encode(item.output).byteLength).toBeLessThanOrEqual(262_144);
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

  test("bounds oversized content present in an initial item notification", () => {
    const state = new WebState("windows");
    state.applyNotification({
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn1",
        item: {
          id: "command-initial",
          type: "commandExecution",
          command: "build",
          aggregatedOutput: `old${"x".repeat(300_000)}new`,
          status: "inProgress",
        },
      },
    });

    const item = state.snapshot().visibleItems[0];
    expect(item).toMatchObject({ type: "command", truncated: true });
    if (item?.type !== "command") throw new Error("command item missing");
    expect(new TextEncoder().encode(item.output).byteLength).toBeLessThanOrEqual(262_144);
    expect(item.output).not.toContain("old");
    expect(item.output).toEndWith("new");
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

  test("interrupts active work and pending approvals after app-server exit", () => {
    const state = new WebState("macos");
    state.applyNotification({
      method: "turn/started",
      params: { threadId: "t1", turn: { id: "turn1" } },
    });
    state.addApproval({
      id: 9,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t1", turnId: "turn1" },
    });

    state.interruptActiveWork();

    expect(state.snapshot()).toMatchObject({
      activeTurn: { id: "turn1", threadId: "t1", status: "interrupted" },
      pendingApprovals: [],
    });
  });

  test("removes an approval when app-server resolves the server request", () => {
    const state = new WebState("macos");
    state.addApproval({
      id: 9,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t1", turnId: "turn1" },
    });

    state.applyNotification({
      method: "serverRequest/resolved",
      params: { threadId: "t1", requestId: 9 },
    });

    expect(state.snapshot().pendingApprovals).toEqual([]);
  });

  test("bounds live reasoning summaries", () => {
    const state = new WebState("macos");
    state.applyNotification({
      method: "item/completed",
      params: {
        threadId: "t1",
        turnId: "turn1",
        item: { id: "reasoning1", type: "reasoning", summary: ["x".repeat(300_000)] },
      },
    });

    const item = state.snapshot().visibleItems[0];
    expect(item).toMatchObject({ id: "reasoning1", type: "status", truncated: true });
    if (item?.type !== "status") throw new Error("status item missing");
    expect(new TextEncoder().encode(item.text).byteLength).toBeLessThanOrEqual(262_144);
  });

  test("applies current file patch and turn error notifications", () => {
    const state = new WebState("macos");
    state.applyNotification({
      method: "item/fileChange/patchUpdated",
      params: {
        threadId: "t1",
        turnId: "turn1",
        itemId: "patch1",
        changes: [{ path: "/work/a.ts", kind: "update", diff: "+fixed" }],
      },
    });
    state.applyNotification({
      method: "error",
      params: {
        threadId: "t1",
        turnId: "turn1",
        willRetry: false,
        error: { message: "model failed" },
      },
    });

    expect(state.snapshot()).toMatchObject({
      activeTurn: { id: "turn1", threadId: "t1", status: "failed" },
      visibleItems: [
        { id: "patch1", type: "fileChange", diff: "+fixed" },
        { id: "error:turn1", type: "status", text: "model failed" },
      ],
    });
  });

  test("records bounded approval decisions without request payloads", () => {
    const state = new WebState("windows");
    const events: unknown[] = [];
    state.onEvent((event) => events.push(event));
    const approval = state.addApproval({
      id: 12,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "t1",
        turnId: "turn1",
        command: "shown",
        privateNativeField: "secret",
      },
    });
    state.claimApproval(approval.id, "accept", "device-7");

    expect(state.approvalAudit()).toEqual([
      {
        approvalId: approval.id,
        decision: "accept",
        deviceId: "device-7",
        threadId: "t1",
        turnId: "turn1",
        timestamp: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(state.approvalAudit())).not.toContain("secret");
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  test("bounds each protocol diagnostic as well as the diagnostic count", () => {
    const state = new WebState("macos");
    state.addDiagnostic(`old${"x".repeat(20_000)}new`);

    const diagnostic = state.diagnostics()[0] ?? "";
    expect(new TextEncoder().encode(diagnostic).byteLength).toBeLessThanOrEqual(16_384);
    expect(diagnostic).not.toContain("old");
    expect(diagnostic).toEndWith("new");
  });

  test("evicts old items to enforce an aggregate snapshot budget", () => {
    const state = new WebState("macos");
    state.loadThread("t1", Array.from({ length: 30 }, (_, index) => ({
      id: `item-${index}`,
      type: "message" as const,
      role: "assistant" as const,
      text: "x".repeat(262_000),
    })));

    const snapshot = state.snapshot();
    expect(snapshot.visibleItems.length).toBeLessThan(30);
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength).toBeLessThan(7_340_032);
  });
});

describe("CodexAdapter", () => {
  test("retains transport protocol errors only in bounded diagnostics", () => {
    const rpc = new ExpectedRpcClient("unused", {});
    const state = new WebState("macos");
    new CodexAdapter(rpc, state);

    rpc.emitProtocolError(new Error("malformed JSON-RPC line"));

    expect(state.diagnostics()).toEqual(["malformed JSON-RPC line"]);
    expect(state.snapshot().visibleItems).toEqual([]);
  });

  test("scopes unsupported native methods to a compatibility error", async () => {
    const rpc = new ExpectedRpcClient("model/list", new Error("Method not found"));
    const state = new WebState("macos");
    const adapter = new CodexAdapter(rpc, state);

    await expect(adapter.models()).rejects.toThrow("compatibilityError: model/list");
    expect(state.diagnostics()).toEqual(["model/list: Method not found"]);
  });

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
    const rpc = new ExpectedRpcClient(
      "thread/list",
      {
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
      },
      { limit: 100, sortKey: "updated_at", sortDirection: "desc" },
    );
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
    ).resolves.toMatchObject({ id: "t2", cwd: "/alias/work" });
    expect(state.snapshot().threads[0]?.cwd).toBe("/alias/work");
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
          turns: [],
        },
        initialTurnsPage: {
          data: [
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
          nextCursor: null,
        },
      },
      {
        threadId: "t1",
        excludeTurns: true,
        initialTurnsPage: { limit: 10, sortDirection: "desc", itemsView: "full" },
      },
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
        input: [
          { type: "text", text: "Run tests" },
          { type: "localImage", path: "/work/.codex-web/attachments/s/image.png" },
        ],
      },
    );
    const state = new WebState("macos");
    const startAdapter = new CodexAdapter(startRpc, state);
    await expect(startAdapter.startTurn("t1", [
      { type: "text", text: "Run tests" },
      { type: "localImage", path: "/work/.codex-web/attachments/s/image.png" },
    ])).resolves.toEqual({
      id: "turn2",
      threadId: "t1",
      status: "inProgress",
    });

    const interruptRpc = new ExpectedRpcClient(
      "turn/interrupt",
      { rawNativeField: "must not reach browser" },
      { threadId: "t1", turnId: "turn2" },
    );
    const interruptAdapter = new CodexAdapter(interruptRpc, state);
    await expect(interruptAdapter.interruptTurn("t1", "turn2")).resolves.toEqual({});
  });
});
