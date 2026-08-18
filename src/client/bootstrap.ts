import { type BrowserSnapshot, WEB_PROTOCOL_VERSION } from "../shared/protocol";

export function assertCompatibleSnapshot(value: unknown): BrowserSnapshot {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).protocolVersion !== WEB_PROTOCOL_VERSION
  ) {
    throw new Error("Restart Codex Web to finish the update");
  }
  return value as BrowserSnapshot;
}
