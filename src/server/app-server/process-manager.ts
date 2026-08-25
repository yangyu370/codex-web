import type { AppServerProcess, HostPlatform } from "../platform";
import type { DaemonConnectionInfo } from "./daemon";
import { createJsonlTransport } from "./jsonl-transport";
import { JsonRpcPeer, type JsonRpcTransport } from "./json-rpc";
import {
  selectSharedAppServerBackend,
  type SharedAppServerBackend,
  type SharedBackendKind,
  type WindowsSharedPolicy,
} from "./shared-backend";

const STDERR_CAP_BYTES = 262_144;
const RESTART_DELAYS_MS = [250, 1_000, 4_000, 10_000] as const;
const LAST_RESTART_DELAY_MS = 10_000;

export type AppServerStatus =
  | "starting"
  | "ready"
  | "restarting"
  | "unavailable";

export interface AppServerProcessSnapshot {
  status: AppServerStatus;
  codexVersion?: string;
  cliVersion?: string;
  appServerVersion?: string;
  restartRequired?: boolean;
  error?: string;
  mode?: "shared" | "embedded";
  sharedBackend?: SharedBackendKind;
  liveHandoff?: "available" | "unavailable";
}

export interface AppServerProcessManagerOptions {
  configuredExecutable?: string;
  env?: Record<string, string>;
  version?: (executable: string) => Promise<string>;
  sleep?: (milliseconds: number) => Promise<void>;
  daemonStart?: (
    executable: string,
    codexHome: string,
  ) => Promise<DaemonConnectionInfo>;
  daemonConnect?: (socketPath: string) => Promise<JsonRpcTransport>;
  sharedBackend?: SharedAppServerBackend;
  windowsPolicy?: WindowsSharedPolicy;
}

export function shouldInterruptOnWebShutdown(snapshot: AppServerProcessSnapshot): boolean {
  return snapshot.mode !== "shared";
}

export class AppServerProcessManager {
  readonly #platform: HostPlatform;
  readonly #options: AppServerProcessManagerOptions;
  readonly #sharedBackend?: SharedAppServerBackend;
  readonly #sharedRequired: boolean;
  readonly #stateListeners = new Set<(state: AppServerProcessSnapshot) => void>();
  #snapshot: AppServerProcessSnapshot = { status: "starting" };
  #child?: AppServerProcess;
  #peer?: JsonRpcPeer;
  #sharedTransport?: JsonRpcTransport;
  #unsubscribeSharedClose?: () => void;
  #intentionalShutdown = false;
  #restartAttempt = 0;
  #stderrChunks: Uint8Array[] = [];
  #stderrBytes = 0;
  #startPromise?: Promise<JsonRpcPeer>;
  #restartPromise?: Promise<void>;

