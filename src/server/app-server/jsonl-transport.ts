import type { JsonRpcTransport } from "./json-rpc";

const MAX_JSON_RPC_MESSAGE_BYTES = 8_388_608;

interface JsonlWriter {
  write(data: string | Uint8Array): number | Promise<number>;
  end(): void;
}

export function createJsonlTransport(
  stdout: ReadableStream<Uint8Array>,
  stdin: JsonlWriter,
): JsonRpcTransport {
  const messageListeners = new Set<(source: string) => void>();
  const closeListeners = new Set<(reason?: Error) => void>();
  let closed = false;

  const emitClose = (reason?: Error): void => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener(reason);
  };

  void consumeJsonl(stdout, {
    message(source) {
      if (closed) return;
      for (const listener of messageListeners) listener(source);
    },
    close: emitClose,
  });

  return {
    async send(source) {
      if (closed) throw new Error("app-server transport is closed");
      await stdin.write(`${source}\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      stdin.end();
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  };
}

async function consumeJsonl(
  stdout: ReadableStream<Uint8Array>,
  sink: { message(source: string): void; close(reason?: Error): void },
): Promise<void> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim().length > 0) sink.message(buffer.replace(/\r$/, ""));
        sink.close(new Error("app-server stdout closed"));
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      if (new TextEncoder().encode(buffer).byteLength > MAX_JSON_RPC_MESSAGE_BYTES) {
        sink.close(new Error("JSON-RPC message exceeds 8388608 bytes"));
        await reader.cancel();
        return;
      }

      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const message = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (message.trim().length > 0) sink.message(message);
        newline = buffer.indexOf("\n");
      }
    }
  } catch (error) {
    sink.close(error instanceof Error ? error : new Error(String(error)));
  } finally {
    reader.releaseLock();
  }
}
