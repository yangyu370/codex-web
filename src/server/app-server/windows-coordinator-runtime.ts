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
import { appServerVersionFromInitialize } from "./windows-version";
import type {
  WindowsHostControlRequest,
  WindowsHostControlResponse,
  WindowsProcessIdentity,
} from "./windows-app-server-host";

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
    controlRequest: path.join(directory, "host-control-request.json"),
    controlResponse: path.join(directory, "host-control-response.json"),
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
      await writeJsonAtomic(paths.metadata, metadata);
    },
    async removeMetadata(): Promise<void> {
      await rm(paths.metadata, { force: true });
    },
    async withStartupLock<T>(operation: () => Promise<T>): Promise<T> {
      await mkdir(directory, { recursive: true });
      const deadline = Date.now() + LOCK_TIMEOUT_MS;
      const token = randomUUID();
      while (true) {
        let handle: Awaited<ReturnType<typeof open>>;
        try {
          handle = await open(paths.lock, "wx", 0o600);
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
          if (await staleLockCanBeRemoved(paths.lock)) {
            await rm(paths.lock, { force: true });
            continue;
          }
          if (Date.now() >= deadline) {
            throw new Error("shared app-server startup lock timed out");
          }
          await Bun.sleep(5);
          continue;
        }
        try {
          await handle.writeFile(JSON.stringify({
            pid: process.pid,
            createdAt: Date.now(),
            token,
          }));
          return await operation();
        } finally {
          await handle.close();
          const current = await readFile(paths.lock, "utf8")
            .then((source) => JSON.parse(source) as unknown)
            .catch(() => undefined);
          if (isRecord(current) && current.token === token) {
            await rm(paths.lock, { force: true });
          }
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
        const initialized = await peer.request("initialize", {
          clientInfo: { name: "codex-web-lifecycle", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        });
        peer.notify("initialized");
        return { appServerVersion: appServerVersionFromInitialize(initialized) };
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
      return {
        hostPid: lease.hostPid,
        nativePid: lease.nativePid,
        hostIdentity: lease.hostIdentity,
        nativeIdentity: lease.nativeIdentity,
      };
    },
    async processMatches(metadata) {
      const lease = await readLease(store.paths.lease).catch(() => undefined);
      if (!(lease?.generation === metadata.generation &&
        lease.hostPid === metadata.hostPid &&
        lease.nativePid === metadata.nativePid &&
        sameProcessIdentity(lease.hostIdentity, metadata.hostIdentity) &&
        sameProcessIdentity(lease.nativeIdentity, metadata.nativeIdentity))) return false;
      const [hostIdentity, nativeIdentity] = await Promise.all([
        describeWindowsProcess(metadata.hostPid).catch(() => undefined),
        describeWindowsProcess(metadata.nativePid).catch(() => undefined),
      ]);
      if (
        !sameProcessIdentity(hostIdentity, metadata.hostIdentity) ||
        !sameProcessIdentity(nativeIdentity, metadata.nativeIdentity)
      ) return false;
      return challengeHost(store.paths, metadata, "probe", 2_000)
        .then((response) => response.status === "alive")
        .catch(() => false);
    },
    async managedProcessesGone(metadata) {
      const [hostGone, nativeGone] = await Promise.all([
        processIdentityGone(metadata.hostIdentity),
        processIdentityGone(metadata.nativeIdentity),
      ]);
      return hostGone && nativeGone;
    },
    async stopHost(metadata) {
      const lease = await readLease(store.paths.lease);
      if (
        lease.generation !== metadata.generation ||
        lease.hostPid !== metadata.hostPid ||
        lease.nativePid !== metadata.nativePid ||
        !sameProcessIdentity(lease.hostIdentity, metadata.hostIdentity) ||
        !sameProcessIdentity(lease.nativeIdentity, metadata.nativeIdentity) ||
        !sameProcessIdentity(
          await describeWindowsProcess(metadata.hostPid).catch(() => undefined),
          metadata.hostIdentity,
        ) ||
        !sameProcessIdentity(
          await describeWindowsProcess(metadata.nativePid).catch(() => undefined),
          metadata.nativeIdentity,
        )
      ) {
        throw new Error("managed host identity changed before stop");
      }
      let controlError: unknown;
      try {
        const response = await challengeHost(store.paths, metadata, "stop", 10_000);
        if (response.status !== "stopped") throw new Error("managed host rejected stop request");
      } catch (error) {
        controlError = error;
      }
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const gone = await Promise.all([
          processIdentityGone(metadata.hostIdentity),
          processIdentityGone(metadata.nativeIdentity),
        ]).then((values) => values.every(Boolean)).catch(() => false);
        if (gone) break;
        await Bun.sleep(25);
      }
      const gone = await Promise.all([
        processIdentityGone(metadata.hostIdentity),
        processIdentityGone(metadata.nativeIdentity),
      ]).then((values) => values.every(Boolean));
      if (!gone) {
        if (controlError) throw controlError;
        throw new Error("managed process tree did not stop");
      }
      await Promise.all([
        rm(store.paths.lease, { force: true }),
        rm(store.paths.controlRequest, { force: true }),
        rm(store.paths.controlResponse, { force: true }),
      ]);
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
    "generation",
  ] as const;
  if (
    value.schemaVersion !== 1 || strings.some((field) => typeof value[field] !== "string") ||
    (value.appServerVersion !== undefined && typeof value.appServerVersion !== "string")
  ) {
    throw new Error("malformed lifecycle metadata: invalid fields");
  }
  if (
    typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) ||
    !isPositiveInteger(value.hostPid) || !isPositiveInteger(value.nativePid) ||
    !parseProcessIdentity(value.hostIdentity) || !parseProcessIdentity(value.nativeIdentity)
  ) {
    throw new Error("malformed lifecycle metadata: invalid process identity");
  }
  return value as unknown as WindowsSharedMetadata;
}