  constructor(platform: HostPlatform, options: AppServerProcessManagerOptions = {}) {
    this.#platform = platform;
    this.#options = options;
    this.#sharedRequired = platform.kind === "windows" && options.windowsPolicy === "required";
    this.#sharedBackend = options.sharedBackend ?? selectSharedAppServerBackend(
      platform,
      {
        env: options.env ?? {},
        windowsPolicy: options.windowsPolicy,
        daemonStart: options.daemonStart,
        daemonConnect: options.daemonConnect,
      },
    );
  }

  start(): Promise<JsonRpcPeer> {
    if (this.#startPromise) {
      return this.#startPromise;
    }
    this.#intentionalShutdown = false;
    this.#setSnapshot({ status: "starting" });
    this.#startPromise = this.#launch().catch((error: unknown) => {
      this.#startPromise = undefined;
      if (this.#snapshot.status !== "unavailable") {
        this.#setSnapshot({
          status: "unavailable",
          error: error instanceof Error ? error.message : String(error),
          mode: this.#platform.kind === "windows" ? "embedded" : this.#snapshot.mode,
          sharedBackend: this.#snapshot.sharedBackend,
          liveHandoff: "unavailable",
        });
      }
      throw error;
    });
    return this.#startPromise;
  }

  peer(): JsonRpcPeer {
    if (!this.#peer || this.#snapshot.status !== "ready") {
      throw new Error("app-server is not ready");
    }
    return this.#peer;
  }

  snapshot(): AppServerProcessSnapshot {
    return { ...this.#snapshot };
  }

  diagnostics(): string {
    const bytes = new Uint8Array(this.#stderrBytes);
    let offset = 0;
    for (const chunk of this.#stderrChunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }

  onState(listener: (state: AppServerProcessSnapshot) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  async stop(gracePeriodMs = 2_000): Promise<void> {
    this.#intentionalShutdown = true;
    this.#startPromise = undefined;
    const child = this.#child;
    this.#unsubscribeSharedClose?.();
    this.#unsubscribeSharedClose = undefined;
    this.#peer?.close(new Error("app-server stopped"));
    this.#peer = undefined;
    this.#sharedTransport = undefined;
    this.#child = undefined;
    if (child) {
      const exitedGracefully = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(gracePeriodMs).then(() => false),
      ]);
      if (!exitedGracefully) {
        await this.#platform.terminateProcessTree(child);
      }
    }
    this.#setSnapshot({
      status: "unavailable",
      codexVersion: this.#snapshot.codexVersion,
      cliVersion: this.#snapshot.cliVersion,
      appServerVersion: this.#snapshot.appServerVersion,
      mode: this.#snapshot.mode,
      sharedBackend: this.#snapshot.sharedBackend,
      liveHandoff: "unavailable",
    });
  }

  async #launch(): Promise<JsonRpcPeer> {
    const executable = await this.#platform.resolveCodexExecutable(
      this.#options.configuredExecutable,
    );
    const codexVersion = await (this.#options.version ?? readCodexVersion)(
      executable,
    );
    let sharedFailure: string | undefined;
    if (this.#sharedBackend) {
      try {
        return await this.#launchShared(executable, codexVersion);
      } catch (error) {
        sharedFailure = error instanceof Error ? error.message : String(error);
        this.#unsubscribeSharedClose?.();
        this.#unsubscribeSharedClose = undefined;
        this.#peer?.close(new Error("shared app-server initialization failed"));
        this.#peer = undefined;
        this.#sharedTransport = undefined;
        if (this.#sharedRequired) throw error;
      }
    }
    return this.#launchEmbedded(executable, codexVersion, sharedFailure);
  }

  async #launchShared(executable: string, cliVersion: string): Promise<JsonRpcPeer> {
    const connection = await this.#sharedBackend!.ensureAndConnect({
      executable,
      cliVersion,
      env: this.#options.env ?? {},
    });
    const { transport, info } = connection;
    const peer = new JsonRpcPeer(transport);
    this.#peer = peer;
    await this.#initialize(peer);
    this.#sharedTransport = transport;
    this.#unsubscribeSharedClose = transport.onClose((reason) => {
      void this.#handleSharedClose(
        transport,
        reason ?? new Error("shared app-server connection closed"),
      );
    });
    this.#restartAttempt = 0;
    const appServerVersion = info.appServerVersion ?? cliVersion;
    this.#setSnapshot({
      status: "ready",
      codexVersion: appServerVersion,
      cliVersion,
      appServerVersion,
      ...(info.restartRequired ? { restartRequired: true } : {}),
      mode: "shared",
      sharedBackend: info.backend,
      liveHandoff: "available",
    });
    return peer;
  }

  async #launchEmbedded(
    executable: string,
    codexVersion: string,
    sharedFailure?: string,
  ): Promise<JsonRpcPeer> {
    try {
      const child = this.#platform.spawnAppServer(
        executable,
        this.#options.env ?? environmentStrings(process.env),
      );
      this.#child = child;
      void this.#captureStderr(child.stderr);
      void child.exited.then((exitCode) => this.#handleExit(child, exitCode));

      const peer = new JsonRpcPeer(createJsonlTransport(child.stdout, child.stdin));
      this.#peer = peer;
      await this.#initialize(peer);
      this.#restartAttempt = 0;
      this.#setSnapshot({
        status: "ready",
        codexVersion,
        cliVersion: codexVersion,
        appServerVersion: codexVersion,
        mode: "embedded",
        liveHandoff: "unavailable",
        ...(sharedFailure ? { error: sharedFailure } : {}),
      });
      return peer;
    } catch (error) {
      const child = this.#child;
      this.#peer?.close(new Error("app-server initialization failed"));
      this.#peer = undefined;
      this.#child = undefined;
      if (child) {
        await this.#platform.terminateProcessTree(child).catch(() => undefined);
      }
      this.#startPromise = undefined;
      this.#setSnapshot({
        status: "unavailable",
        error: error instanceof Error ? error.message : String(error),
        cliVersion: codexVersion,
        mode: "embedded",
        liveHandoff: "unavailable",
      });
      throw error;
    }
  }

  async #initialize(peer: JsonRpcPeer): Promise<void> {
    await peer.request("initialize", {
      clientInfo: { name: "codex-web", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    peer.notify("initialized");
  }

  async #handleExit(child: AppServerProcess, exitCode: number): Promise<void> {
    if (this.#intentionalShutdown || child !== this.#child) {
      return;
    }
    this.#peer?.close(new Error(`app-server exited with code ${exitCode}`));
    this.#peer = undefined;
    this.#child = undefined;
    this.#startPromise = undefined;
    this.#setSnapshot({
      status: "restarting",
      codexVersion: this.#snapshot.codexVersion,
      cliVersion: this.#snapshot.cliVersion,
      appServerVersion: this.#snapshot.appServerVersion,
      error: `app-server exited with code ${exitCode}`,
      mode: "embedded",
      liveHandoff: "unavailable",
    });
    if (!this.#restartPromise) {
      this.#restartPromise = this.#restartUntilReady().finally(() => {
        this.#restartPromise = undefined;
      });
    }
    await this.#restartPromise;
  }

  async #handleSharedClose(
    transport: JsonRpcTransport,
    reason: Error,
  ): Promise<void> {
    if (this.#intentionalShutdown || transport !== this.#sharedTransport) return;
    this.#unsubscribeSharedClose?.();
    this.#unsubscribeSharedClose = undefined;
    this.#sharedTransport = undefined;
    this.#peer = undefined;
    this.#startPromise = undefined;
    this.#setSnapshot({
      status: "restarting",
      codexVersion: this.#snapshot.codexVersion,
      cliVersion: this.#snapshot.cliVersion,
      appServerVersion: this.#snapshot.appServerVersion,
      error: reason.message,
      mode: "shared",
      sharedBackend: this.#snapshot.sharedBackend,
      liveHandoff: "available",
    });
    if (!this.#restartPromise) {
      this.#restartPromise = this.#restartUntilReady().finally(() => {
        this.#restartPromise = undefined;
      });
    }
    await this.#restartPromise;
  }

  async #restartUntilReady(): Promise<void> {
    while (!this.#intentionalShutdown) {
      const delay = restartDelay(this.#restartAttempt);
      this.#restartAttempt += 1;
      await (this.#options.sleep ?? Bun.sleep)(delay);
      if (this.#intentionalShutdown) return;
      this.#setSnapshot({
        status: "restarting",
        codexVersion: this.#snapshot.codexVersion,
        cliVersion: this.#snapshot.cliVersion,
        appServerVersion: this.#snapshot.appServerVersion,
        error: this.#snapshot.error,
        mode: this.#snapshot.mode,
        sharedBackend: this.#snapshot.sharedBackend,
        liveHandoff: this.#snapshot.liveHandoff,
      });
      this.#startPromise = this.#launch();
      try {
        await this.#startPromise;
        return;
      } catch {
        // Keep retrying with a delay capped at the last backoff value.
      }
    }
  }

  async #captureStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        this.#appendStderr(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  #appendStderr(value: Uint8Array): void {
    this.#stderrChunks.push(value.slice());
    this.#stderrBytes += value.byteLength;
    while (this.#stderrBytes > STDERR_CAP_BYTES && this.#stderrChunks.length > 0) {
      const first = this.#stderrChunks[0];
      if (!first) break;
      const excess = this.#stderrBytes - STDERR_CAP_BYTES;
      if (first.byteLength <= excess) {
        this.#stderrChunks.shift();
        this.#stderrBytes -= first.byteLength;
      } else {
        this.#stderrChunks[0] = first.slice(excess);
        this.#stderrBytes -= excess;
      }
    }
  }

  #setSnapshot(snapshot: AppServerProcessSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#stateListeners) {
      listener(this.snapshot());
    }
  }
}

async function readCodexVersion(executable: string): Promise<string> {
  const process = Bun.spawn([executable, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readStreamBounded(process.stdout, 4_096),
    readStreamBounded(process.stderr, 4_096),
    process.exited,
  ]);
  if (exitCode !== 0) {
    void stderr;
    throw new Error(`Codex --version exited with ${exitCode}`);
  }
  const version = stdout.split(/\r?\n/, 1)[0]?.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!version) throw new Error("Codex --version returned no version");
  return version;
}

async function readStreamBounded(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return result + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("Codex --version output exceeded limit");
      }
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function environmentStrings(
  env: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function restartDelay(attempt: number): number {
  return (
    RESTART_DELAYS_MS[Math.min(attempt, RESTART_DELAYS_MS.length - 1)] ??
    LAST_RESTART_DELAY_MS
  );
}
