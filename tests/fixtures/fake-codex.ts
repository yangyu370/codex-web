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
  if (method === "thread/list") return respond(id, { data: [], nextCursor: null });
  if (method === "thread/start") {
    const params = message.params as Record<string, unknown>;
    return respond(id, {
      thread: {
        id: "thread-e2e",
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
    respond(id, { turn: { id: "turn-e2e", status: "inProgress", items: [] } });
    notify("item/started", {
      threadId: "thread-e2e",
      turnId: "turn-e2e",
      item: { id: "user-e2e", type: "userMessage", content: [{ type: "text", text: "Create a file" }] },
    });
    notify("item/started", {
      threadId: "thread-e2e",
      turnId: "turn-e2e",
      item: {
        id: "patch-e2e",
        type: "fileChange",
        status: "inProgress",
        changes: [{ path: "hello.txt", diff: "+hello from Codex Web" }],
      },
    });
    write({
      id: 900,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-e2e",
        turnId: "turn-e2e",
        itemId: "patch-e2e",
        reason: "Create hello.txt",
        availableDecisions: ["accept", "decline"],
      },
    });
    return;
  }
  if (id === 900 && "result" in message) {
    notify("item/completed", {
      threadId: "thread-e2e",
      turnId: "turn-e2e",
      item: {
        id: "patch-e2e",
        type: "fileChange",
        status: "completed",
        changes: [{ path: "hello.txt", diff: "+hello from Codex Web" }],
      },
    });
    notify("item/completed", {
      threadId: "thread-e2e",
      turnId: "turn-e2e",
      item: { id: "done-e2e", type: "plan", text: "Turn completed" },
    });
    notify("turn/completed", {
      threadId: "thread-e2e",
      turn: { id: "turn-e2e", status: "completed" },
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