interface HostLease {
  generation: string;
  hostPid: number;
  nativePid: number;
  hostIdentity: WindowsProcessIdentity;
  nativeIdentity: WindowsProcessIdentity;
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
    !isPositiveInteger(value.hostPid) || !isPositiveInteger(value.nativePid) ||
    !parseProcessIdentity(value.hostIdentity) || !parseProcessIdentity(value.nativeIdentity)
  ) {
    throw new Error("managed host lease is invalid");
  }
  return {
    generation: value.generation,
    hostPid: value.hostPid,
    nativePid: value.nativePid,
    hostIdentity: parseProcessIdentity(value.hostIdentity)!,
    nativeIdentity: parseProcessIdentity(value.nativeIdentity)!,
  };
}

async function challengeHost(
  paths: ReturnType<typeof createWindowsCoordinatorFileStore>["paths"],
  metadata: WindowsSharedMetadata,
  action: "probe" | "stop",
  timeoutMs: number,
): Promise<WindowsHostControlResponse> {
  const request: WindowsHostControlRequest = {
    schemaVersion: 1,
    action,
    nonce: randomUUID(),
    generation: metadata.generation,
    hostPid: metadata.hostPid,
    nativePid: metadata.nativePid,
  };
  await rm(paths.controlResponse, { force: true });
  await writeJsonAtomic(paths.controlRequest, request);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await readControlResponse(paths.controlResponse).catch(() => undefined);
    if (
      response?.nonce === request.nonce && response.action === request.action &&
      response.generation === request.generation && response.hostPid === request.hostPid &&
      response.nativePid === request.nativePid
    ) return response;
    await Bun.sleep(25);
  }
  throw new Error(`managed host ${action} control request timed out`);
}

