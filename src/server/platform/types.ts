export class PlatformError extends Error {
  constructor(
    public readonly code:
      | "unsupportedPlatform"
      | "invalidWorkingDirectory"
      | "codexUnavailable",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "PlatformError";
  }
}

export interface PlatformRuntime {
  arch: string;
  env: Record<string, string | undefined>;
  homedir: string;
  access(path: string): Promise<void>;
  isDirectory(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
  resolveOnPath(name: string): Promise<string>;
  spawn(command: string[], env: Record<string, string>): AppServerProcess;
  terminateTree(
    kind: "macos" | "windows",
    child: AppServerProcess,
  ): Promise<void>;
}

export interface AppServerProcess {
  readonly pid: number;
  readonly stdin: {
    write(data: string | Uint8Array): number | Promise<number>;
    end(): void;
  };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface ValidatedPath {
  displayPath: string;
  resolvedPath: string;
}

export interface HostPlatform {
  readonly kind: "macos" | "windows";
  readonly arch: string;
  resolveCodexExecutable(configuredPath?: string): Promise<string>;
  validateWorkingDirectory(input: string): Promise<ValidatedPath>;
  spawnAppServer(
    executable: string,
    env: Record<string, string>,
  ): AppServerProcess;
  terminateProcessTree(child: AppServerProcess): Promise<void>;
  homeDirectory(): string;
  dataDirectory(): string;
  diagnostics(): Promise<{ platform: "macos" | "windows"; arch: string }>;
}
