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
const taskSettings = new Map<string, { model: string; effort: string; permissionProfile: string }>();
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
    if (line) await handle(JSON.parse(line) as Record<string, unknown>);
  }
}

async function handle(message: Record<string, unknown>): Promise<void> {
  const id = message.id as string | number | undefined;
  const method = message.method;
  if (method === "initialized") return;
  if (method === "initialize") return respond(id, { userAgent: "fake-codex" });
  if (method === "model/list") {
    return respond(id, {
      data: [{
        id: "gpt-fake",
        displayName: "GPT Fake",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast responses" },
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "high", description: "Deeper analysis" },
        ],
      }],
    });
  }
  if (method === "permissionProfile/list") {
    return respond(id, { data: [
      { id: ":read-only", description: "Read without editing", allowed: true },
      { id: ":workspace", description: "Edit this workspace", allowed: true },
      { id: ":managed", description: "Blocked by managed policy", allowed: false },
    ] });
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
    taskSettings.set(threadId, {
      model: String(params.model ?? "gpt-fake"),
      effort: "medium",
      permissionProfile: ":read-only",
    });
    return respond(id, {
      thread: {
        id: threadId,
        name: "Create a file",
        preview: "Create a file",
        createdAt: 1,
        updatedAt: 1,
        cwd: params.cwd,
        status: { type: "idle" },
        source: "appServer",
        canAcceptDirectInput: true,
        turns: [],
      },
      model: String(params.model ?? "gpt-fake"),
      effort: "medium",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
      activePermissionProfile: { id: ":read-only", extends: null },
    });
  }
  if (method === "thread/settings/update") {
    const params = message.params as Record<string, unknown>;
    const threadId = String(params.threadId);
    const current = taskSettings.get(threadId) ?? {
      model: "gpt-fake",
      effort: "medium",
      permissionProfile: ":read-only",
    };
    const next = {
      ...current,
      ...(typeof params.effort === "string" ? { effort: params.effort } : {}),
      ...(typeof params.permissions === "string" ? { permissionProfile: params.permissions } : {}),
    };
    taskSettings.set(threadId, next);
    respond(id, {});
    notify("thread/settings/updated", {
      threadId,
      threadSettings: {
        model: next.model,
        effort: next.effort,
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
        activePermissionProfile: { id: next.permissionProfile, extends: null },
      },
    });
    return;
  }
  if (method === "review/start") {
    const params = message.params as Record<string, unknown>;
    const threadId = String(params.threadId);
    const turnId = `review-e2e-${nextTurnId++}`;
    respond(id, {
      reviewThreadId: threadId,
      turn: { id: turnId, status: "inProgress", items: [] },
    });
    notify("turn/diff/updated", {
      threadId,
      turnId,
      diff: `diff --git a/src/hello.ts b/src/hello.ts\n--- a/src/hello.ts\n+++ b/src/hello.ts\n@@ -1,2 +1,2 @@\n-export const greeting = "hello";\n+export const greeting = "hello from web";\n console.log(greeting);`,
    });
    notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
    return;
  }
  if (method === "turn/start") {
    const params = message.params as Record<string, unknown>;
    const attachmentError = await validateAttachmentInputs(params.input);
    if (attachmentError) {
      write({ id, error: { code: -32602, message: attachmentError } });
      return;
    }
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

async function validateAttachmentInputs(value: unknown): Promise<string | undefined> {
  if (!Array.isArray(value)) return undefined;
  const inputs = value.filter((entry): entry is Record<string, unknown> =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
  const manifest = inputs.find((entry) =>
    entry.type === "text" &&
    typeof entry.text === "string" &&
    entry.text.includes("Attached files for this turn are available on the local filesystem:"),
  )?.text;
  if (typeof manifest !== "string") return undefined;

  const paths = [...manifest.matchAll(/ at ("(?:[^"\\]|\\.)*") \(/g)].flatMap((match) => {
    try {
      const parsed = JSON.parse(match[1] ?? "") as unknown;
      return typeof parsed === "string" ? [parsed] : [];
    } catch {
      return [];
    }
  });
  if (paths.length === 0) return "attachment manifest contains no readable paths";
  for (const filePath of paths) {
    if (!(await Bun.file(filePath).exists())) return "attachment manifest path is unreadable";
  }
  const localImages = new Set(inputs.flatMap((entry) =>
    entry.type === "localImage" && typeof entry.path === "string" ? [entry.path] : [],
  ));
  const imagePaths = paths.filter((filePath) => /\.(?:png|jpe?g|webp|gif)$/i.test(filePath));
  if (imagePaths.some((filePath) => !localImages.has(filePath))) {
    return "image attachment is not a native localImage input";
  }
  return undefined;
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
