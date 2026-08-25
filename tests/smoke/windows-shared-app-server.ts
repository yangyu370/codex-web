import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CodexAdapter } from "../../src/server/app-server/adapter";
import { AppServerProcessManager } from "../../src/server/app-server/process-manager";
import { createWindowsCoordinatorRuntime } from "../../src/server/app-server/windows-coordinator-runtime";
import { WindowsSharedAppServerCoordinator } from "../../src/server/app-server/windows-shared-coordinator";
import { JsonRpcPeer } from "../../src/server/app-server/json-rpc";
import { connectTcpWebSocket } from "../../src/server/app-server/tcp-websocket-transport";
import { selectHostPlatform, type HostPlatform } from "../../src/server/platform";
import { createSystemRuntime } from "../../src/server/platform/system-runtime";
import { WebState } from "../../src/server/service/state";

if (process.env.CODEX_WEB_SMOKE_WINDOWS !== "1") {
  console.log("Set CODEX_WEB_SMOKE_WINDOWS=1 to run the Windows shared app-server smoke test.");
  process.exit(0);
}
if (process.platform !== "win32") {
  console.log("The Windows shared app-server smoke test is Windows-only.");
  process.exit(0);
}

const root = await mkdtemp(path.join(tmpdir(), "codex-web-windows-smoke-"));
const codexHome = path.join(root, "codex-home");
const dataDirectory = path.join(root, "data");
const projectDirectory = path.join(root, "project");
const nativePlatform = selectHostPlatform(process.platform, createSystemRuntime());
const platform: HostPlatform = {
  kind: nativePlatform.kind,
  arch: nativePlatform.arch,
  resolveCodexExecutable: (configured) => nativePlatform.resolveCodexExecutable(configured),
  validateWorkingDirectory: (input) => nativePlatform.validateWorkingDirectory(input),
  spawnAppServer: (executable, env) => nativePlatform.spawnAppServer(executable, env),
  spawnCommand: (command, env) => nativePlatform.spawnCommand(command, env),
  terminateProcessTree: (child) => nativePlatform.terminateProcessTree(child),
  homeDirectory: () => nativePlatform.homeDirectory(),
  dataDirectory: () => dataDirectory,
  diagnostics: () => nativePlatform.diagnostics(),
};

