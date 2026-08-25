import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CodexAdapter } from "../../src/server/app-server/adapter";
import { decodeThreadEnvelope } from "../../src/server/app-server/decoders";
import { AppServerProcessManager } from "../../src/server/app-server/process-manager";
import { selectHostPlatform } from "../../src/server/platform";
import { createSystemRuntime } from "../../src/server/platform/system-runtime";
import { WebState } from "../../src/server/service/state";

if (process.env.CODEX_WEB_SMOKE !== "1") {
  console.log("Set CODEX_WEB_SMOKE=1 to run the shared-daemon native smoke test.");
  process.exit(0);
}

const platform = selectHostPlatform(process.platform, createSystemRuntime());
if (platform.kind !== "macos") {
  console.log("The shared-daemon native smoke test is macOS-only.");
  process.exit(0);
}

let directory: string | undefined;
let codexHome: string | undefined;
let executable: string | undefined;
let nativeEnvironment: Record<string, string> | undefined;
let manager: AppServerProcessManager | undefined;
let observer: AppServerProcessManager | undefined;
let observerState: WebState | undefined;
let archivePeer: Awaited<ReturnType<AppServerProcessManager["start"]>> | undefined;
let createdThreadId: string | undefined;
let summary: string | undefined;
let failure: unknown;
const cleanupErrors: unknown[] = [];
try {
  directory = await mkdtemp(path.join(tmpdir(), "codex-web-smoke-"));
  // Unix-domain sockets on macOS have a short path limit, so keep the isolated
  // daemon home under the short /tmp alias rather than the long Darwin temp path.
  codexHome = await mkdtemp("/tmp/cw-home-");
  const sourceCodexHome = process.env.CODEX_HOME
    ?? path.join(platform.homeDirectory(), ".codex");
  await symlink(
    path.join(sourceCodexHome, "auth.json"),
    path.join(codexHome, "auth.json"),
  ).catch((error: unknown) => {
    throw new Error(`Native smoke requires an authenticated Codex home: ${String(error)}`);
  });
  nativeEnvironment = {
    ...environmentStrings(process.env),
    CODEX_HOME: codexHome,
  };
  executable = await platform.resolveCodexExecutable(
    process.env.CODEX_WEB_CODEX_EXECUTABLE,
  );
  const managedExecutableDirectory = path.join(codexHome, "packages", "standalone", "current");
  await mkdir(managedExecutableDirectory, { recursive: true });
  await symlink(executable, path.join(managedExecutableDirectory, "codex"));
  manager = new AppServerProcessManager(platform, {
    configuredExecutable: executable,
    env: nativeEnvironment,
  });
  const peer = await manager.start();
  archivePeer = peer;
  const primaryState = new WebState(platform.kind);
  const adapter = new CodexAdapter(peer, primaryState, platform);
  const models = await adapter.models();
  const profiles = await adapter.permissionProfiles();
  await adapter.listThreads();
  let observerPeer: Awaited<ReturnType<AppServerProcessManager["start"]>> | undefined;
  let observerAdapter: CodexAdapter | undefined;
  const observedThreadIds = new Set<string>();
  const observedTurnStatuses = new Map<string, Set<string>>();
  observer = new AppServerProcessManager(platform, {
    configuredExecutable: executable,
    env: nativeEnvironment,
  });
  observerPeer = await observer.start();
  if (manager.snapshot().mode !== "shared" || observer.snapshot().mode !== "shared") {
    throw new Error(
      `macOS smoke did not establish two shared daemon clients: ` +
      `${JSON.stringify({ primary: manager.snapshot(), observer: observer.snapshot() })}`,
    );
  }
  observerState = new WebState("macos");
  observerState.onEvent((event) => {
    const payload = typeof event.payload === "object" && event.payload !== null
      ? event.payload as Record<string, unknown>
      : {};
    const thread = typeof payload.thread === "object" && payload.thread !== null
      ? payload.thread as Record<string, unknown>
      : undefined;
    if (typeof thread?.id === "string") observedThreadIds.add(thread.id);
    const activeTurn = typeof payload.activeTurn === "object" && payload.activeTurn !== null
      ? payload.activeTurn as Record<string, unknown>
      : undefined;
    if (typeof activeTurn?.id === "string" && typeof activeTurn.status === "string") {
      const statuses = observedTurnStatuses.get(activeTurn.id) ?? new Set<string>();
      statuses.add(activeTurn.status);
      observedTurnStatuses.set(activeTurn.id, statuses);
    }
  });
  observerAdapter = new CodexAdapter(observerPeer, observerState, platform);
  const preferredModel = models.find((model) => model.isDefault) ?? models[0];
  const thread = await adapter.startThread({ cwd: directory, model: preferredModel?.id });
  createdThreadId = thread.id;
  await waitFor(
    () => observedThreadIds.has(thread.id),
    "Shared daemon client did not observe the new thread",
  );
  const effort = preferredModel?.defaultReasoningEffort
    ?? preferredModel?.supportedReasoningEfforts?.[0]?.id;
  const permissionProfile = profiles.find((profile) => profile.allowed)?.id;
  if (effort || permissionProfile) {
    await adapter.updateThreadSettings(thread.id, {
      ...(effort ? { effort } : {}),
      ...(permissionProfile ? { permissionProfile } : {}),
    });
  }
  const read = decodeThreadEnvelope(
    await peer.request("thread/read", { threadId: thread.id, includeTurns: false }),
  );
  if (read.thread.id !== thread.id) throw new Error("Native smoke read the wrong thread");
  const turnSettings = {
    ...(preferredModel ? { model: preferredModel.id } : {}),
    ...(effort ? { effort } : {}),
    ...(permissionProfile ? { permissionProfile } : {}),
  };
  const seedTurn = await adapter.startTurn(
    thread.id,
    [{ type: "text", text: "Reply with exactly: READY" }],
    turnSettings,
  );
  await waitFor(
    () => primaryState.snapshot().activeTurn?.id === seedTurn.id
      && primaryState.snapshot().activeTurn?.status === "completed",
    "Primary client did not complete the seed turn required to persist the thread",
    1_200,
  );
  const initialResume = await observerAdapter.resumeThread(thread.id);
  if (initialResume.id !== thread.id) {
    throw new Error("Shared daemon observer initially resumed the wrong thread");
  }
  const turn = await adapter.startTurn(
    thread.id,
    [{ type: "text", text: "Reply with exactly: OK" }],
    turnSettings,
  );
  await manager.stop();
  archivePeer = observerPeer;
  const daemonStatus = await runDaemonCommand(executable, nativeEnvironment, "version");
  if (daemonStatus.status !== "running") {
    throw new Error("Shared daemon stopped when the primary client disconnected");
  }
  await waitFor(
    () => observedTurnStatuses.get(turn.id)?.has("completed") === true,
    "Observer did not receive the completed turn after the primary client disconnected",
    1_200,
  );
  const statuses = observedTurnStatuses.get(turn.id);
  if (!statuses?.has("inProgress") || statuses.has("failed") || statuses.has("interrupted")) {
    throw new Error(`Observer received invalid shared turn states: ${[...(statuses ?? [])].join(", ")}`);
  }
  const resumed = await observerAdapter.resumeThread(thread.id).catch((error: unknown) => {
    const diagnostics = observerState?.diagnostics().join(" | ") ?? "no diagnostics";
    throw new Error(
      `Shared daemon observer could not resume the thread: ${String(error)}; ${diagnostics}`,
    );
  });
  if (resumed.id !== thread.id) throw new Error("Shared daemon observer resumed the wrong thread");
  summary = `Native macOS smoke passed with two daemon clients, ${models.length} model(s), ` +
    `${profiles.length} permission profile(s), and one continued turn.`;
} catch (error) {
  failure = error;
} finally {
  if (createdThreadId && archivePeer) {
    await collectCleanupError(
      archivePeer.request("thread/archive", { threadId: createdThreadId }),
      cleanupErrors,
    );
  }
  if (observer) await collectCleanupError(observer.stop(), cleanupErrors);
  if (manager) await collectCleanupError(manager.stop(), cleanupErrors);
  if (executable && nativeEnvironment) {
    await collectCleanupError(runDaemonCommand(executable, nativeEnvironment, "stop"), cleanupErrors);
  }
  if (directory) {
    await collectCleanupError(rm(directory, { recursive: true, force: true }), cleanupErrors);
  }
  if (codexHome) {
    await collectCleanupError(rm(codexHome, { recursive: true, force: true }), cleanupErrors);
  }
}

if (failure) throw failure;
if (cleanupErrors.length > 0) {
  throw new AggregateError(cleanupErrors, "Native smoke cleanup failed");
}
console.log(summary);

async function waitFor(
  predicate: () => boolean,
  message: string,
  attempts = 100,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(message);
}

async function runDaemonCommand(
  executablePath: string,
  environment: Record<string, string>,
  command: "stop" | "version",
): Promise<Record<string, unknown>> {
  const child = Bun.spawn([executablePath, "app-server", "daemon", command], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Codex daemon ${command} failed: ${stderr.trim().slice(0, 1_024)}`);
  }
  if (command === "stop") return {};
  const value: unknown = JSON.parse(stdout);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Codex daemon version returned invalid JSON");
  }
  return value as Record<string, unknown>;
}

async function collectCleanupError(
  operation: Promise<unknown>,
  errors: unknown[],
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    errors.push(error);
  }
}

function environmentStrings(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
