import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

const MAX_LOG_BYTES = 1_048_576;
const MAX_ENTRY_BYTES = 16_384;

export class LocalEventLog {
  readonly #directory: string;
  readonly #secrets: string[];
  #pending = Promise.resolve();

  constructor(directory: string, secrets: string[] = []) {
    this.#directory = directory;
    this.#secrets = secrets.filter((value) => value.length >= 4);
  }

  append(type: "diagnostic" | "approval", payload: unknown): void {
    const serialized = JSON.stringify({ timestamp: Date.now(), type, payload });
    const redacted = this.#secrets.reduce(
      (value, secret) => value.split(secret).join("[REDACTED]"),
      serialized,
    );
    const entry = boundedLine(redacted, MAX_ENTRY_BYTES);
    this.#pending = this.#pending.then(() => this.#write(`${entry}\n`)).catch(() => undefined);
  }

  flush(): Promise<void> {
    return this.#pending;
  }

  async #write(line: string): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    const destination = path.join(this.#directory, "events.jsonl");
    const bytes = new TextEncoder().encode(line).byteLength;
    const current = await stat(destination).then((value) => value.size).catch(() => 0);
    if (current + bytes > MAX_LOG_BYTES) {
      const previous = path.join(this.#directory, "events.previous.jsonl");
      await unlink(previous).catch(() => undefined);
      await rename(destination, previous).catch(() => undefined);
    }
    await appendFile(destination, line, "utf8");
  }
}

export function secretEnvironmentValues(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([key, value]) => value && /(token|secret|password|api.?key|assertion|jwt)/i.test(key))
    .map(([, value]) => value as string);
}

function boundedLine(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  let end = Math.floor(maxBytes / 8);
  while (end > 0 && (encoded[end] ?? 0) >> 6 === 0b10) end -= 1;
  return JSON.stringify({ truncated: true, value: new TextDecoder().decode(encoded.slice(0, end)) });
}
