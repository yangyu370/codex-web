const DIAGNOSTIC_LIMIT_BYTES = 262_144;

export interface WindowsAppServerHostRequest {
  endpoint: string;
  codexHome: string;
  executable: string;
  generation: string;
}

export interface WindowsHostedProcess {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface WindowsProcessIdentity {
  pid: number;
  parentPid: number;
  creationDate: string;
  executablePath: string;
  commandLine: string;
}

export interface WindowsHostControlRequest {
  schemaVersion: 1;
  action: "probe" | "stop";
  nonce: string;
  generation: string;
  hostPid: number;
  nativePid: number;
}

export interface WindowsHostControlResponse extends WindowsHostControlRequest {
  status: "alive" | "stopped";
}

export interface WindowsAppServerHostRuntime {
  hostPid: number;
  now(): number;
  spawn(command: string[], env: Record<string, string>): WindowsHostedProcess;
  writeLease(lease: {
    generation: string;
    hostPid: number;
    nativePid: number;
    hostIdentity: WindowsProcessIdentity;
    nativeIdentity: WindowsProcessIdentity;
  }): Promise<void>;
  describeProcess(pid: number): Promise<WindowsProcessIdentity>;
  readControlRequest(): Promise<WindowsHostControlRequest | undefined>;
  writeControlResponse(response: WindowsHostControlResponse): Promise<void>;
  stopProcessTree(child: WindowsHostedProcess): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
  writeDiagnostics(source: string): Promise<void>;
}

export async function runWindowsAppServerHost(
  request: WindowsAppServerHostRequest,
  runtime: WindowsAppServerHostRuntime,
): Promise<number> {
  const child = runtime.spawn([
    request.executable,
    "app-server",
    "--listen",
    request.endpoint,
  ], { ...environmentStrings(process.env), CODEX_HOME: request.codexHome });
  const [hostIdentity, nativeIdentity] = await Promise.all([
    runtime.describeProcess(runtime.hostPid),
    runtime.describeProcess(child.pid),
  ]);
  if (
    hostIdentity.pid !== runtime.hostPid || nativeIdentity.pid !== child.pid ||
    nativeIdentity.parentPid !== runtime.hostPid ||
    !sameWindowsPath(nativeIdentity.executablePath, request.executable)
  ) {
    await runtime.stopProcessTree(child).catch(() => undefined);
    throw new Error("managed app-server process identity could not be established");
  }
  await runtime.writeLease({
    generation: request.generation,
    hostPid: runtime.hostPid,
    nativePid: child.pid,
    hostIdentity,
    nativeIdentity,
  });

  const diagnostics = new ByteRing(DIAGNOSTIC_LIMIT_BYTES);
  let running = true;
  let diagnosticWrite: Promise<void> | undefined;
  let diagnosticsDirty = false;
  const persistDiagnostics = (): void => {
    diagnosticsDirty = true;
    if (diagnosticWrite) return;
    diagnosticWrite = (async () => {
      while (diagnosticsDirty) {
        diagnosticsDirty = false;
        const snapshot = diagnostics.text();
        await runtime.writeDiagnostics(snapshot).catch(() => undefined);
      }
    })().finally(() => {
      diagnosticWrite = undefined;
      if (diagnosticsDirty) persistDiagnostics();
    });
  };
  const readers = [
    drain(child.stdout, diagnostics, persistDiagnostics),
    drain(child.stderr, diagnostics, persistDiagnostics),
  ];
  const controls = monitorControl(
    request,
    child,
    nativeIdentity,
    runtime,
    () => running,
  ).catch(() => undefined);
  try {
    const exitCode = await child.exited;
    running = false;
    await Promise.all(readers);
    await controls;
    persistDiagnostics();
    while (diagnosticWrite) await diagnosticWrite;
    await runtime.writeDiagnostics(diagnostics.text());
    return exitCode;
  } finally {
    running = false;
  }
}

async function monitorControl(
  request: WindowsAppServerHostRequest,
  child: WindowsHostedProcess,
  nativeIdentity: WindowsProcessIdentity,
  runtime: WindowsAppServerHostRuntime,
  isRunning: () => boolean,
): Promise<void> {
  while (isRunning()) {
    try {
      const control = await runtime.readControlRequest().catch(() => undefined);
      if (
        control?.schemaVersion === 1 && control.generation === request.generation &&
        control.hostPid === runtime.hostPid && control.nativePid === child.pid
      ) {
        if (control.action === "probe") {
          await runtime.writeControlResponse({ ...control, status: "alive" });
        } else {
          const currentIdentity = await runtime.describeProcess(child.pid);
          if (!sameProcessIdentity(currentIdentity, nativeIdentity)) {
            throw new Error("managed native process identity changed before tree stop");
          }
          await runtime.stopProcessTree(child);
          await child.exited;
          await runtime.writeControlResponse({ ...control, status: "stopped" });
          return;
        }
      }
    } catch {
      // A single CIM or filesystem failure must not permanently disable host control.
    }
    await runtime.sleep(25).catch(() => undefined);
  }
}

class ByteRing {
  readonly #limit: number;
  #chunks: Uint8Array[] = [];
  #bytes = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  append(value: Uint8Array): void {
    this.#chunks.push(value.slice());
    this.#bytes += value.byteLength;
    while (this.#bytes > this.#limit && this.#chunks.length > 0) {
      const first = this.#chunks[0];
      if (!first) break;
      const excess = this.#bytes - this.#limit;
      if (first.byteLength <= excess) {
        this.#chunks.shift();
        this.#bytes -= first.byteLength;
      } else {
        this.#chunks[0] = first.slice(excess);
        this.#bytes -= excess;
      }
    }
  }

  text(): string {
    const bytes = new Uint8Array(this.#bytes);
    let offset = 0;
    for (const chunk of this.#chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  ring: ByteRing,
  onChunk: () => void,
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      ring.append(value);
      onChunk();
    }
  } finally {
    reader.releaseLock();
  }
}

function sameWindowsPath(first: string, second: string): boolean {
  return first.replaceAll("/", "\\").toLowerCase() ===
    second.replaceAll("/", "\\").toLowerCase();
}

function sameProcessIdentity(
  first: WindowsProcessIdentity,
  second: WindowsProcessIdentity,
): boolean {
  return first.pid === second.pid && first.parentPid === second.parentPid &&
    first.creationDate === second.creationDate &&
    sameWindowsPath(first.executablePath, second.executablePath) &&
    first.commandLine === second.commandLine;
}

function environmentStrings(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
