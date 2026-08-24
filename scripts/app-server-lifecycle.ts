import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { runWindowsAppServerHost } from "../src/server/app-server/windows-app-server-host";
import {
  createWindowsCoordinatorFileStore,
  createWindowsCoordinatorRuntime,
  describeWindowsProcess,
  WindowsProcessNotFoundError,
} from "../src/server/app-server/windows-coordinator-runtime";
import type { WindowsHostControlRequest } from "../src/server/app-server/windows-app-server-host";
import { WindowsSharedAppServerCoordinator } from "../src/server/app-server/windows-shared-coordinator";
import { parseManagedLoopbackEndpoint } from "../src/server/app-server/tcp-websocket-transport";
import {
  LocalEventLog,
  redactSecrets,
  secretEnvironmentValues,
} from "../src/server/service/local-log";

type LifecycleArguments =
  | { command: "start" | "status" | "stop" | "restart" }
  | {
      command: "host";
      endpoint: string;
      codexHome: string;
      executable: string;
      generation: string;
      dataDirectory: string;
    };

export function parseLifecycleArguments(args: string[]): LifecycleArguments {
  const command = args[0];
  if (command === "start" || command === "status" || command === "stop" || command === "restart") {
    if (args.length !== 1) throw new Error("unexpected argument after lifecycle command");
    return { command };
  }
  if (command !== "host") throw new Error("expected start, status, stop, restart, or host");
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value) throw new Error("invalid host lifecycle arguments");
    if (values.has(flag)) throw new Error(`duplicate host argument ${flag}`);
    values.set(flag, value);
  }
  const required = ["--endpoint", "--codex-home", "--executable", "--generation", "--data-directory"];
  for (const flag of required) if (!values.get(flag)) throw new Error(`missing host argument ${flag}`);
  if ([...values.keys()].some((flag) => !required.includes(flag))) {
    throw new Error("unexpected host argument");
  }
  return {
    command: "host",
    endpoint: values.get("--endpoint")!,
    codexHome: values.get("--codex-home")!,
    executable: values.get("--executable")!,
    generation: values.get("--generation")!,
    dataDirectory: values.get("--data-directory")!,
  };
}

export function validateRemoteCliArguments(args: string[]): void {
  for (const argument of args) {
    if (
      argument === "--remote" || argument.startsWith("--remote=") ||
      argument === "--remote-auth-token-env" ||
      argument.startsWith("--remote-auth-token-env=")
    ) {
      throw new Error("CLI arguments must not replace the managed remote endpoint");
    }
  }
}

export function buildRemoteCliArguments(endpoint: string, args: string[]): string[] {
  parseManagedLoopbackEndpoint(endpoint);
  validateRemoteCliArguments(args);
  return ["--remote", endpoint, ...args];
}

