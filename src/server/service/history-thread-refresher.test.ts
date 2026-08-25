import { describe, expect, test } from "bun:test";

import type { ThreadAccess, ThreadSummary } from "../../shared/protocol";
import { HistoryThreadRefresher } from "./history-thread-refresher";

interface History {
  revision: number;
  text: string;
}

const historyOnly = (threadId: string): ThreadAccess => ({
  threadId,
  mode: "historyOnly",
  reason: "activeWriter",
});

describe("HistoryThreadRefresher", () => {
  test("polls every three seconds only while a browser observes history-only access", async () => {
    const clock = fakeClock();
    const reads: string[] = [];
    const refresher = createRefresher(clock, {
      read: async (threadId) => {
        reads.push(threadId);
        return { revision: reads.length, text: "history" };
      },
    });

    refresher.select(historyOnly("thread-1"));
    expect(clock.pending()).toEqual([]);
    refresher.browserConnected();
    expect(clock.pending()).toEqual([3_000]);
    expect(reads).toEqual([]);

    await clock.runNext();
    expect(reads).toEqual(["thread-1"]);
    expect(clock.pending()).toEqual([3_000]);

    refresher.browserDisconnected();
    expect(clock.pending()).toEqual([]);
    await clock.runAll();
    expect(reads).toEqual(["thread-1"]);
  });

  test("single-flights polling, focus, and catalog refreshes", async () => {
    const clock = fakeClock();
    let reads = 0;
    let release!: (value: History) => void;
    const pending = new Promise<History>((resolve) => { release = resolve; });
    const refresher = createRefresher(clock, {
      read: async () => { reads += 1; return pending; },
    });
    refresher.select(historyOnly("thread-1"));
    refresher.browserConnected();

    const poll = clock.runNext();
    refresher.focus();
    refresher.catalogUpdated([thread("thread-1", 2)]);
    expect(reads).toBe(1);
    release({ revision: 1, text: "loaded" });
    await poll;
    await Bun.sleep(0);

    expect(reads).toBe(1);
    expect(clock.pending()).toEqual([3_000]);
  });

  test("suppresses projection when refreshed history is unchanged", async () => {
    const clock = fakeClock();
    const projected: History[] = [];
    const refresher = createRefresher(clock, {
      read: async () => ({ revision: 1, text: "same" }),
      project: (_threadId, history) => { projected.push(history); },
    });
    refresher.select(historyOnly("thread-1"));
    refresher.browserConnected();

    await clock.runNext();
    await clock.runNext();

    expect(projected).toEqual([{ revision: 1, text: "same" }]);
  });

  test("focus refreshes immediately and catalog changes refresh only the selected thread", async () => {
    const clock = fakeClock();
    let reads = 0;
    const refresher = createRefresher(clock, {
      read: async () => ({ revision: ++reads, text: "history" }),
    });
    refresher.select(historyOnly("thread-1"));
    refresher.browserConnected();

    refresher.catalogUpdated([thread("thread-1", 1)]);
    await Bun.sleep(0);
    expect(reads).toBe(0);
    refresher.catalogUpdated([thread("thread-2", 9), thread("thread-1", 2)]);
    await Bun.sleep(0);
    expect(reads).toBe(1);

    refresher.focus();
    await Bun.sleep(0);
    expect(reads).toBe(2);
    expect(clock.pending()).toEqual([3_000]);
  });

  test("retries opening a history-only task when its catalog revision changes", async () => {
    const clock = fakeClock();
    const retries: string[] = [];
    const refresher = createRefresher(clock, {
      retryOpen: async (threadId) => { retries.push(threadId); },
    });
    refresher.select(historyOnly("thread-1"));
    refresher.browserConnected();

    refresher.catalogUpdated([thread("thread-1", 1)]);
    refresher.catalogUpdated([thread("thread-1", 2)]);
    await Bun.sleep(0);

    expect(retries).toEqual(["thread-1"]);
  });

  test("drops stale reads after selection changes and clears read-write polling", async () => {
    const clock = fakeClock();
    const projected: Array<[string, History]> = [];
    let release!: (value: History) => void;
    const pending = new Promise<History>((resolve) => { release = resolve; });
    const refresher = createRefresher(clock, {
      read: async () => pending,
      project: (threadId, history) => { projected.push([threadId, history]); },
    });
    refresher.select(historyOnly("thread-1"));
    refresher.browserConnected();
    const oldRead = clock.runNext();

    refresher.select({ threadId: "thread-2", mode: "readWrite" });
    expect(clock.pending()).toEqual([]);
    release({ revision: 1, text: "stale" });
    await oldRead;

    expect(projected).toEqual([]);
    expect(clock.pending()).toEqual([]);
  });

  test("backs failures off exponentially and caps retry delay at thirty seconds", async () => {
    const clock = fakeClock();
    const errors: string[] = [];
    let attempts = 0;
    const refresher = createRefresher(clock, {
      read: async () => { attempts += 1; throw new Error(`failure ${attempts}`); },
      onError: (error) => errors.push(error.message),
    });
    refresher.select(historyOnly("thread-1"));
    refresher.browserConnected();

    const delays = [3_000];
    for (let index = 0; index < 5; index += 1) {
      await clock.runNext();
      delays.push(clock.pending()[0] ?? 0);
    }

    expect(delays).toEqual([3_000, 6_000, 12_000, 24_000, 30_000, 30_000]);
    expect(errors).toHaveLength(5);
    refresher.close();
    expect(clock.pending()).toEqual([]);
  });

  test("normalizes synchronous reader failures into the same retry path", async () => {
    const clock = fakeClock();
    const errors: string[] = [];
    const refresher = createRefresher(clock, {
      read: (() => { throw new Error("adapter unavailable"); }) as () => Promise<History>,
      onError: (error) => errors.push(error.message),
    });
    refresher.select(historyOnly("thread-1"));
    refresher.browserConnected();

    await expect(clock.runNext()).resolves.toBeUndefined();
    expect(errors).toEqual(["adapter unavailable"]);
    expect(clock.pending()).toEqual([6_000]);
  });
});

