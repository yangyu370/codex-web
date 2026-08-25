export {};

import { access } from "node:fs/promises";

type Send = (value: unknown) => void;

const clients = new Set<Send>();

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
const privateReadCounts = new Map<string, number>();

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli fake-1.0.0");
} else if (args[0] === "app-server" && args[1] === "--stdio") {
  await runStdio();
} else if (args[0] === "app-server" && args[1] === "--listen" && args[2]) {
  await runWebSocket(args[2]);
} else {
  console.error("expected app-server --stdio or app-server --listen <loopback-url>");
  process.exitCode = 2;
}

async function handle(message: Record<string, unknown>, send: Send): Promise<void> {
  const id = message.id as string | number | undefined;
  const method = message.method;
  if (method === "initialized") return;
  if (method === "initialize") return respond(send, id, { userAgent: "fake-codex" });
  if (method === "model/list") {
    return respond(send, id, {
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
    const largeCatalogTail = Array.from({ length: 197 }, (_, index) => index === 196
      ? {
          id: `:unknown-${"x".repeat(220)}`,
          description: `ServerPolicyExplanation${"z".repeat(320)}`,
          allowed: true,
        }
      : {
          id: `:custom-${index + 1}`,
          description: `Custom permission profile ${index + 1}`,
          allowed: true,
        });
    return respond(send, id, { data: [
      { id: ":read-only", description: "Read without editing", allowed: true },
      { id: ":workspace", description: "Edit this workspace", allowed: true },
      { id: ":managed", description: "Blocked by managed policy", allowed: false },
      ...largeCatalogTail,
    ] });
  }
  if (method === "thread/list") {
    return respond(send, id, {
      data: [
        fakeThread("shared-cli", "Shared CLI task", "Live from CLI", "cli", true),
        fakeThread("private-cli", "Private CLI task", "Monitor local CLI", "cli", true),
        ...Array.from({ length: 98 }, (_, index) => ({
        id: `history-${index}`,
        name: `Historical task ${index + 1}`,
        preview: `Previous task ${index + 1}`,
        createdAt: index + 1,
        updatedAt: index + 1,
        cwd: "/work/history",
        status: { type: "idle" },
        })),
      ],
      nextCursor: null,
    });
  }
  if (method === "thread/resume") {
    const threadId = String((message.params as Record<string, unknown>).threadId);
    if (threadId === "private-cli" && (privateReadCounts.get(threadId) ?? 0) < 2) {
      send({ id, error: { code: -32600, message: `thread ${threadId} already has an active writer` } });
      return;
    }
    const privateRevision = privateReadCounts.get(threadId) ?? 0;
    return respond(send, id, threadEnvelope(
      fakeThread(
        threadId,
        threadId === "private-cli" ? "Private CLI task" : "Shared CLI task",
        threadId === "private-cli" ? "Local writer released" : "Live from CLI",
        "cli",
        true,
      ),
      threadId === "private-cli" ? `Private CLI update ${privateRevision}` : "CLI and Web are connected",
    ));
  }
  if (method === "thread/read") {
    const threadId = String((message.params as Record<string, unknown>).threadId);
    const revision = (privateReadCounts.get(threadId) ?? 0) + 1;
    privateReadCounts.set(threadId, revision);
    return respond(send, id, threadEnvelope(
      fakeThread(threadId, "Private CLI task", `Private CLI update ${revision}`, "cli", true),
      `Private CLI update ${revision}`,
    ));
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
    const started = fakeThread(
      threadId,
      "Create a file",
      "Create a file",
      "appServer",
      true,
      String(params.cwd ?? ""),
    );
    const result = {
      thread: {
        ...started,
        turns: [],
      },
      model: String(params.model ?? "gpt-fake"),
      effort: "medium",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
      activePermissionProfile: { id: ":read-only", extends: null },
    };
    respond(send, id, result);
    if (clients.size > 1) notify("thread/started", { thread: started });
    return;
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
    respond(send, id, {});
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
    respond(send, id, {
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
      send({ id, error: { code: -32602, message: attachmentError } });
      return;
    }
    const threadId = String(params.threadId);
    const turnId = `turn-e2e-${nextTurnId}`;
    const itemId = `patch-e2e-${nextTurnId}`;
    const approvalId = nextApprovalId;
    nextTurnId += 1;
    nextApprovalId += 1;
    pendingApprovals.set(approvalId, { itemId, threadId, turnId });
    respond(send, id, { turn: { id: turnId, status: "inProgress", items: [] } });
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
    send({
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
  if (method === "turn/interrupt") {
    const params = message.params as Record<string, unknown>;
    respond(send, id, {});
    notify("turn/completed", {
      threadId: String(params.threadId),
      turn: { id: String(params.turnId), status: "interrupted" },
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
    if (!await access(filePath).then(() => true, () => false)) {
      return "attachment manifest path is unreadable";
    }
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

function respond(send: Send, id: unknown, result: unknown): void {
  send({ id, result });
}

function notify(method: string, params: unknown): void {
  for (const send of clients) send({ method, params });
}

function fakeThread(
  id: string,
  name: string,
  preview: string,
  source: "cli" | "appServer",
  canAcceptDirectInput: boolean,
  cwd = "/work/shared",
) {
  return {
    id,
    name,
    preview,
    createdAt: 1,
    updatedAt: Date.now() / 1_000,
    cwd,
    status: { type: "idle" },
    source,
    canAcceptDirectInput,
  };
}

function threadEnvelope(thread: ReturnType<typeof fakeThread>, text: string) {
  const turns = [{
    id: `history-turn-${thread.id}`,
    status: "completed",
    items: [{ id: `history-message-${thread.id}`, type: "agentMessage", text }],
  }];
  return {
    thread: {
      ...thread,
      turns,
    },
    initialTurnsPage: { data: turns, nextCursor: null },
    model: "gpt-fake",
    effort: "medium",
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
    activePermissionProfile: { id: ":read-only", extends: null },
  };
}

async function runStdio(): Promise<void> {
  const send: Send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  clients.add(send);
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) await handle(JSON.parse(line) as Record<string, unknown>, send);
    }
  }
  clients.delete(send);
}

async function runWebSocket(endpoint: string): Promise<void> {
  const url = new URL(endpoint);
  if (url.protocol !== "ws:" || !["127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("fake app-server listener must be loopback ws");
  }
  const sends = new WeakMap<object, Send>();
  const server = Bun.serve({
    hostname: url.hostname === "[::1]" ? "::1" : url.hostname,
    port: Number(url.port),
    fetch(request, server) {
      if (server.upgrade(request)) return undefined;
      return new Response("WebSocket required", { status: 426 });
    },
    websocket: {
      open(socket) {
        const send: Send = (value) => socket.send(JSON.stringify(value));
        sends.set(socket, send);
        clients.add(send);
      },
      message(socket, source) {
        const send = sends.get(socket);
        if (!send) return;
        const text = typeof source === "string" ? source : new TextDecoder().decode(source);
        void handle(JSON.parse(text) as Record<string, unknown>, send);
      },
      close(socket) {
        const send = sends.get(socket);
        if (send) clients.delete(send);
        sends.delete(socket);
      },
    },
  });
  await new Promise<void>((resolve) => {
    const stop = () => {
      server.stop(true);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
