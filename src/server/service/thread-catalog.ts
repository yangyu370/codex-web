export interface ThreadCatalogRefresherOptions<T = void> {
  intervalMs?: number;
  setInterval?: (
    callback: () => void | Promise<void>,
    milliseconds: number,
  ) => unknown;
  clearInterval?: (timer: unknown) => void;
  onError?: (error: Error) => void;
  onUpdated?: (value: T) => void;
}

export class ThreadCatalogRefresher<T = void> {
  readonly #refresh: () => Promise<T>;
  readonly #options: Required<Omit<ThreadCatalogRefresherOptions<T>, "onError" | "onUpdated">>
    & Pick<ThreadCatalogRefresherOptions<T>, "onError" | "onUpdated">;
  #browserCount = 0;
  #timer?: unknown;
  #inFlight?: Promise<T | undefined>;
  #closed = false;

  constructor(refresh: () => Promise<T>, options: ThreadCatalogRefresherOptions<T> = {}) {
    this.#refresh = refresh;
    this.#options = {
      intervalMs: options.intervalMs ?? 5_000,
      setInterval: options.setInterval ?? ((callback, milliseconds) =>
        setInterval(() => void callback(), milliseconds)),
      clearInterval: options.clearInterval ?? ((timer) => clearInterval(
        timer as ReturnType<typeof setInterval>,
      )),
      onError: options.onError,
      onUpdated: options.onUpdated,
    };
  }

  browserConnected(): void {
    if (this.#closed) return;
    this.#browserCount += 1;
    if (this.#browserCount !== 1) return;
    void this.refreshNow();
    this.#timer = this.#options.setInterval(
      () => this.refreshNow().then(() => undefined),
      this.#options.intervalMs,
    );
  }

  browserDisconnected(): void {
    if (this.#browserCount === 0) return;
    this.#browserCount -= 1;
    if (this.#browserCount === 0) this.#cancelTimer();
  }

  refreshNow(): Promise<T | undefined> {
    if (this.#closed) return Promise.resolve(undefined);
    if (this.#inFlight) return this.#inFlight;
    let refresh: Promise<T>;
    try {
      refresh = this.#refresh();
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.#options.onError?.(normalized);
      return Promise.resolve(undefined);
    }
    const task = refresh.then((value) => {
      this.#options.onUpdated?.(value);
      return value;
    }).catch((error: unknown) => {
      this.#options.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
      return undefined;
    }).finally(() => {
      if (this.#inFlight === task) this.#inFlight = undefined;
    });
    this.#inFlight = task;
    return task;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#browserCount = 0;
    this.#cancelTimer();
  }

  #cancelTimer(): void {
    if (this.#timer === undefined) return;
    this.#options.clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
