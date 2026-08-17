import type {
  ModelSummary,
  ThreadSummary,
  VisibleItem,
} from "../../shared/protocol";

export class CompatibilityError extends Error {
  constructor(field: string) {
    super(`compatibilityError: ${field}`);
    this.name = "CompatibilityError";
  }
}

export function decodeThread(value: unknown): ThreadSummary {
  const thread = record(value, "thread");
  const id = stringField(thread, "id", "thread.id");
  const preview = optionalString(thread.preview) ?? "";
  const createdAt = numberField(thread, "createdAt", "thread.createdAt");
  const updatedAt = optionalNumber(thread.updatedAt) ?? createdAt;
  const name = optionalString(thread.name)?.trim();
  const cwd = optionalString(thread.cwd);
  const status = decodeStatus(thread.status);

  return {
    id,
    title: name || preview || "Untitled task",
    preview,
    createdAt,
    updatedAt,
    ...(cwd ? { cwd } : {}),
    ...(status ? { status } : {}),
  };
}

export function decodeThreadList(value: unknown): {
  data: ThreadSummary[];
  nextCursor: string | null;
} {
  const response = record(value, "thread/list response");
  if (!Array.isArray(response.data)) {
    throw new CompatibilityError("thread/list.data");
  }
  return {
    data: response.data.map(decodeThread),
    nextCursor: optionalString(response.nextCursor) ?? null,
  };
}

export function decodeModelList(value: unknown): ModelSummary[] {
  const response = record(value, "model/list response");
  if (!Array.isArray(response.data)) {
    throw new CompatibilityError("model/list.data");
  }
  const models: ModelSummary[] = [];
  for (const value of response.data) {
    const model = record(value, "model");
    if (model.hidden === true) {
      continue;
    }
    const id = stringField(model, "id", "model.id");
    const displayName = stringField(model, "displayName", "model.displayName");
    const description = optionalString(model.description);
    const isDefault = typeof model.isDefault === "boolean" ? model.isDefault : undefined;
    models.push({
      id,
      displayName,
      ...(description ? { description } : {}),
      ...(isDefault === undefined ? {} : { isDefault }),
    });
  }
  return models;
}

export function decodeThreadEnvelope(value: unknown): {
  thread: ThreadSummary;
  items: VisibleItem[];
} {
  const response = record(value, "thread response");
  const rawThread = record(response.thread, "thread response.thread");
  const turns = Array.isArray(rawThread.turns) ? rawThread.turns : [];
  const items: VisibleItem[] = [];
  for (const turnValue of turns) {
    const turn = record(turnValue, "thread.turn");
    if (!Array.isArray(turn.items)) continue;
    for (const itemValue of turn.items) {
      const item = decodeHistoryItem(itemValue);
      if (item) items.push(item);
    }
  }
  return { thread: decodeThread(rawThread), items };
}

export function decodeHistoryItem(value: unknown): VisibleItem | undefined {
  const item = record(value, "thread.item");
  const id = stringField(item, "id", "thread.item.id");
  const type = stringField(item, "type", "thread.item.type");
  if (type === "agentMessage") {
    return {
      id,
      type: "message",
      role: "assistant",
      text: optionalString(item.text) ?? "",
      streaming: false,
    };
  }
  if (type === "userMessage") {
    return {
      id,
      type: "message",
      role: "user",
      text: decodeUserContent(item.content),
      streaming: false,
    };
  }
  if (type === "commandExecution") {
    return {
      id,
      type: "command",
      command: optionalString(item.command) ?? "Command",
      ...(optionalString(item.cwd) ? { cwd: optionalString(item.cwd) } : {}),
      output: optionalString(item.aggregatedOutput) ?? "",
      status: decodeCompletedItemStatus(optionalString(item.status)),
      ...(optionalNumber(item.exitCode) === undefined
        ? {}
        : { exitCode: optionalNumber(item.exitCode) }),
    };
  }
  if (type === "fileChange") {
    const first = Array.isArray(item.changes) && item.changes.length > 0
      ? record(item.changes[0], "fileChange.change")
      : {};
    return {
      id,
      type: "fileChange",
      path: optionalString(first.path) ?? "File changes",
      ...(optionalString(first.diff) ? { diff: optionalString(first.diff) } : {}),
      status: decodeCompletedItemStatus(optionalString(item.status)),
    };
  }
  if (type === "reasoning" || type === "plan") {
    const summary = Array.isArray(item.summary)
      ? item.summary.filter((entry): entry is string => typeof entry === "string").join("\n")
      : "";
    return {
      id,
      type: "status",
      text: optionalString(item.text) ?? (summary || type),
    };
  }
  return undefined;
}

export function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CompatibilityError(field);
  }
  return value as Record<string, unknown>;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringField(
  value: Record<string, unknown>,
  key: string,
  field: string,
): string {
  const result = optionalString(value[key]);
  if (result === undefined) {
    throw new CompatibilityError(field);
  }
  return result;
}

export function numberField(
  value: Record<string, unknown>,
  key: string,
  field: string,
): number {
  const result = optionalNumber(value[key]);
  if (result === undefined) {
    throw new CompatibilityError(field);
  }
  return result;
}

function decodeStatus(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return optionalString((value as Record<string, unknown>).type);
  }
  return undefined;
}

function decodeUserContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return "";
      return optionalString((entry as Record<string, unknown>).text) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

function decodeCompletedItemStatus(
  value: string | undefined,
): "running" | "completed" | "failed" {
  if (value === "failed" || value === "declined") return "failed";
  if (value === "inProgress") return "running";
  return "completed";
}
