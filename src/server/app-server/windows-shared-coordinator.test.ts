import { describe, expect, test } from "bun:test";

import {
  WindowsSharedAppServerCoordinator,
  type WindowsCoordinatorRuntime,
  type WindowsSharedMetadata,
} from "./windows-shared-coordinator";

const base = {
  endpoint: "ws://127.0.0.1:4500",
  codexHome: "C:\\Users\\dev\\.codex",
  executable: "C:\\Tools\\codex.exe",
  cliVersion: "0.149.1",
};

describe("WindowsSharedAppServerCoordinator", () => {
  test("coalesces concurrent ensure calls into one managed host start", async () => {
    const runtime = memoryRuntime();
    const coordinator = new WindowsSharedAppServerCoordinator({ ...base, runtime });

    const [first, second] = await Promise.all([coordinator.ensure(), coordinator.ensure()]);

    expect(runtime.starts).toBe(1);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ endpoint: base.endpoint, appServerVersion: "0.149.1" });
  });

  test("waits for the newly hosted app-server readiness handshake", async () => {
    const runtime = memoryRuntime();
    runtime.readinessFailures = 2;
    const coordinator = new WindowsSharedAppServerCoordinator({
      ...base,
      runtime,
      startupTimeoutMs: 1_000,
    });

    await expect(coordinator.ensure()).resolves.toMatchObject({
      appServerVersion: "0.149.1",
    });
    expect(runtime.sleeps).toEqual([50, 50]);
  });

  test("rejects metadata belonging to another Codex home without starting or stopping", async () => {
    const runtime = memoryRuntime();
    runtime.metadata = metadata({ codexHome: "C:\\Users\\dev\\other-codex" });
    const coordinator = new WindowsSharedAppServerCoordinator({ ...base, runtime });

    await expect(coordinator.ensure()).rejects.toThrow("managed identity mismatch");

    expect(runtime.starts).toBe(0);
    expect(runtime.stops).toBe(0);
  });

  test("does not reuse an unknown app-server that answers on the configured port", async () => {
    const runtime = memoryRuntime();
    runtime.portOwner = { appServerVersion: "0.149.1" };
    const coordinator = new WindowsSharedAppServerCoordinator({ ...base, runtime });

    await expect(coordinator.ensure()).rejects.toThrow("unknown process owns");
    expect(runtime.starts).toBe(0);
  });

  test("keeps a running older app-server and reports restart required", async () => {
    const runtime = memoryRuntime();
    runtime.metadata = metadata({ appServerVersion: "0.148.0", cliVersion: "0.148.0" });
    runtime.portOwner = { appServerVersion: "0.148.0" };
    const coordinator = new WindowsSharedAppServerCoordinator({ ...base, runtime });

    await expect(coordinator.ensure()).resolves.toMatchObject({
      appServerVersion: "0.148.0",
      restartRequired: true,
    });
    expect(runtime.starts).toBe(0);
  });

  test("stop terminates only a matching live managed identity", async () => {
    const runtime = memoryRuntime();
    runtime.metadata = metadata();
    runtime.portOwner = { appServerVersion: "0.149.1" };
    const coordinator = new WindowsSharedAppServerCoordinator({ ...base, runtime });

    await coordinator.stop();

    expect(runtime.stops).toBe(1);
    expect(runtime.metadata).toBeUndefined();
  });
});

interface MemoryRuntime extends WindowsCoordinatorRuntime {
  metadata?: WindowsSharedMetadata;
  portOwner?: { appServerVersion: string };
  starts: number;
  stops: number;
  readinessFailures: number;
  sleeps: number[];
}

function memoryRuntime(): MemoryRuntime {
  const runtime: MemoryRuntime = {
    starts: 0,
    stops: 0,
    readinessFailures: 0,
    sleeps: [],
    async withStartupLock(operation) { return operation(); },
    async readMetadata() { return runtime.metadata; },
    async writeMetadata(value) { runtime.metadata = value; },
    async removeMetadata() { runtime.metadata = undefined; },
    async processMatches() { return runtime.metadata !== undefined; },
    async probe() {
      if (!runtime.portOwner) throw new Error("ECONNREFUSED");
      if (runtime.readinessFailures > 0) {
        runtime.readinessFailures -= 1;
        throw new Error("not ready");
      }
      return runtime.portOwner;
    },
    async startHost(request) {
      runtime.starts += 1;
      runtime.portOwner = { appServerVersion: request.cliVersion };
      return { hostPid: 101, nativePid: 102 };
    },
    async stopHost() {
      runtime.stops += 1;
      runtime.portOwner = undefined;
    },
    now: () => 1_777_000_000_000 + runtime.sleeps.reduce((sum, value) => sum + value, 0),
    async sleep(milliseconds) { runtime.sleeps.push(milliseconds); },
    randomId: () => "generation-1",
  };
  return runtime;
}

function metadata(overrides: Partial<WindowsSharedMetadata> = {}): WindowsSharedMetadata {
  return {
    schemaVersion: 1,
    endpoint: base.endpoint,
    codexHome: base.codexHome,
    executable: base.executable,
    cliVersion: base.cliVersion,
    appServerVersion: base.cliVersion,
    generation: "generation-1",
    startedAt: 1_777_000_000_000,
    hostPid: 101,
    nativePid: 102,
    ...overrides,
  };
}
