export {};

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli fake-1.0.0");
  process.exit(0);
}
if (args[0] !== "app-server" || args[1] !== "--stdio") {
  console.error("expected app-server --stdio");
  process.exit(2);
}

let buffer = "";
let nextThreadId = 1;
let nextTurnId = 1;
let nextApprovalId = 900;
const pendingApprovals = new Map<string | number, {
  itemId: string;
  threadId: string;
  turnId: string;
}>();
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line) as Record<string, unknown>);
  }
}

function handle(message: Record<string, unknown>): void {
  const id = message.id as string | number | undefined;
  const method = message.method;
  if (method === "initialized") return;
  if (method === "initialize") return respond(id, { userAgent: "fake-codex" });
  if (method === "model/list") {
    return respond(id, {
      data: [{ id: "gpt-fake", displayName: "GPT Fake", isDefault: true }],
    });
  }
  if (method === "thread/list") {
    return respond(id, {
      data: Array.from({ length: 100 }, (_, index) => ({
        id: `history-${index}`,
        name: `Historical task ${index + 1}`,
        preview: `Previous task ${index + 1}`,
        createdAt: index + 1,
        updatedAt: index + 1,
        cwd: "/work/history",
        status: { type: "idle" },
      })),
      nextCursor: null,
    });
  }
  if (method === "thread/start") {
    const params = message.params as Record<string, unknown>;
    const threadId = `thread-e2e-${nextThreadId}`;
    nextThreadId += 1;
    return respond(id, {
      thread: {
        id: threadId,
        name: "Create a file",
        preview: "Create a file",
        createdAt: 1,
        updatedAt: 1,
        cwd: params.cwd,
        status: { type: "idle" },
        turns: [],
      },
    });
  }
  if (method === "turn/start") {
    const params = message.params as Record<string, unknown>;
    const threadId = String(params.threadId);
    const turnId = `turn-e2e-${nextTurnId}`;
    const itemId = `patch-e2e-${nextTurnId}`;
    const approvalId = nextApprovalId;
    nextTurnId += 1;
    nextApprovalId += 1;
    pendingApprovals.set(approvalId, { itemId, threadId, turnId });
    respond(id, { turn: { id: turnId, status: "inProgress", items: [] } });
    notify("item/started", {
      threadId,
      turnId,
      item: { id: `user-e2e-${turnId}`, type: "userMessage", content: [{ type: "text", text: "Create a file" }] },
    });
    notify("item/started", {
      threadId,
      turnId,
      item: {
        id: itemId,
        type: "fileChange",
        status: "inProgress",
        changes: [{ path: "hello.txt", diff: "+hello from Codex Web" }],
      },
    });
    write({
      id: approvalId,
      method: "item/fileChange/requestApproval",
      params: {
        threadId,
        turnId,
        itemId,
        reason: "Create hello.txt",
        availableDecisions: ["accept", "decline"],
      },
    });
    return;
  }
  const approval = id === undefined ? undefined : pendingApprovals.get(id);
  if (approval && "result" in message) {
    pendingApprovals.delete(id!);
    notify("item/completed", {
      threadId: approval.threadId,
      turnId: approval.turnId,
      item: {
        id: approval.itemId,
        type: "fileChange",
        status: "completed",
        changes: [{ path: "hello.txt", diff: "+hello from Codex Web" }],
      },
    });
    notify("item/completed", {
      threadId: approval.threadId,
      turnId: approval.turnId,
      item: { id: `done-e2e-${approval.turnId}`, type: "plan", text: "Turn completed" },
    });
    notify("turn/completed", {
      threadId: approval.threadId,
      turn: { id: approval.turnId, status: "completed" },
    });
  }
}

function respond(id: unknown, result: unknown): void {
  write({ id, result });
}

function notify(method: string, params: unknown): void {
  write({ method, params });
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
