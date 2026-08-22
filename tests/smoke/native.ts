import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CodexAdapter } from "../../src/server/app-server/adapter";
import { decodeThreadEnvelope } from "../../src/server/app-server/decoders";
import { AppServerProcessManager } from "../../src/server/app-server/process-manager";
import { selectHostPlatform } from "../../src/server/platform";
import { createSystemRuntime } from "../../src/server/platform/system-runtime";
import { WebState } from "../../src/server/service/state";

if (process.env.CODEX_WEB_SMOKE !== "1") {
  console.log("Set CODEX_WEB_SMOKE=1 to run the native Codex smoke test.");
  process.exit(0);
}

const directory = await mkdtemp(path.join(tmpdir(), "codex-web-smoke-"));
const platform = selectHostPlatform(process.platform, createSystemRuntime());
const nativeEnvironment = environmentStrings(process.env);
const manager = new AppServerProcessManager(platform, {
  configuredExecutable: process.env.CODEX_WEB_CODEX_EXECUTABLE,
  env: nativeEnvironment,
});
let observer: AppServerProcessManager | undefined;
try {
  const peer = await manager.start();
  const adapter = new CodexAdapter(peer, new WebState(platform.kind), platform);
  const models = await adapter.models();
  const profiles = await adapter.permissionProfiles();
  await adapter.listThreads();
  let observerPeer: Awaited<ReturnType<AppServerProcessManager["start"]>> | undefined;
  let observerAdapter: CodexAdapter | undefined;
  const observedThreadIds = new Set<string>();
  if (platform.kind === "macos") {
    observer = new AppServerProcessManager(platform, {
      configuredExecutable: process.env.CODEX_WEB_CODEX_EXECUTABLE,
      env: nativeEnvironment,
    });
    observerPeer = await observer.start();
    if (manager.snapshot().mode !== "daemon" || observer.snapshot().mode !== "daemon") {
      throw new Error("macOS smoke did not establish two shared daemon clients");
    }
    const observerState = new WebState("macos");
    observerState.onEvent((event) => {
      const payload = typeof event.payload === "object" && event.payload !== null
        ? event.payload as Record<string, unknown>
        : {};
      const thread = typeof payload.thread === "object" && payload.thread !== null
        ? payload.thread as Record<string, unknown>
        : undefined;
      if (typeof thread?.id === "string") observedThreadIds.add(thread.id);
    });
    observerAdapter = new CodexAdapter(observerPeer, observerState, platform);
  }
  const preferredModel = models.find((model) => model.isDefault) ?? models[0];
  const thread = await adapter.startThread({ cwd: directory, model: preferredModel?.id });
  if (observerAdapter) {
    await waitFor(() => observedThreadIds.has(thread.id));
  }
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
  if (observerAdapter && observerPeer) {
    await manager.stop();
    const resumed = await observerAdapter.resumeThread(thread.id);
    if (resumed.id !== thread.id) throw new Error("Shared daemon observer resumed the wrong thread");
    await observerPeer.request("thread/archive", { threadId: thread.id }).catch(() => undefined);
  } else {
    await peer.request("thread/archive", { threadId: thread.id }).catch(() => undefined);
  }
  console.log(
    `Native ${platform.kind} smoke passed with ${models.length} model(s), ` +
    `${profiles.length} permission profile(s), using ${manager.snapshot().codexVersion}.`,
  );
} finally {
  await observer?.stop();
  await manager.stop();
  await rm(directory, { recursive: true, force: true });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error("Shared daemon client did not observe the new thread");
}

function environmentStrings(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
