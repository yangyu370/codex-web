import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import type { PlatformRuntime } from "../platform";

const DAEMON_OUTPUT_LIMIT_BYTES = 65_536;
const DAEMON_START_TIMEOUT_MS = 15_000;

export interface DaemonConnectionInfo {
  socketPath: string;
  appServerVersion?: string;
}

export async function startManagedDaemon(
  executable: string,
  codexHome: string,
  runtime: Pick<PlatformRuntime, "spawn">,
): Promise<DaemonConnectionInfo> {
  const child = runtime.spawn(
    [executable, "app-server", "daemon", "start"],
    { ...environmentStrings(process.env), CODEX_HOME: codexHome },
  );
  const lifecycle = Promise.all([
    readBounded(child.stdout),
    readBounded(child.stderr),
    child.exited,
  ]);
  let result: [string, string, number];
  try {
    result = await Promise.race([
      lifecycle,
      Bun.sleep(DAEMON_START_TIMEOUT_MS).then(() => {
        throw new Error("Codex daemon start timed out after 15000ms");
      }),
    ]);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  const [stdout, stderr, exitCode] = result;
  if (exitCode !== 0) {
    const context = stderr.trim().replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 4_096);
    throw new Error(
      `Codex daemon start exited with ${exitCode}${context ? `: ${context}` : ""}`,
    );
  }
  return parseDaemonStartOutput(stdout, codexHome);
}

export function parseDaemonStartOutput(
  source: string,
  codexHome: string,
): DaemonConnectionInfo {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Codex daemon start returned malformed JSON");
  }
  if (!isRecord(value)) throw new Error("Codex daemon start returned an invalid response");
  if (value.status !== "started" && value.status !== "alreadyRunning") {
    throw new Error("Codex daemon start returned an unsupported status");
  }
  if (typeof value.socketPath !== "string" || !path.posix.isAbsolute(value.socketPath)) {
    throw new Error("Codex daemon returned a non-absolute socket path");
  }

  const resolvedHome = canonicalizePath(codexHome);
  const resolvedSocket = path.posix.resolve(value.socketPath);
  const relative = path.posix.relative(resolvedHome, canonicalizeSocketPath(resolvedSocket));
  if (!relative || relative === ".." || relative.startsWith(`..${path.posix.sep}`) || path.posix.isAbsolute(relative)) {
    throw new Error("Codex daemon socket is outside the active Codex home");
  }
  if (value.appServerVersion !== undefined && typeof value.appServerVersion !== "string") {
    throw new Error("Codex daemon returned an invalid app-server version");
  }

  return {
    socketPath: resolvedSocket,
    appServerVersion: value.appServerVersion,
  };
}

function canonicalizeSocketPath(source: string): string {
  try {
    if (lstatSync(source).isSymbolicLink()) {
      throw new Error("Codex daemon socket must not be a symbolic link");
    }
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : undefined;
    if (code !== "ENOENT") {
      if (error instanceof Error && error.message.includes("must not be a symbolic link")) {
        throw error;
      }
      throw new Error(`Codex daemon path could not be validated (${code ?? "unknown"})`);
    }
  }
  return path.posix.join(
    canonicalizePath(path.posix.dirname(source)),
    path.posix.basename(source),
  );
}

function canonicalizePath(source: string): string {
  let existingAncestor = path.posix.resolve(source);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return path.posix.join(realpathSync.native(existingAncestor), ...missingSegments);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new Error(`Codex daemon path could not be validated (${code ?? "unknown"})`);
      }
      const parent = path.posix.dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw new Error("Codex daemon path could not be validated");
      }
      missingSegments.unshift(path.posix.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return result + decoder.decode();
      bytes += value.byteLength;
      if (bytes > DAEMON_OUTPUT_LIMIT_BYTES) {
        await reader.cancel();
        throw new Error("Codex daemon start output exceeded 65536 bytes");
      }
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function environmentStrings(
  environment: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
