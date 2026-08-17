import type { AppServerProcess, HostPlatform } from "../platform";
import { JsonRpcPeer } from "./json-rpc";

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
  error?: string;
}

export interface AppServerProcessManagerOptions {
  configuredExecutable?: string;
  env?: Record<string, string>;
  version?: (executable: string) => Promise<string>;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class AppServerProcessManager {
  readonly #platform: HostPlatform;
  readonly #options: AppServerProcessManagerOptions;
  readonly #stateListeners = new Set<(state: AppServerProcessSnapshot) => void>();
  #snapshot: AppServerProcessSnapshot = { status: "starting" };
  #child?: AppServerProcess;
  #peer?: JsonRpcPeer;
  #intentionalShutdown = false;
  #restartAttempt = 0;
  #stderrChunks: Uint8Array[] = [];
  #stderrBytes = 0;
  #startPromise?: Promise<JsonRpcPeer>;

  constructor(platform: HostPlatform, options: AppServerProcessManagerOptions = {}) {
    this.#platform = platform;
    this.#options = options;
  }

  start(): Promise<JsonRpcPeer> {
    if (this.#startPromise) {
      return this.#startPromise;
    }
    this.#intentionalShutdown = false;
    this.#setSnapshot({ status: "starting" });
    this.#startPromise = this.#launch();
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
    this.#peer?.close(new Error("app-server stopped"));
    this.#peer = undefined;
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
    });
  }

  async #launch(): Promise<JsonRpcPeer> {
    try {
      const executable = await this.#platform.resolveCodexExecutable(
        this.#options.configuredExecutable,
      );
      const codexVersion = await (this.#options.version ?? readCodexVersion)(
        executable,
      );
      const child = this.#platform.spawnAppServer(
        executable,
        this.#options.env ?? environmentStrings(process.env),
      );
      this.#child = child;
      void this.#captureStderr(child.stderr);
      void child.exited.then((exitCode) => this.#handleExit(child, exitCode));

      const peer = new JsonRpcPeer(child.stdout, child.stdin);
      this.#peer = peer;
      await peer.request("initialize", {
        clientInfo: { name: "codex-web", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      peer.notify("initialized");
      this.#restartAttempt = 0;
      this.#setSnapshot({ status: "ready", codexVersion });
      return peer;
    } catch (error) {
      this.#startPromise = undefined;
      this.#setSnapshot({
        status: "unavailable",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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
      error: `app-server exited with code ${exitCode}`,
    });
    const delay = restartDelay(this.#restartAttempt);
    this.#restartAttempt += 1;
    await (this.#options.sleep ?? Bun.sleep)(delay);
    if (this.#intentionalShutdown) {
      return;
    }
    this.#startPromise = this.#launch();
    try {
      await this.#startPromise;
    } catch {
      if (!this.#intentionalShutdown && this.#restartAttempt < RESTART_DELAYS_MS.length) {
        await this.#handleExitAfterLaunchFailure();
      }
    }
  }

  async #handleExitAfterLaunchFailure(): Promise<void> {
    const delay = restartDelay(this.#restartAttempt);
    this.#restartAttempt += 1;
    this.#setSnapshot({
      status: "restarting",
      codexVersion: this.#snapshot.codexVersion,
      error: this.#snapshot.error,
    });
    await (this.#options.sleep ?? Bun.sleep)(delay);
    if (!this.#intentionalShutdown) {
      this.#startPromise = this.#launch();
      await this.#startPromise.catch(() => undefined);
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
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `Codex --version exited with ${exitCode}`);
  }
  return stdout.trim();
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
