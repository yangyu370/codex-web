export const MINIMUM_WINDOWS_SHARED_VERSION = "0.149.1";

export function codexSemanticVersion(source: string): [number, number, number] {
  const match = source.match(/(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:[^0-9]|$)/);
  if (!match) throw new Error("Codex version could not be verified");
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function codexVersionAtLeast(source: string, minimum: string): boolean {
  const actual = codexSemanticVersion(source);
  const required = codexSemanticVersion(minimum);
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index]! > required[index]!) return true;
    if (actual[index]! < required[index]!) return false;
  }
  return true;
}

export function sameCodexVersion(first: string, second: string): boolean {
  return codexSemanticVersion(first).join(".") === codexSemanticVersion(second).join(".");
}

export function appServerVersionFromInitialize(value: unknown): string {
  if (!isRecord(value) || typeof value.userAgent !== "string" || value.userAgent.length > 2_048) {
    throw new Error("app-server initialize did not return a verifiable user agent");
  }
  const version = codexSemanticVersion(value.userAgent).join(".");
  return `codex-cli ${version}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
