import path from "node:path";
import { MAX_BROWSER_MESSAGE_BYTES } from "../shared/protocol";

import { CodexAdapter } from "./app-server/adapter";
import { AppServerProcessManager, shouldInterruptOnWebShutdown } from "./app-server/process-manager";
import { parseWindowsSharedPolicy } from "./app-server/windows-managed-backend";
import { parseAuthConfig } from "./auth/config";
import { selectHostPlatform } from "./platform";
import { createSystemRuntime } from "./platform/system-runtime";
import { BrowserGateway, type BrowserActions } from "./service/gateway";
import { DirectoryService } from "./service/directories";
import { createBunFetchHandler, createWebSocketLifecycle } from "./service/server";
import { WebState } from "./service/state";
import { SettingsStore } from "./service/settings";
import { LocalEventLog, secretEnvironmentValues } from "./service/local-log";
import { AttachmentStore } from "./service/attachment-store";
import { TurnCoordinator } from "./service/turn-coordinator";
import { ThreadCatalogRefresher } from "./service/thread-catalog";
import { ThreadAccessController } from "./service/thread-access";

const hostname = "127.0.0.1";
const port = parsePort(process.env.CODEX_WEB_PORT);
const platform = selectHostPlatform(process.platform, createSystemRuntime());
const localLog = new LocalEventLog(platform.dataDirectory(), secretEnvironmentValues(process.env));
const state = new WebState(platform.kind, (type, payload) => localLog.append(type, payload));
const manager = new AppServerProcessManager(platform, {
  configuredExecutable: process.env.CODEX_WEB_CODEX_EXECUTABLE,
  env: environmentStrings(process.env),
  windowsPolicy: platform.kind === "windows"
    ? parseWindowsSharedPolicy(process.env.CODEX_WEB_WINDOWS_SHARED)
    : undefined,
});
let adapter: CodexAdapter | undefined;
const directories = new DirectoryService(
  platform,
  (process.env.CODEX_WEB_BROWSE_ROOTS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean),
);

function readyAdapter(): CodexAdapter {
  if (!adapter) throw new Error("notReady: Codex app-server is starting");
  return adapter;
}

const attachments = new AttachmentStore(platform, platform.dataDirectory());
const coordinator = new TurnCoordinator(state, attachments, readyAdapter);
const catalog = new ThreadCatalogRefresher(
  () => readyAdapter().listThreads(),
  {
    onError: (error) => state.addDiagnostic(`thread catalog refresh: ${error.message}`),
  },
);
const threadAccess = new ThreadAccessController({
  resumeThread: (threadId, access) => readyAdapter().resumeThread(threadId, access),
  readThread: (threadId, access) => readyAdapter().readThread(threadId, access),
});

const actions: BrowserActions = {
  listDirectory: (directory) => directories.list(directory),
  models: () => readyAdapter().models(),
  permissionProfiles: () => readyAdapter().permissionProfiles(),
  listThreads: async (cursor) => {
    if (cursor) return readyAdapter().listThreads(cursor);
    return (await catalog.refreshNow()) ?? {
      data: state.snapshot().threads,
      nextCursor: null,
    };
  },
  startThread: (params) => readyAdapter().startThread(params),
  openThread: (threadId) => threadAccess.open(threadId),
  resumeThread: (threadId) => readyAdapter().resumeThread(threadId),
  readThread: (threadId) => readyAdapter().readThread(threadId),
  startTurn: (threadId, text, attachmentSessionId, taskSettings) =>
    coordinator.start(threadId, text, attachmentSessionId, taskSettings),
  interruptTurn: (threadId, turnId) => readyAdapter().interruptTurn(threadId, turnId),
  updateThreadSettings: (threadId, taskSettings) =>
    readyAdapter().updateThreadSettings(threadId, taskSettings),
  startReview: (threadId) => readyAdapter().startReview(threadId),
  resolveApproval: (id, decision, deviceId) =>
    readyAdapter().resolveApproval(id, decision, deviceId),
};
let browserConnections = 0;
const gateway = new BrowserGateway(state, actions, {
  onConnectionCountChanged(count) {
    while (browserConnections < count) {
      catalog.browserConnected();
      browserConnections += 1;
    }
    while (browserConnections > count) {
      catalog.browserDisconnected();
      browserConnections -= 1;
    }
  },
});
const settings = new SettingsStore(platform.dataDirectory());
const lifecycle = createWebSocketLifecycle(gateway);
const auth = parseAuthConfig(process.env);
if (auth.mode === "local") {
  const ownOrigin = `http://${hostname}:${port}`;
  if (!auth.origins.includes(ownOrigin)) auth.origins.push(ownOrigin);
}
const fetch = createBunFetchHandler({
  auth,
  state,
  gateway,
  staticRoot: path.resolve(import.meta.dir, "../../dist"),
  settings,
  attachments,
});