function createRefresher(
  clock: ReturnType<typeof fakeClock>,
  overrides: {
    read?: (threadId: string) => Promise<History>;
    project?: (threadId: string, history: History) => void;
    onError?: (error: Error) => void;
    retryOpen?: (threadId: string) => Promise<void>;
  } = {},
): HistoryThreadRefresher<History> {
  return new HistoryThreadRefresher<History>({
    read: overrides.read ?? (async () => ({ revision: 1, text: "history" })),
    project: overrides.project ?? (() => undefined),
    signature: (history) => `${history.revision}:${history.text}`,
    onError: overrides.onError,
    retryOpen: overrides.retryOpen,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
}

function thread(id: string, updatedAt: number): ThreadSummary {
  return {
    id,
    title: id,
    preview: "",
    createdAt: 1,
    updatedAt,
  };
}

function fakeClock() {
  let nextId = 1;
  const timers = new Map<number, { callback: () => void | Promise<void>; milliseconds: number }>();
  return {
    setTimeout(callback: () => void | Promise<void>, milliseconds: number): number {
      const id = nextId++;
      timers.set(id, { callback, milliseconds });
      return id;
    },
    clearTimeout(id: unknown): void {
      timers.delete(Number(id));
    },
    pending(): number[] {
      return [...timers.values()].map((timer) => timer.milliseconds);
    },
    async runNext(): Promise<void> {
      const entry = timers.entries().next().value as
        | [number, { callback: () => void | Promise<void>; milliseconds: number }]
        | undefined;
      if (!entry) return;
      timers.delete(entry[0]);
      await entry[1].callback();
    },
    async runAll(): Promise<void> {
      while (timers.size > 0) await this.runNext();
    },
  };
}
