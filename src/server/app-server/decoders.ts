import type {
  FileChangeSummary,
  ModelSummary,
  PermissionProfileSummary,
  ThreadSummary,
  ThreadSettingsSummary,
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
  const source = decodeSource(thread.source);
  const canAcceptDirectInput = typeof thread.canAcceptDirectInput === "boolean"
    ? thread.canAcceptDirectInput
    : undefined;

  return {
    id,
    title: name || preview || "Untitled task",
    preview,
    createdAt,
    updatedAt,
    ...(cwd ? { cwd } : {}),
    ...(status ? { status } : {}),
    ...(source ? { source } : {}),
    ...(canAcceptDirectInput === undefined ? {} : { canAcceptDirectInput }),
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
    const supportedReasoningEfforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.slice(0, 50).flatMap((value) => {
        try {
          const effort = record(value, "model.supportedReasoningEfforts");
          const effortId = boundedRequiredString(
            effort,
            "reasoningEffort",
            "model.supportedReasoningEfforts.reasoningEffort",
            512,
          );
          const effortDescription = optionalString(effort.description);
          return [{
            id: effortId,
            ...(effortDescription
              ? { description: boundOldest(effortDescription, MAX_METADATA_BYTES) }
              : {}),
          }];
        } catch {
          return [];
        }
      })
      : undefined;
    const defaultReasoningEffort = optionalString(model.defaultReasoningEffort);
    models.push({
      id,
      displayName,
      ...(description ? { description } : {}),
      ...(isDefault === undefined ? {} : { isDefault }),
      ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
      ...(defaultReasoningEffort
        ? { defaultReasoningEffort: boundOldest(defaultReasoningEffort, 512) }
        : {}),
    });
  }
  return models;
}

export function decodePermissionProfileList(value: unknown): PermissionProfileSummary[] {
  const response = record(value, "permissionProfile/list response");
  if (!Array.isArray(response.data)) {
    throw new CompatibilityError("permissionProfile/list.data");
  }
  return response.data.slice(0, 200).flatMap((value) => {
    try {
      const profile = record(value, "permission profile");
      const id = boundedRequiredString(profile, "id", "permissionProfile.id", 512);
      if (typeof profile.allowed !== "boolean") {
        throw new CompatibilityError("permissionProfile.allowed");
      }
      const description = optionalString(profile.description);
      return [{
        id,
        allowed: profile.allowed,
        ...(description ? { description: boundOldest(description, MAX_METADATA_BYTES) } : {}),
      }];
    } catch {
      return [];
    }
  });
}

export function decodeThreadEnvelope(value: unknown): {
  thread: ThreadSummary;
  items: VisibleItem[];
  settings?: ThreadSettingsSummary;
} {
  const response = record(value, "thread response");
  const rawThread = record(response.thread, "thread response.thread");
  const turns = Array.isArray(rawThread.turns) ? rawThread.turns : [];
  const thread = decodeThread(rawThread);
  const settings = decodeThreadRuntime(response, thread.id);
  return {
    thread,
    items: decodeTurns(turns),
    ...(settings ? { settings } : {}),
  };
}

export function decodeThreadRuntime(
  value: unknown,
  threadId: string,
): ThreadSettingsSummary | undefined {
  const runtime = record(value, "thread runtime");
  const model = optionalString(runtime.model);
  if (!model) return undefined;
  const effort = optionalString(runtime.effort) ?? optionalString(runtime.reasoningEffort);
  const approvalPolicy = normalizedPolicyLabel(runtime.approvalPolicy);
  const sandbox = normalizedPolicyLabel(runtime.sandboxPolicy ?? runtime.sandbox);
  const rawProfile = runtime.activePermissionProfile;
  let permissionProfile: ThreadSettingsSummary["permissionProfile"];
  if (rawProfile !== null && rawProfile !== undefined) {
    const profile = record(rawProfile, "activePermissionProfile");
    const id = boundedRequiredString(profile, "id", "activePermissionProfile.id", 512);
    const extendsId = optionalString(profile.extends);
    permissionProfile = {
      id,
      ...(extendsId ? { extends: boundOldest(extendsId, 512) } : {}),
    };
  }
  return {
    threadId: boundOldest(threadId, 512),
    model: boundOldest(model, 512),
    ...(effort ? { effort: boundOldest(effort, 512) } : {}),
    ...(permissionProfile ? { permissionProfile } : {}),
    approvalPolicy,
    sandbox,
  };
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
    const rawChanges = Array.isArray(item.changes) ? item.changes : [];
    const changes = rawChanges.slice(0, 200).flatMap((value): FileChangeSummary[] => {
      try {
        const change = record(value, "fileChange.change");
        const diff = boundNewest(optionalString(change.diff) ?? "", MAX_ITEM_BYTES);
        return [{
          path: boundOldest(optionalString(change.path) ?? "File changes", MAX_METADATA_BYTES),
          kind: decodeChangeKind(change.kind),
          diff: diff.value,
          ...(diff.truncated ? { truncated: true } : {}),
        }];
      } catch {
        return [];
      }
    });
    const first = changes[0];
    const truncated = rawChanges.length > 200 || changes.some((change) => change.truncated);
    return {
      id,
      type: "fileChange",
      path: first?.path ?? "File changes",
      ...(first?.diff ? { diff: first.diff } : {}),
      ...(changes.length > 0 ? { changes } : {}),
      status: decodeCompletedItemStatus(optionalString(item.status)),
      ...(truncated ? { truncated: true } : {}),
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
  let status: string | undefined;
  if (typeof value === "string") status = value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    status = optionalString((value as Record<string, unknown>).type);
  }
  if (!status) return undefined;
  return ["notLoaded", "idle", "systemError", "active"].includes(status)
    ? status
    : "unknown";
}

function decodeSource(value: unknown): ThreadSummary["source"] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) {
    const source = value as Record<string, unknown>;
    if ("subAgent" in source) return "subAgent";
    return "unknown";
  }
  if (typeof value !== "string") return "unknown";
  return ["cli", "vscode", "exec", "appServer", "unknown"].includes(value)
    ? value as ThreadSummary["source"]
    : "unknown";
}

function decodeChangeKind(value: unknown): FileChangeSummary["kind"] {
  if (typeof value === "string") {
    if (value === "add" || value === "delete") return value;
    if (value === "update" || value === "modify") return "modify";
    if (value === "rename") return "rename";
    return "unknown";
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const kind = value as Record<string, unknown>;
    if (kind.type === "add" || kind.type === "delete") return kind.type;
    if (kind.type === "update") return optionalString(kind.move_path) ? "rename" : "modify";
  }
  return "unknown";
}

function normalizedPolicyLabel(value: unknown): string {
  if (typeof value === "string") return boundOldest(value, MAX_METADATA_BYTES);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return boundOldest(optionalString((value as Record<string, unknown>).type) ?? "custom", MAX_METADATA_BYTES);
  }
  return "unknown";
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