async function readControlResponse(file: string): Promise<WindowsHostControlResponse> {
  const value: unknown = JSON.parse(await readBoundedFile(file, 4_096));
  if (!isControlMessage(value) || (value.status !== "alive" && value.status !== "stopped")) {
    throw new Error("managed host control response is invalid");
  }
  return value as unknown as WindowsHostControlResponse;
}

function isControlMessage(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.schemaVersion === 1 &&
    (value.action === "probe" || value.action === "stop") &&
    typeof value.nonce === "string" && typeof value.generation === "string" &&
    isPositiveInteger(value.hostPid) && isPositiveInteger(value.nativePid);
}

function parseProcessIdentity(value: unknown): WindowsProcessIdentity | undefined {
  if (
    !isRecord(value) || !isPositiveInteger(value.pid) ||
    !Number.isInteger(value.parentPid) || Number(value.parentPid) < 0 ||
    typeof value.creationDate !== "string" || value.creationDate.length === 0 ||
    typeof value.executablePath !== "string" || value.executablePath.length === 0 ||
    typeof value.commandLine !== "string" || value.commandLine.length === 0
  ) return undefined;
  return value as unknown as WindowsProcessIdentity;
}

function sameProcessIdentity(
  first: WindowsProcessIdentity | undefined,
  second: WindowsProcessIdentity | undefined,
): boolean {
  return Boolean(first && second && first.pid === second.pid &&
    first.parentPid === second.parentPid && first.creationDate === second.creationDate &&
    first.executablePath.toLowerCase() === second.executablePath.toLowerCase() &&
    first.commandLine === second.commandLine);
}

export async function describeWindowsProcess(pid: number): Promise<WindowsProcessIdentity> {
  if (!isPositiveInteger(pid)) throw new Error("invalid Windows process id");
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("SystemRoot is unavailable for process identity verification");
  }
  const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';` +
    `if($null -eq $p){exit 3};` +
    `[pscustomobject]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;` +
    `creationDate=[string]$p.CreationDate;executablePath=[string]$p.ExecutablePath;` +
    `commandLine=[string]$p.CommandLine}|ConvertTo-Json -Compress`;
  const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const output = readNodeStreamBounded(child.stdout!, 16_384);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Windows process identity query timed out for ${pid}`));
    }, 3_000);
  });
  let result: [Buffer, number | null];
  try {
    result = await Promise.race([Promise.all([output, closed]), timedOut]);
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const [stdout, exitCode] = result;
  if (exitCode === 3) throw new WindowsProcessNotFoundError(pid);
  if (exitCode !== 0) throw new Error(`Windows process identity query failed for ${pid}`);
  const identity = parseProcessIdentity(JSON.parse(stdout.toString("utf8")));
  if (!identity || identity.pid !== pid) throw new Error("Windows process identity is invalid");
  return identity;
}

async function readNodeStreamBounded(
  stream: NodeJS.ReadableStream,
  maximumBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximumBytes) throw new Error("Windows process identity response is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export class WindowsProcessNotFoundError extends Error {
  constructor(public readonly pid: number) {
    super(`Windows process ${pid} does not exist`);
    this.name = "WindowsProcessNotFoundError";
  }
}

async function processIdentityGone(identity: WindowsProcessIdentity): Promise<boolean> {
  try {
    const current = await describeWindowsProcess(identity.pid);
    return !sameProcessIdentity(current, identity);
  } catch (error) {
    if (error instanceof WindowsProcessNotFoundError) return true;
    throw error;
  }
}

async function readBoundedFile(file: string, maximumBytes: number): Promise<string> {
  const info = await stat(file);
  if (info.size > maximumBytes) throw new Error("managed lifecycle file is too large");
  return readFile(file, "utf8");
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value), "utf8");
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
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
    const value: unknown = await readFile(lockPath, "utf8")
      .then((source) => JSON.parse(source) as unknown)
      .catch(() => undefined);
    if (!isRecord(value) || !isPositiveInteger(value.pid)) return true;
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
