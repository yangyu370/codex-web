import type { ThreadAccess, ThreadSummary } from "../../shared/protocol";

export interface HistoryThreadRefresherOptions<T> {
  read(threadId: string): Promise<T>;
  project(threadId: string, value: T): void;
  signature(value: T): string;
  retryOpen?: (threadId: string) => Promise<void>;
  intervalMs?: number;
  maxBackoffMs?: number;
  setTimeout?: (callback: () => void | Promise<void>, milliseconds: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  onError?: (error: Error) => void;
}

export class HistoryThreadRefresher<T> {
  readonly #options: Required<Omit<HistoryThreadRefresherOptions<T>, "onError" | "retryOpen">>
    & Pick<HistoryThreadRefresherOptions<T>, "onError" | "retryOpen">;
  #selected?: ThreadAccess;
  #browserCount = 0;
  #timer?: unknown;
  #generation = 0;
  #inFlight?: { generation: number; promise: Promise<void> };
  #lastSignature?: string;
  #catalogUpdatedAt?: number;
  #failures = 0;
  #closed = false;

  constructor(options: HistoryThreadRefresherOptions<T>) {
    this.#options = {
      ...options,
      intervalMs: options.intervalMs ?? 3_000,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      setTimeout: options.setTimeout ?? ((callback, milliseconds) =>
        setTimeout(() => void callback(), milliseconds)),
      clearTimeout: options.clearTimeout ?? ((timer) => clearTimeout(
        timer as ReturnType<typeof setTimeout>,
      )),
    };
  }

  select(access: ThreadAccess | undefined): void {
    if (this.#closed) return;
    this.#generation += 1;
    this.#cancelTimer();
    this.#selected = access?.mode === "historyOnly" ? access : undefined;
    this.#lastSignature = undefined;
    this.#catalogUpdatedAt = undefined;
    this.#failures = 0;
    this.#schedule();
  }

  browserConnected(): void {
    if (this.#closed) return;
    this.#browserCount += 1;
    if (this.#browserCount === 1) this.#schedule();
  }

  browserDisconnected(): void {
    if (this.#browserCount === 0) return;
    this.#browserCount -= 1;
    if (this.#browserCount === 0) this.#cancelTimer();
  }

  focus(): void {
    this.#refreshNow();
  }

  catalogUpdated(threads: ThreadSummary[]): void {
    const threadId = this.#selected?.threadId;
    if (!threadId) return;
    const updatedAt = threads.find((thread) => thread.id === threadId)?.updatedAt;
    if (updatedAt === undefined) return;
    const previous = this.#catalogUpdatedAt;
    this.#catalogUpdatedAt = updatedAt;
    if (previous !== undefined && previous !== updatedAt) {
      if (this.#options.retryOpen && this.#eligible()) {
        void this.#options.retryOpen(threadId).catch((error: unknown) => {
          this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
        });
      } else {
        this.#refreshNow();
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    this.#browserCount = 0;
    this.#selected = undefined;
    this.#cancelTimer();
  }

  #eligible(): boolean {
    return !this.#closed && this.#browserCount > 0 && this.#selected?.mode === "historyOnly";
  }

  #refreshNow(): void {
    if (!this.#eligible()) return;
    this.#cancelTimer();
    void this.#refresh();
  }

  #refresh(): Promise<void> {
    const generation = this.#generation;
    const current = this.#inFlight;
    if (current?.generation === generation) return current.promise;
    const threadId = this.#selected?.threadId;
    if (!threadId || !this.#eligible()) return Promise.resolve();

    let read: Promise<T>;
    try {
      read = this.#options.read(threadId);
    } catch (error) {
      read = Promise.reject(error);
    }
    const promise = read.then((value) => {
      if (generation !== this.#generation || this.#selected?.threadId !== threadId) return;
      const signature = this.#options.signature(value);
      if (signature !== this.#lastSignature) {
        this.#options.project(threadId, value);
        this.#lastSignature = signature;
      }
      this.#failures = 0;
    }).catch((error: unknown) => {
      if (generation !== this.#generation) return;
      this.#failures += 1;
      this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      if (this.#inFlight?.promise === promise) this.#inFlight = undefined;
      if (generation === this.#generation) this.#schedule();
    });
    this.#inFlight = { generation, promise };
    return promise;
  }

  #schedule(): void {
    if (!this.#eligible() || this.#timer !== undefined) return;
    const multiplier = 2 ** this.#failures;
    const delay = Math.min(
      this.#options.intervalMs * multiplier,
      this.#options.maxBackoffMs,
    );
    this.#timer = this.#options.setTimeout(() => {
      this.#timer = undefined;
      return this.#refresh();
    }, delay);
  }

  #cancelTimer(): void {
    if (this.#timer === undefined) return;
    this.#options.clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
