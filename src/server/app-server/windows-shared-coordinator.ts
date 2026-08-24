import { parseManagedLoopbackEndpoint } from "./tcp-websocket-transport";
import type { WindowsProcessIdentity } from "./windows-app-server-host";
import {
  codexVersionAtLeast,
  MINIMUM_WINDOWS_SHARED_VERSION,
  sameCodexVersion,
} from "./windows-version";

export type WindowsSharedStatus = "stopped" | "starting" | "ready" | "incompatible";

export interface WindowsSharedMetadata {
  schemaVersion: 1;
  endpoint: string;
  codexHome: string;
  executable: string;
  cliVersion: string;
  appServerVersion?: string;
  generation: string;
  startedAt: number;
  hostPid: number;
  nativePid: number;
  hostIdentity: WindowsProcessIdentity;
  nativeIdentity: WindowsProcessIdentity;
}

export interface WindowsHostStartRequest {
  endpoint: string;
  codexHome: string;
  executable: string;
  cliVersion: string;
  generation: string;
}

export interface WindowsCoordinatorRuntime {
  withStartupLock<T>(operation: () => Promise<T>): Promise<T>;
  readMetadata(): Promise<WindowsSharedMetadata | undefined>;
  writeMetadata(metadata: WindowsSharedMetadata): Promise<void>;
  removeMetadata(): Promise<void>;
  processMatches(metadata: WindowsSharedMetadata): Promise<boolean>;
  managedProcessesGone(metadata: WindowsSharedMetadata): Promise<boolean>;
  probe(endpoint: string): Promise<{ appServerVersion: string }>;
  startHost(request: WindowsHostStartRequest): Promise<{
    hostPid: number;
    nativePid: number;
    hostIdentity: WindowsProcessIdentity;
    nativeIdentity: WindowsProcessIdentity;
  }>;
  stopHost(metadata: WindowsSharedMetadata): Promise<void>;
  now(): number;
  randomId(): string;
  sleep(milliseconds: number): Promise<void>;
}

export interface WindowsSharedAppServerCoordinatorOptions {
  endpoint: string;
  codexHome: string;
  executable: string;
  cliVersion: string;
  runtime: WindowsCoordinatorRuntime;
  startupTimeoutMs?: number;
}

export interface WindowsSharedConnectionInfo {
  endpoint: string;
  cliVersion: string;
  appServerVersion: string;
  restartRequired: boolean;
  hostPid: number;
  nativePid: number;
}

export class WindowsSharedAppServerCoordinator {
  readonly #options: WindowsSharedAppServerCoordinatorOptions;
  #ensurePromise?: Promise<WindowsSharedConnectionInfo>;
  #starting = false;

  constructor(options: WindowsSharedAppServerCoordinatorOptions) {
    parseManagedLoopbackEndpoint(options.endpoint);
    this.#options = options;
  }

