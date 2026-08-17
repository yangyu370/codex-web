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
const manager = new AppServerProcessManager(platform, {
  configuredExecutable: process.env.CODEX_WEB_CODEX_EXECUTABLE,
});
try {
  const peer = await manager.start();
  const adapter = new CodexAdapter(peer, new WebState(platform.kind), platform);
  const models = await adapter.models();
  await adapter.listThreads();
  const thread = await adapter.startThread({ cwd: directory });
  const read = decodeThreadEnvelope(
    await peer.request("thread/read", { threadId: thread.id, includeTurns: false }),
  );
  if (read.thread.id !== thread.id) throw new Error("Native smoke read the wrong thread");
  await peer.request("thread/archive", { threadId: thread.id }).catch(() => undefined);
  console.log(`Native smoke passed with ${models.length} model(s) using ${manager.snapshot().codexVersion}.`);
} finally {
  await manager.stop();
  await rm(directory, { recursive: true, force: true });
}
