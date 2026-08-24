import type { ThreadAccess, ThreadSummary } from "../../shared/protocol";
import { CodexRejectedError } from "../app-server/adapter";

export interface ThreadAccessLoader {
  resumeThread(
    threadId: string,
    access: ThreadAccess,
    isCurrent: () => boolean,
  ): Promise<ThreadSummary>;
  readThread(
    threadId: string,
    access: ThreadAccess,
    isCurrent: () => boolean,
  ): Promise<ThreadSummary>;
}

export interface OpenedThread {
  thread: ThreadSummary;
  access: ThreadAccess;
}

export class ThreadAccessController {
  readonly #loader: ThreadAccessLoader;
  readonly #opens = new Map<string, Promise<OpenedThread>>();
  #generation = 0;
  #selectedThreadId?: string;

  constructor(loader: ThreadAccessLoader) {
    this.#loader = loader;
  }

  open(threadId: string): Promise<OpenedThread> {
    const existing = this.#opens.get(threadId);
    if (existing && this.#selectedThreadId === threadId) return existing;
    this.#selectedThreadId = threadId;
    const generation = ++this.#generation;
    const pending = this.#open(threadId, generation).finally(() => {
      if (this.#opens.get(threadId) === pending) this.#opens.delete(threadId);
    });
    this.#opens.set(threadId, pending);
    return pending;
  }

  invalidate(): void {
    this.#selectedThreadId = undefined;
    this.#generation += 1;
  }

  async #open(threadId: string, generation: number): Promise<OpenedThread> {
    const isCurrent = () =>
      this.#generation === generation && this.#selectedThreadId === threadId;
    const readWrite: ThreadAccess = { threadId, mode: "readWrite" };
    try {
      const thread = await this.#loader.resumeThread(threadId, readWrite, isCurrent);
      return { thread, access: readWrite };
    } catch (error) {
      if (!isActiveWriterConflict(error)) throw error;
    }

    const historyOnly: ThreadAccess = {
      threadId,
      mode: "historyOnly",
      reason: "activeWriter",
    };
    const thread = await this.#loader.readThread(threadId, historyOnly, isCurrent);
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