let manager: AppServerProcessManager | undefined;
let coordinator: WindowsSharedAppServerCoordinator | undefined;
let peer: Awaited<ReturnType<AppServerProcessManager["start"]>> | undefined;
let observer: JsonRpcPeer | undefined;
let threadId: string | undefined;
let failure: unknown;
const cleanupErrors: unknown[] = [];
try {
  await Promise.all([
    mkdir(codexHome, { recursive: true }),
    mkdir(projectDirectory, { recursive: true }),
  ]);
  const sourceHome = process.env.CODEX_HOME ?? path.join(platform.homeDirectory(), ".codex");
  await copyFile(path.join(sourceHome, "auth.json"), path.join(codexHome, "auth.json")).catch(
    (error: unknown) => {
      throw new Error(`Windows smoke requires an authenticated Codex home: ${String(error)}`);
    },
  );
  const endpoint = await unusedLoopbackEndpoint();
  const executable = await platform.resolveCodexExecutable(
    process.env.CODEX_WEB_CODEX_EXECUTABLE,
  );
  const env = {
    ...environmentStrings(process.env),
    CODEX_HOME: codexHome,
    CODEX_WEB_APP_SERVER_URL: endpoint,
  };
  manager = new AppServerProcessManager(platform, {
    configuredExecutable: executable,
    env,
    windowsPolicy: "required",
  });
  peer = await manager.start();
  const snapshot = manager.snapshot();
  if (!snapshot.cliVersion) throw new Error("Windows smoke did not resolve a CLI version");
  coordinator = new WindowsSharedAppServerCoordinator({
    endpoint,
    codexHome: path.win32.resolve(codexHome),
    executable,
    cliVersion: snapshot.cliVersion,
    runtime: createWindowsCoordinatorRuntime({
      dataDirectory,
      codexHome: path.win32.resolve(codexHome),
      cliVersion: snapshot.cliVersion,
      bunExecutable: process.execPath,
      lifecycleScript: path.resolve(import.meta.dir, "../../scripts/app-server-lifecycle.ts"),
      env,
    }),
  });
  if (
    snapshot.mode !== "shared" || snapshot.sharedBackend !== "managedTcp" ||
    snapshot.liveHandoff !== "available"
  ) {
    throw new Error(`Windows smoke did not establish managed TCP mode: ${JSON.stringify(snapshot)}`);
  }
  observer = new JsonRpcPeer(await connectTcpWebSocket(endpoint));
  await observer.request("initialize", {
    clientInfo: { name: "codex-web-windows-smoke-observer", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  observer.notify("initialized");

  const state = new WebState("windows");
  const adapter = new CodexAdapter(peer, state, platform);
  const models = await adapter.models();
  const profiles = await adapter.permissionProfiles();
  const model = models.find((entry) => entry.isDefault) ?? models[0];
  const thread = await adapter.startThread({ cwd: projectDirectory, model: model?.id });
  threadId = thread.id;
  const effort = model?.defaultReasoningEffort ?? model?.supportedReasoningEfforts?.[0]?.id;
  const permissionProfile = profiles.find((entry) => entry.allowed)?.id;
  const observedFirstTurn = waitForNotification(observer, "turn/completed");
  const turn = await adapter.startTurn(
    thread.id,
    [{ type: "text", text: "Reply with exactly: WINDOWS_SHARED_READY" }],
    {
      ...(model ? { model: model.id } : {}),
      ...(effort ? { effort } : {}),
      ...(permissionProfile ? { permissionProfile } : {}),
    },
  );
  await waitFor(
    () => state.snapshot().activeTurn?.id === turn.id &&
      state.snapshot().activeTurn?.status === "completed",
    "Windows shared app-server did not complete the smoke turn",
  );
  await observedFirstTurn;
  if (!state.snapshot().visibleItems.some(
    (item) => item.type === "message" && item.role === "assistant" &&
      item.text.trim() === "WINDOWS_SHARED_READY",
  )) {
    throw new Error("Windows shared smoke did not observe the expected first response");
  }

  await manager.stop();
  const observedContinuation = waitForNotification(observer, "turn/completed");
  await observer.request("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "Reply with exactly: WINDOWS_SHARED_CONTINUED" }],
  });
  await observedContinuation;
  const durable = await observer.request("thread/read", {
    threadId: thread.id,
    includeTurns: true,
  });
  if (!JSON.stringify(durable).includes("WINDOWS_SHARED_CONTINUED")) {
    throw new Error("Windows shared app-server did not survive the Web client disconnect");
  }
  console.log(
    `Windows managed TCP smoke passed with ${models.length} model(s) and app-server ${snapshot.appServerVersion}.`,
  );
} catch (error) {
  failure = error;
} finally {
  if (threadId && observer) {
    await collect(observer.request("thread/archive", { threadId }), cleanupErrors);
  } else if (threadId && peer) {
    await collect(peer.request("thread/archive", { threadId }), cleanupErrors);
  }
  observer?.close();
  if (manager) await collect(manager.stop(), cleanupErrors);
  if (coordinator) await collect(coordinator.stop(), cleanupErrors);
  await collect(rm(root, { recursive: true, force: true }), cleanupErrors);
}

function waitForNotification(peer: JsonRpcPeer, method: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Windows shared smoke timed out waiting for ${method}`));
    }, 30_000);
    const unsubscribe = peer.onNotification((notification) => {
      if (notification.method !== method) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}

if (failure) throw failure;
if (cleanupErrors.length > 0) {
  throw new AggregateError(cleanupErrors, "Windows shared smoke cleanup failed");
}

async function unusedLoopbackEndpoint(): Promise<string> {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const endpoint = `ws://127.0.0.1:${reservation.port}`;
  reservation.stop(true);
  return endpoint;
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(message);
}

async function collect(operation: Promise<unknown>, errors: unknown[]): Promise<void> {
  try {
    await operation;
  } catch (error) {
    errors.push(error);
  }
}

function environmentStrings(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