let readyGeneration = 0;
manager.onState((snapshot) => {
  readyGeneration += 1;
  const generation = readyGeneration;
  if (snapshot.status === "ready") {
    const nextAdapter = new CodexAdapter(manager.peer(), state, platform);
    const loadedThreadId = state.snapshot().loadedThreadId;
    void Promise.all([
      loadCapability("models", () => nextAdapter.models()),
      loadCapability("permission profiles", () => nextAdapter.permissionProfiles()),
      loadCapability("thread catalog", () => nextAdapter.listThreads()),
      ...(loadedThreadId
        ? [loadCapability(
            "loaded thread",
            () => new ThreadAccessController(nextAdapter).open(loadedThreadId),
          )]
        : []),
    ]).then(() => {
      if (generation !== readyGeneration || manager.snapshot().status !== "ready") return;
      adapter = nextAdapter;
      state.setService({
        status: "ready",
        ...(snapshot.codexVersion ? { codexVersion: snapshot.codexVersion } : {}),
        ...(snapshot.cliVersion ? { cliVersion: snapshot.cliVersion } : {}),
        ...(snapshot.appServerVersion ? { appServerVersion: snapshot.appServerVersion } : {}),
        ...(snapshot.restartRequired ? { restartRequired: true } : {}),
        ...(snapshot.liveHandoff ? { liveHandoff: snapshot.liveHandoff } : {}),
      });
    });
    return;
  }
  adapter = undefined;
  state.interruptActiveWork();
  const diagnosticId = snapshot.error ? crypto.randomUUID() : undefined;
  if (snapshot.error && diagnosticId) {
    state.addDiagnostic(`${snapshot.error}\n${manager.diagnostics()}\nDiagnostic ${diagnosticId}`);
  }
  state.setService({
    status: snapshot.status,
    ...(snapshot.codexVersion ? { codexVersion: snapshot.codexVersion } : {}),
    ...(snapshot.cliVersion ? { cliVersion: snapshot.cliVersion } : {}),
    ...(snapshot.appServerVersion ? { appServerVersion: snapshot.appServerVersion } : {}),
    ...(snapshot.restartRequired ? { restartRequired: true } : {}),
    ...(snapshot.liveHandoff ? { liveHandoff: snapshot.liveHandoff } : {}),
    ...(snapshot.error
      ? {
          error: {
            code: snapshot.status === "unavailable" ? "codexUnavailable" : "interrupted",
            message:
              snapshot.status === "unavailable"
                ? "Codex is unavailable. Check the server diagnostics."
                : "Codex restarted and active work was interrupted.",
            retryable: snapshot.status !== "unavailable",
            diagnosticId,
          } as const,
        }
      : {}),
  });
});

const server = Bun.serve({
  hostname,
  port,
  fetch,
  websocket: {
    ...lifecycle,
    maxPayloadLength: MAX_BROWSER_MESSAGE_BYTES,
    backpressureLimit: 1_048_576,
    closeOnBackpressureLimit: true,
  },
});

console.log(`Codex Web listening on ${server.url}`);
void manager.start().catch((error) => {
  const diagnosticId = crypto.randomUUID();
  state.addDiagnostic(`${diagnosticId}: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`Codex Web failed to start app-server (diagnostic ${diagnosticId})`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.stop(false);
  const activeTurn = state.snapshot().activeTurn;
  if (
    shouldInterruptOnWebShutdown(manager.snapshot()) &&
    adapter &&
    activeTurn?.status === "inProgress"
  ) {
    await Promise.race([
      adapter.interruptTurn(activeTurn.threadId, activeTurn.id),
      Bun.sleep(1_500),
    ]).catch(() => undefined);
  }
  state.interruptActiveWork();
  await manager.stop();
  catalog.close();
  coordinator.close();
  await attachments.close();
  await localLog.flush();
  process.exit(0);
}

async function loadCapability(label: string, load: () => Promise<unknown>): Promise<void> {
  try {
    await load();
  } catch (error) {
    const diagnosticId = crypto.randomUUID();
    state.addDiagnostic(
      `${diagnosticId}: ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "4173");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CODEX_WEB_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function environmentStrings(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
