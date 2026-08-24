import type { ThreadAccess, ThreadSummary } from "../../shared/protocol";
import { CodexRejectedError } from "../app-server/adapter";

export interface ThreadAccessLoader {
  resumeThread(threadId: string, access: ThreadAccess): Promise<ThreadSummary>;
  readThread(threadId: string, access: ThreadAccess): Promise<ThreadSummary>;
}

export interface OpenedThread {
  thread: ThreadSummary;
  access: ThreadAccess;
}

export class ThreadAccessController {
  readonly #loader: ThreadAccessLoader;
  readonly #opens = new Map<string, Promise<OpenedThread>>();

  constructor(loader: ThreadAccessLoader) {
    this.#loader = loader;
  }

  open(threadId: string): Promise<OpenedThread> {
    const existing = this.#opens.get(threadId);
    if (existing) return existing;
    const pending = this.#open(threadId).finally(() => {
      if (this.#opens.get(threadId) === pending) this.#opens.delete(threadId);
    });
    this.#opens.set(threadId, pending);
    return pending;
  }

  async #open(threadId: string): Promise<OpenedThread> {
    const readWrite: ThreadAccess = { threadId, mode: "readWrite" };
    try {
      const thread = await this.#loader.resumeThread(threadId, readWrite);
      return { thread, access: readWrite };
    } catch (error) {
      if (!isActiveWriterConflict(error)) throw error;
    }

    const historyOnly: ThreadAccess = {
      threadId,
      mode: "historyOnly",
      reason: "activeWriter",
    };
    const thread = await this.#loader.readThread(threadId, historyOnly);
    return { thread, access: historyOnly };
  }
}

export function isActiveWriterConflict(error: unknown): boolean {
  if (!(error instanceof CodexRejectedError) || !error.native) return false;
  return error.native.code === -32600 &&
    normalizeNativeMessage(error.native.message).includes("already has an active writer");
}

function normalizeNativeMessage(message: string): string {
  return message.trim().toLowerCase().replace(/\s+/g, " ");
}
