import path from "node:path";
import { MAX_BROWSER_MESSAGE_BYTES } from "../shared/protocol";

import { CodexAdapter } from "./app-server/adapter";
import { AppServerProcessManager } from "./app-server/process-manager";
import { parseAuthConfig } from "./auth/config";
import { selectHostPlatform } from "./platform";
import { createSystemRuntime } from "./platform/system-runtime";
import { BrowserGateway, type BrowserActions } from "./service/gateway";
import { DirectoryService } from "./service/directories";
import { createBunFetchHandler, createWebSocketLifecycle } from "./service/server";
import { WebState } from "./service/state";
import { SettingsStore } from "./service/settings";
import { LocalEventLog, secretEnvironmentValues } from "./service/local-log";

const hostname = "127.0.0.1";
const port = parsePort(process.env.CODEX_WEB_PORT);
const platform = selectHostPlatform(process.platform, createSystemRuntime());
const localLog = new LocalEventLog(platform.dataDirectory(), secretEnvironmentValues(process.env));
const state = new WebState(platform.kind, (type, payload) => localLog.append(type, payload));
const manager = new AppServerProcessManager(platform, {
  configuredExecutable: process.env.CODEX_WEB_CODEX_EXECUTABLE,
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

const actions: BrowserActions = {
  listDirectory: (directory) => directories.list(directory),
  models: () => readyAdapter().models(),
  listThreads: (cursor) => readyAdapter().listThreads(cursor),
  startThread: (params) => readyAdapter().startThread(params),
  resumeThread: (threadId) => readyAdapter().resumeThread(threadId),
  readThread: (threadId) => readyAdapter().readThread(threadId),
  startTurn: (threadId, text) => readyAdapter().startTurn(threadId, text),
  interruptTurn: (threadId, turnId) => readyAdapter().interruptTurn(threadId, turnId),
  resolveApproval: (id, decision, deviceId) =>
    readyAdapter().resolveApproval(id, decision, deviceId),
};
const gateway = new BrowserGateway(state, actions);
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
});

manager.onState((snapshot) => {
  if (snapshot.status === "ready") {
    adapter = new CodexAdapter(manager.peer(), state, platform);
    state.setService({
      status: "ready",
      ...(snapshot.codexVersion ? { codexVersion: snapshot.codexVersion } : {}),
    });
    void Promise.all([adapter.models(), adapter.listThreads()]).catch((error) => {
      const diagnosticId = crypto.randomUUID();
      state.addDiagnostic(`${diagnosticId}: ${error instanceof Error ? error.message : String(error)}`);
      state.setService({
        status: "ready",
        ...(snapshot.codexVersion ? { codexVersion: snapshot.codexVersion } : {}),
        error: {
          code: "compatibilityError",
          message: `Codex ${snapshot.codexVersion ?? "app-server"} could not provide models or tasks.`,
          retryable: false,
          diagnosticId,
        },
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
  if (adapter && activeTurn?.status === "inProgress") {
    await Promise.race([
      adapter.interruptTurn(activeTurn.threadId, activeTurn.id),
      Bun.sleep(1_500),
    ]).catch(() => undefined);
  }
  state.interruptActiveWork();
  await manager.stop();
  await localLog.flush();
  process.exit(0);
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
