import { mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

const MAX_RECENT_DIRECTORIES = 20;
const MAX_SETTINGS_BYTES = 16_384;
const MAX_DIRECTORY_BYTES = 4_096;

export interface UserSettings {
  recentDirectories: string[];
  model?: string;
  theme?: "light" | "dark" | "system";
}

export class SettingsStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async read(): Promise<UserSettings> {
    try {
      const settingsPath = path.join(this.#directory, "settings.json");
      if ((await stat(settingsPath)).size > MAX_SETTINGS_BYTES) return { recentDirectories: [] };
      const value = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
      return normalizeSettings(value);
    } catch {
      return { recentDirectories: [] };
    }
  }

  async save(value: UserSettings): Promise<void> {
    const settings = normalizeSettings(value);
    await mkdir(this.#directory, { recursive: true });
    const destination = path.join(this.#directory, "settings.json");
    const temporary = path.join(
      this.#directory,
      `settings.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    try {
      await Bun.write(temporary, `${JSON.stringify(settings, null, 2)}\n`);
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function normalizeSettings(value: unknown): UserSettings {
  if (!isRecord(value)) return { recentDirectories: [] };
  const recentDirectories = Array.isArray(value.recentDirectories)
    ? value.recentDirectories
        .filter((entry): entry is string => typeof entry === "string")
        .filter((entry) => new TextEncoder().encode(entry).byteLength <= MAX_DIRECTORY_BYTES)
        .slice(0, MAX_RECENT_DIRECTORIES)
    : [];
  const model = boundedString(value.model, 200);
  const theme =
    value.theme === "light" || value.theme === "dark" || value.theme === "system"
      ? value.theme
      : undefined;
  return {
    recentDirectories,
    ...(model ? { model } : {}),
    ...(theme ? { theme } : {}),
  };
}

function boundedString(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length <= limit ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
