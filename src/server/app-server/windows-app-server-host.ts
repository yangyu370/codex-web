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

export interface WindowsAppServerHostRuntime {
  hostPid: number;
  now(): number;
  spawn(command: string[], env: Record<string, string>): WindowsHostedProcess;
  writeLease(lease: {
    generation: string;
    hostPid: number;
    nativePid: number;
  }): Promise<void>;
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
  await runtime.writeLease({
    generation: request.generation,
    hostPid: runtime.hostPid,
    nativePid: child.pid,
  });

  const diagnostics = new ByteRing(DIAGNOSTIC_LIMIT_BYTES);
  const stopChild = (): void => child.kill("SIGTERM");
  process.once("SIGINT", stopChild);
  process.once("SIGTERM", stopChild);
  const readers = [
    drain(child.stdout, diagnostics),
    drain(child.stderr, diagnostics),
  ];
  try {
    const exitCode = await child.exited;
    await Promise.all(readers);
    await runtime.writeDiagnostics(diagnostics.text());
    return exitCode;
  } finally {
    process.off("SIGINT", stopChild);
    process.off("SIGTERM", stopChild);
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

async function drain(stream: ReadableStream<Uint8Array>, ring: ByteRing): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      ring.append(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function environmentStrings(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
