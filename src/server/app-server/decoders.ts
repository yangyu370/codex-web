import type {
  ModelSummary,
  ThreadSummary,
  VisibleItem,
} from "../../shared/protocol";

const MAX_ITEM_BYTES = 262_144;
const MAX_METADATA_BYTES = 4_096;

export class CompatibilityError extends Error {
  constructor(field: string) {
    super(`compatibilityError: ${field}`);
    this.name = "CompatibilityError";
  }
}

export function decodeThread(value: unknown): ThreadSummary {
  const thread = record(value, "thread");
  const id = boundedRequiredString(thread, "id", "thread.id", 512);
  const preview = boundOldest(optionalString(thread.preview) ?? "", MAX_METADATA_BYTES);
  const createdAt = numberField(thread, "createdAt", "thread.createdAt");
  const updatedAt = optionalNumber(thread.updatedAt) ?? createdAt;
  const name = optionalString(thread.name) ? boundOldest(optionalString(thread.name)?.trim() ?? "", MAX_METADATA_BYTES) : undefined;
  const cwd = optionalString(thread.cwd) ? boundOldest(optionalString(thread.cwd) ?? "", MAX_METADATA_BYTES) : undefined;
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
  for (const value of response.data.slice(0, 200)) {
    const model = record(value, "model");
    if (model.hidden === true) {
      continue;
    }
    const id = boundedRequiredString(model, "id", "model.id", 512);
    const displayName = boundOldest(stringField(model, "displayName", "model.displayName"), MAX_METADATA_BYTES);
    const description = optionalString(model.description) ? boundOldest(optionalString(model.description) ?? "", MAX_METADATA_BYTES) : undefined;
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
  return { thread: decodeThread(rawThread), items: decodeTurns(turns) };
}

export function decodeTurns(turns: unknown[]): VisibleItem[] {
  const items: VisibleItem[] = [];
  for (const turnValue of turns) {
    const turn = record(turnValue, "thread.turn");
    if (!Array.isArray(turn.items)) continue;
    for (const itemValue of turn.items) {
      const item = decodeHistoryItem(itemValue);
      if (item) items.push(item);
    }
  }
  return items;
}

export function decodeHistoryItem(value: unknown): VisibleItem | undefined {
  const item = record(value, "thread.item");
  const id = stringField(item, "id", "thread.item.id");
  const type = stringField(item, "type", "thread.item.type");
  if (type === "agentMessage") {
    const text = boundNewest(optionalString(item.text) ?? "", MAX_ITEM_BYTES);
    return {
      id,
      type: "message",
      role: "assistant",
      text: text.value,
      streaming: false,
      ...(text.truncated ? { truncated: true } : {}),
    };
  }
  if (type === "userMessage") {
    const text = boundNewest(decodeUserContent(item.content), MAX_ITEM_BYTES);
    return {
      id,
      type: "message",
      role: "user",
      text: text.value,
      streaming: false,
      ...(text.truncated ? { truncated: true } : {}),
    };
  }
  if (type === "commandExecution") {
    const output = boundNewest(optionalString(item.aggregatedOutput) ?? "", MAX_ITEM_BYTES);
    return {
      id,
      type: "command",
      command: boundOldest(optionalString(item.command) ?? "Command", MAX_METADATA_BYTES),
      ...(optionalString(item.cwd) ? { cwd: boundOldest(optionalString(item.cwd) ?? "", MAX_METADATA_BYTES) } : {}),
      output: output.value,
      status: decodeCompletedItemStatus(optionalString(item.status)),
      ...(optionalNumber(item.exitCode) === undefined
        ? {}
        : { exitCode: optionalNumber(item.exitCode) }),
      ...(output.truncated ? { truncated: true } : {}),
    };
  }
  if (type === "fileChange") {
    const first = Array.isArray(item.changes) && item.changes.length > 0
      ? record(item.changes[0], "fileChange.change")
      : {};
    const diff = boundNewest(optionalString(first.diff) ?? "", MAX_ITEM_BYTES);
    return {
      id,
      type: "fileChange",
      path: boundOldest(optionalString(first.path) ?? "File changes", MAX_METADATA_BYTES),
      ...(diff.value ? { diff: diff.value } : {}),
      status: decodeCompletedItemStatus(optionalString(item.status)),
      ...(diff.truncated ? { truncated: true } : {}),
    };
  }
  if (type === "reasoning" || type === "plan") {
    const summary = Array.isArray(item.summary)
      ? item.summary.filter((entry): entry is string => typeof entry === "string").join("\n")
      : "";
    const text = boundNewest(optionalString(item.text) ?? (summary || type), MAX_ITEM_BYTES);
    return {
      id,
      type: "status",
      text: text.value,
      ...(text.truncated ? { truncated: true } : {}),
    };
  }
  return undefined;
}

function boundNewest(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return { value, truncated: false };
  let start = encoded.byteLength - maxBytes;
  while (start < encoded.byteLength && (encoded[start] ?? 0) >> 6 === 0b10) start += 1;
  return { value: new TextDecoder().decode(encoded.slice(start)), truncated: true };
}

function boundOldest(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (encoded[end] ?? 0) >> 6 === 0b10) end -= 1;
  return new TextDecoder().decode(encoded.slice(0, end));
}

function boundedRequiredString(value: Record<string, unknown>, key: string, field: string, maxBytes: number): string {
  const result = stringField(value, key, field);
  if (new TextEncoder().encode(result).byteLength > maxBytes) throw new CompatibilityError(field);
  return result;
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