  ensure(): Promise<WindowsSharedConnectionInfo> {
    if (this.#ensurePromise) return this.#ensurePromise;
    this.#ensurePromise = this.#options.runtime.withStartupLock(async () => {
      this.#starting = true;
      try {
        return await this.#ensureLocked();
      } finally {
        this.#starting = false;
      }
    }).finally(() => {
      this.#ensurePromise = undefined;
    });
    return this.#ensurePromise;
  }

  async status(): Promise<WindowsSharedStatus> {
    if (this.#starting) return "starting";
    return this.#options.runtime.withStartupLock(async () => {
      const metadata = await this.#options.runtime.readMetadata();
      if (!metadata) return "stopped";
      this.#assertIdentity(metadata);
      if (!await this.#options.runtime.processMatches(metadata)) return "stopped";
      const probe = await this.#probeOrUndefined();
      if (!probe) return "stopped";
      return sameCodexVersion(probe.appServerVersion, this.#options.cliVersion)
        ? "ready"
        : "incompatible";
    });
  }

  async stop(): Promise<void> {
    await this.#options.runtime.withStartupLock(async () => {
      const metadata = await this.#options.runtime.readMetadata();
      if (!metadata) return;
      this.#assertIdentity(metadata);
      if (!await this.#options.runtime.processMatches(metadata)) {
        if (await this.#probeOrUndefined()) {
          throw new Error("managed process identity could not be verified; refusing to stop");
        }
        if (!await this.#options.runtime.managedProcessesGone(metadata)) {
          throw new Error("managed process identity is unavailable; refusing to discard metadata");
        }
        await this.#options.runtime.removeMetadata();
        return;
      }
      await this.#options.runtime.stopHost(metadata);
      await this.#options.runtime.removeMetadata();
    });
  }

  async restart(): Promise<WindowsSharedConnectionInfo> {
    await this.stop();
    return this.ensure();
  }

  async #ensureLocked(): Promise<WindowsSharedConnectionInfo> {
    const existing = await this.#options.runtime.readMetadata();
    if (existing) {
      this.#assertIdentity(existing);
      if (await this.#options.runtime.processMatches(existing)) {
        const probe = await this.#probeOrUndefined();
        if (!probe) throw new Error("managed app-server process is running but not ready");
        this.#assertCompatibleVersion(probe.appServerVersion);
        return this.#connectionInfo(existing, probe.appServerVersion);
      }
      if (await this.#probeOrUndefined()) {
        throw new Error("managed process identity could not be verified");
      }
      if (!await this.#options.runtime.managedProcessesGone(existing)) {
        throw new Error("managed process identity is unavailable; preserving lifecycle metadata");
      }
      await this.#options.runtime.removeMetadata();
    }

    if (await this.#probeOrUndefined()) {
      throw new Error("unknown process owns the managed app-server endpoint");
    }

    const generation = this.#options.runtime.randomId();
    const process = await this.#options.runtime.startHost({
      endpoint: this.#options.endpoint,
      codexHome: this.#options.codexHome,
      executable: this.#options.executable,
      cliVersion: this.#options.cliVersion,
      generation,
    });
    const metadata: WindowsSharedMetadata = {
      schemaVersion: 1,
      endpoint: this.#options.endpoint,
      codexHome: this.#options.codexHome,
      executable: this.#options.executable,
      cliVersion: this.#options.cliVersion,
      generation,
      startedAt: this.#options.runtime.now(),
      hostPid: process.hostPid,
      nativePid: process.nativePid,
      hostIdentity: process.hostIdentity,
      nativeIdentity: process.nativeIdentity,
    };
    await this.#options.runtime.writeMetadata(metadata);
    const probe = await this.#waitForProbe();
    if (!probe) {
      await this.#cleanupFailedStart(metadata);
      throw new Error("managed app-server failed readiness verification");
    }
    if (!codexVersionAtLeast(probe.appServerVersion, MINIMUM_WINDOWS_SHARED_VERSION)) {
      await this.#cleanupFailedStart(metadata);
      throw new Error(
        `Windows shared app-server requires Codex ${MINIMUM_WINDOWS_SHARED_VERSION} or newer`,
      );
    }
    metadata.appServerVersion = probe.appServerVersion;
    await this.#options.runtime.writeMetadata(metadata);
    return this.#connectionInfo(metadata, probe.appServerVersion);
  }

  #assertIdentity(metadata: WindowsSharedMetadata): void {
    if (
      metadata.schemaVersion !== 1 ||
      metadata.endpoint !== this.#options.endpoint ||
      metadata.codexHome !== this.#options.codexHome ||
      metadata.executable !== this.#options.executable
    ) {
      throw new Error("managed identity mismatch");
    }
  }

  #assertCompatibleVersion(version: string): void {
    if (!codexVersionAtLeast(version, MINIMUM_WINDOWS_SHARED_VERSION)) {
      throw new Error(
        `Windows shared app-server requires Codex ${MINIMUM_WINDOWS_SHARED_VERSION} or newer`,
      );
    }
  }

  async #cleanupFailedStart(metadata: WindowsSharedMetadata): Promise<void> {
    if (await this.#options.runtime.processMatches(metadata)) {
      await this.#options.runtime.stopHost(metadata);
    } else {
      if (await this.#probeOrUndefined()) {
        throw new Error("failed managed app-server remains reachable; preserving lifecycle metadata");
      }
      if (!await this.#options.runtime.managedProcessesGone(metadata)) {
        throw new Error("failed managed process identity is unavailable; preserving lifecycle metadata");
      }
    }
    if (!await this.#options.runtime.managedProcessesGone(metadata)) {
      throw new Error("failed managed process tree still exists; preserving lifecycle metadata");
    }
    await this.#options.runtime.removeMetadata();
  }

  async #probeOrUndefined(): Promise<{ appServerVersion: string } | undefined> {
    try {
      return await this.#options.runtime.probe(this.#options.endpoint);
    } catch {
      return undefined;
    }
  }

  async #waitForProbe(): Promise<{ appServerVersion: string } | undefined> {
    const deadline = this.#options.runtime.now() + (this.#options.startupTimeoutMs ?? 15_000);
    while (true) {
      const probe = await this.#probeOrUndefined();
      if (probe) return probe;
      if (this.#options.runtime.now() >= deadline) return undefined;
      await this.#options.runtime.sleep(50);
    }
  }

  #connectionInfo(
    metadata: WindowsSharedMetadata,
    appServerVersion: string,
  ): WindowsSharedConnectionInfo {
    return {
      endpoint: metadata.endpoint,
      cliVersion: this.#options.cliVersion,
      appServerVersion,
      restartRequired: !sameCodexVersion(appServerVersion, this.#options.cliVersion),
      hostPid: metadata.hostPid,
      nativePid: metadata.nativePid,
    };
  }
}
