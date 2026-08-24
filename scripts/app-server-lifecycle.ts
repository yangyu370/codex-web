import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { runWindowsAppServerHost } from "../src/server/app-server/windows-app-server-host";
import {
  createWindowsCoordinatorFileStore,
  createWindowsCoordinatorRuntime,
} from "../src/server/app-server/windows-coordinator-runtime";
import { WindowsSharedAppServerCoordinator } from "../src/server/app-server/windows-shared-coordinator";
import { parseManagedLoopbackEndpoint } from "../src/server/app-server/tcp-websocket-transport";

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
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
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
  return runWindowsAppServerHost(args, {
    hostPid: process.pid,
    now: Date.now,
    spawn(command, env) {
      return Bun.spawn(command, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    },
    writeLease: (lease) => writeJsonAtomic(store.paths.lease, lease),
    writeDiagnostics: (source) => writeFile(store.paths.diagnostics, source, { mode: 0o600 }),
  });
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}

async function readCodexVersion(executable: string): Promise<string> {
  const child = Bun.spawn([executable, "--version"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`Codex --version exited with ${exitCode}`);
  const version = stdout.split(/\r?\n/, 1)[0]?.trim();
  if (!version || version.length > 512) throw new Error("Codex --version returned an invalid version");
  return version;
}

function environmentStrings(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