if (import.meta.main) {
  try {
    const args = parseLifecycleArguments(process.argv.slice(2));
    if (args.command === "host") {
      process.exitCode = await runHost(args);
    } else {
      await runPublicCommand(args.command);
    }
  } catch (error) {
    await recordLifecycleFailure(error);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function recordLifecycleFailure(error: unknown): Promise<void> {
  const localAppData = process.env.LOCALAPPDATA;
  if (process.platform !== "win32" || !localAppData) return;
  const log = new LocalEventLog(
    path.win32.join(localAppData, "Codex Web"),
    secretEnvironmentValues(process.env),
  );
  log.append("diagnostic", {
    component: "windows-shared-lifecycle",
    message: error instanceof Error ? error.message : String(error),
  });
  await log.flush();
}

async function runPublicCommand(command: "start" | "status" | "stop" | "restart"): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows shared lifecycle is Windows-only");
  const executable = process.env.CODEX_WEB_CODEX_EXECUTABLE ?? Bun.which("codex.exe");
  if (!executable || !path.win32.isAbsolute(executable)) {
    throw new Error("Codex executable was not found as an absolute Windows path");
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is not configured");
  const codexHome = path.win32.resolve(
    process.env.CODEX_HOME ?? path.win32.join(process.env.USERPROFILE ?? "", ".codex"),
  );
  const endpoint = parseManagedLoopbackEndpoint(
    process.env.CODEX_WEB_APP_SERVER_URL ?? "ws://127.0.0.1:4500",
  ).href.replace(/\/$/, "");
  const cliVersion = await readCodexVersion(executable);
  const dataDirectory = path.win32.join(localAppData, "Codex Web");
  const runtime = createWindowsCoordinatorRuntime({
    dataDirectory,
    codexHome,
    cliVersion,
    bunExecutable: process.execPath,
    lifecycleScript: import.meta.path,
    env: environmentStrings(process.env),
  });
  const coordinator = new WindowsSharedAppServerCoordinator({
    endpoint,
    codexHome,
    executable,
    cliVersion,
    runtime,
  });
  const result = command === "start"
    ? await coordinator.ensure()
    : command === "restart"
      ? await coordinator.restart()
      : command === "status"
        ? { status: await coordinator.status() }
        : await coordinator.stop().then(() => ({ status: "stopped" as const }));
  console.log(JSON.stringify(result));
}

async function runHost(args: Extract<LifecycleArguments, { command: "host" }>): Promise<number> {
  parseManagedLoopbackEndpoint(args.endpoint);
  const store = createWindowsCoordinatorFileStore(args.dataDirectory, args.codexHome);
  await mkdir(store.paths.directory, { recursive: true });
  const secrets = secretEnvironmentValues(process.env);
  return runWindowsAppServerHost(args, {
    hostPid: process.pid,
    now: Date.now,
    spawn(command, env) {
      return Bun.spawn(command, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    },
    writeLease: (lease) => writeJsonAtomic(store.paths.lease, lease),
    describeProcess: describeWindowsProcess,
    async readControlRequest() {
      const value: unknown = JSON.parse(await readBoundedFile(store.paths.controlRequest, 4_096));
      if (
        typeof value !== "object" || value === null || Array.isArray(value) ||
        value.schemaVersion !== 1 || (value.action !== "probe" && value.action !== "stop") ||
        typeof value.nonce !== "string" || typeof value.generation !== "string" ||
        !Number.isInteger(value.hostPid) || !Number.isInteger(value.nativePid)
      ) throw new Error("managed host control request is invalid");
      return value as WindowsHostControlRequest;
    },
    writeControlResponse: (response) => writeJsonAtomic(store.paths.controlResponse, response),
    async stopProcessTree(child) {
      const systemRoot = process.env.SystemRoot;
      if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
        throw new Error("SystemRoot is unavailable for managed process-tree stop");
      }
      const taskkill = path.win32.join(systemRoot, "System32", "taskkill.exe");
      const stop = Bun.spawn([taskkill, "/PID", String(child.pid), "/T", "/F"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      const completed = Promise.all([
        stop.exited,
        readStreamBounded(stop.stderr, 4_096),
      ]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          stop.kill();
          reject(new Error("managed process-tree stop timed out"));
        }, 10_000);
      });
      let result: [number, string];
      try {
        result = await Promise.race([completed, timeout]);
      } catch (error) {
        stop.kill();
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
      const [exitCode, stderr] = result;
      if (exitCode !== 0) {
        try {
          await describeWindowsProcess(child.pid);
          throw new Error(`managed process-tree stop failed: ${stderr.slice(0, 1_024)}`);
        } catch (error) {
          if (!(error instanceof WindowsProcessNotFoundError)) throw error;
        }
      }
    },
    sleep: Bun.sleep,
    writeDiagnostics: (source) => writeFile(
      store.paths.diagnostics,
      redactSecrets(source, secrets),
      { mode: 0o600 },
    ),
  });
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}

async function readBoundedFile(file: string, maximumBytes: number): Promise<string> {
  const info = await stat(file);
  if (info.size > maximumBytes) throw new Error("managed lifecycle file is too large");
  return readFile(file, "utf8");
}

async function readCodexVersion(executable: string): Promise<string> {
  const child = Bun.spawn([executable, "--version"], { stdout: "pipe", stderr: "pipe" });
  const completed = Promise.all([
    readStreamBounded(child.stdout, 4_096),
    readStreamBounded(child.stderr, 4_096),
    child.exited,
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      child.kill();
      reject(new Error("Codex --version timed out"));
    }, 5_000);
  });
  let result: [string, string, number];
  try {
    result = await Promise.race([completed, timeout]);
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const [stdout, _stderr, exitCode] = result;
  if (exitCode !== 0) throw new Error(`Codex --version exited with ${exitCode}`);
  const version = stdout.split(/\r?\n/, 1)[0]?.trim();
  if (!version || version.length > 512) throw new Error("Codex --version returned an invalid version");
  return version;
}

async function readStreamBounded(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return result + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new Error("Codex --version output exceeded limit");
      }
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function environmentStrings(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
