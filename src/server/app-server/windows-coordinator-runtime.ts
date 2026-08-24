import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { JsonRpcPeer } from "./json-rpc";
import { connectTcpWebSocket } from "./tcp-websocket-transport";
import type {
  WindowsCoordinatorRuntime,
  WindowsHostStartRequest,
  WindowsSharedMetadata,
} from "./windows-shared-coordinator";

const MAX_METADATA_BYTES = 65_536;
const LOCK_TIMEOUT_MS = 15_000;

export function windowsCoordinatorInstanceKey(codexHome: string): string {
  return createHash("sha256")
    .update(codexHome.replaceAll("/", "\\").toLowerCase())
    .digest("hex")
    .slice(0, 32);
}

export function createWindowsCoordinatorFileStore(
  dataDirectory: string,
  codexHome: string,
) {
  const directory = path.join(
    dataDirectory,
    "shared-app-server",
    windowsCoordinatorInstanceKey(codexHome),
  );
  const paths = {
    directory,
    metadata: path.join(directory, "lifecycle.json"),
    lock: path.join(directory, "startup.lock"),
    lease: path.join(directory, "host-lease.json"),
    diagnostics: path.join(directory, "host-diagnostics.log"),
  };

  return {
    paths,
    async readMetadata(): Promise<WindowsSharedMetadata | undefined> {
      let source: string;
      try {
        const info = await stat(paths.metadata);
        if (info.size > MAX_METADATA_BYTES) {
          throw new Error("malformed lifecycle metadata: file is too large");
        }
        source = await readFile(paths.metadata, "utf8");
      } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      }
      try {
        return parseMetadata(JSON.parse(source));
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("malformed lifecycle metadata")) {
          throw error;
        }
        throw new Error("malformed lifecycle metadata: invalid JSON");
      }
    },
    async writeMetadata(metadata: WindowsSharedMetadata): Promise<void> {
      await mkdir(directory, { recursive: true });
      const temporary = path.join(directory, `lifecycle.${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(metadata), "utf8");
      } finally {
        await handle.close();
      }
      await rename(temporary, paths.metadata);
    },
    async removeMetadata(): Promise<void> {
      await rm(paths.metadata, { force: true });
    },
    async withStartupLock<T>(operation: () => Promise<T>): Promise<T> {
      await mkdir(directory, { recursive: true });
      const deadline = Date.now() + LOCK_TIMEOUT_MS;
      while (true) {
        try {
          const handle = await open(paths.lock, "wx", 0o600);
          try {
            await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
            return await operation();
          } finally {
            await handle.close();
            await rm(paths.lock, { force: true });
          }
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
          if (Date.now() >= deadline) {
            if (await staleLockCanBeRemoved(paths.lock)) {
              await rm(paths.lock, { force: true });
              continue;
            }
            throw new Error("shared app-server startup lock timed out");
          }
          await Bun.sleep(5);
        }
      }
    },
  };
}

export interface WindowsCoordinatorRuntimeOptions {
  dataDirectory: string;
  codexHome: string;
  cliVersion: string;
  bunExecutable: string;
  lifecycleScript: string;
  env?: Record<string, string>;
  startupTimeoutMs?: number;
}

export function createWindowsCoordinatorRuntime(
  options: WindowsCoordinatorRuntimeOptions,
): WindowsCoordinatorRuntime {
  const store = createWindowsCoordinatorFileStore(options.dataDirectory, options.codexHome);
  const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
  return {
    withStartupLock: store.withStartupLock,
    readMetadata: store.readMetadata,
    writeMetadata: store.writeMetadata,
    removeMetadata: store.removeMetadata,
    async probe(endpoint) {
      const transport = await connectTcpWebSocket(endpoint);
      const peer = new JsonRpcPeer(transport);
      try {
        await peer.request("initialize", {
          clientInfo: { name: "codex-web-lifecycle", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        });
        peer.notify("initialized");
        const metadata = await store.readMetadata();
        return { appServerVersion: metadata?.appServerVersion ?? options.cliVersion };
      } finally {
        peer.close(new Error("readiness probe complete"));
      }
    },
    async startHost(request) {
      const child = spawn(options.bunExecutable, [
        options.lifecycleScript,
        "host",
        "--endpoint", request.endpoint,
        "--codex-home", request.codexHome,
        "--executable", request.executable,
        "--generation", request.generation,
        "--data-directory", options.dataDirectory,
      ], {
        detached: true,
        env: { ...process.env, ...options.env },
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      if (!child.pid) throw new Error("detached app-server host returned no process id");
      const lease = await waitForLease(store.paths.lease, request, child.pid, startupTimeoutMs);
      return { hostPid: lease.hostPid, nativePid: lease.nativePid };
    },
    async processMatches(metadata) {
      const lease = await readLease(store.paths.lease).catch(() => undefined);
      return lease?.generation === metadata.generation &&
        lease.hostPid === metadata.hostPid &&
        lease.nativePid === metadata.nativePid &&
        isPidAlive(metadata.hostPid) &&
        isPidAlive(metadata.nativePid);
    },
    async stopHost(metadata) {
      const lease = await readLease(store.paths.lease);
      if (
        lease.generation !== metadata.generation ||
        lease.hostPid !== metadata.hostPid ||
        lease.nativePid !== metadata.nativePid ||
        !isPidAlive(metadata.hostPid)
      ) {
        throw new Error("managed host identity changed before stop");
      }
      process.kill(metadata.hostPid, "SIGTERM");
      const deadline = Date.now() + 5_000;
      while (isPidAlive(metadata.hostPid) && Date.now() < deadline) await Bun.sleep(25);
      if (isPidAlive(metadata.hostPid)) throw new Error("managed host did not stop");
      await rm(store.paths.lease, { force: true });
    },
    now: Date.now,
    randomId: randomUUID,
    sleep: Bun.sleep,
  };
}

function parseMetadata(value: unknown): WindowsSharedMetadata {
  if (!isRecord(value)) throw new Error("malformed lifecycle metadata: invalid object");
  const strings = [
    "endpoint", "codexHome", "executable", "cliVersion",
    "appServerVersion", "generation",
  ] as const;
  if (value.schemaVersion !== 1 || strings.some((field) => typeof value[field] !== "string")) {
    throw new Error("malformed lifecycle metadata: invalid fields");
  }
  if (
    typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) ||
    !isPositiveInteger(value.hostPid) || !isPositiveInteger(value.nativePid)
  ) {
    throw new Error("malformed lifecycle metadata: invalid process identity");
  }
  return value as unknown as WindowsSharedMetadata;
}

interface HostLease {
  generation: string;
  hostPid: number;
  nativePid: number;
}

async function waitForLease(
  leasePath: string,
  request: WindowsHostStartRequest,
  hostPid: number,
  timeoutMs: number,
): Promise<HostLease> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lease = await readLease(leasePath).catch(() => undefined);
    if (lease?.generation === request.generation && lease.hostPid === hostPid) return lease;
    if (!isPidAlive(hostPid)) throw new Error("detached app-server host exited before readiness");
    await Bun.sleep(25);
  }
  throw new Error("detached app-server host lease timed out");
}

async function readLease(leasePath: string): Promise<HostLease> {
  const info = await stat(leasePath);
  if (info.size > 4_096) throw new Error("managed host lease is too large");
  const value: unknown = JSON.parse(await readFile(leasePath, "utf8"));
  if (
    !isRecord(value) || typeof value.generation !== "string" ||
    !isPositiveInteger(value.hostPid) || !isPositiveInteger(value.nativePid)
  ) {
    throw new Error("managed host lease is invalid");
  }
  return { generation: value.generation, hostPid: value.hostPid, nativePid: value.nativePid };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function staleLockCanBeRemoved(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs <= LOCK_TIMEOUT_MS) return false;
    const value: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (!isRecord(value) || !isPositiveInteger(value.pid)) return false;
    try {
      process.kill(value.pid, 0);
      return false;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}
