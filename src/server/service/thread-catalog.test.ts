import { describe, expect, test } from "bun:test";

import { ThreadCatalogRefresher } from "./thread-catalog";

describe("ThreadCatalogRefresher", () => {
  test("runs only while browsers are connected and shares one interval", async () => {
    const clock = fakeClock();
    let refreshes = 0;
    const refresher = new ThreadCatalogRefresher(async () => {
      refreshes += 1;
      return refreshes;
    }, clock.options);

    expect(refreshes).toBe(0);
    refresher.browserConnected();
    await Bun.sleep(0);
    expect(refreshes).toBe(1);
    expect(clock.intervals).toHaveLength(1);
    expect(clock.intervals[0]?.milliseconds).toBe(5_000);

    refresher.browserConnected();
    expect(clock.intervals).toHaveLength(1);
    await clock.intervals[0]?.callback();
    expect(refreshes).toBe(2);

    refresher.browserDisconnected();
    expect(clock.cleared).toEqual([]);
    refresher.browserDisconnected();
    expect(clock.cleared).toEqual([1]);
  });

  test("coalesces focus and interval refreshes into one in-flight request", async () => {
    const clock = fakeClock();
    let refreshes = 0;
    let finish: (value: string) => void = () => undefined;
    const pending = new Promise<string>((resolve) => { finish = resolve; });
    const refresher = new ThreadCatalogRefresher(async () => {
      refreshes += 1;
      return pending;
    }, clock.options);

    refresher.browserConnected();
    const focused = refresher.refreshNow();
    const interval = clock.intervals[0]?.callback();
    expect(refreshes).toBe(1);

    finish("ready");
    await expect(focused).resolves.toBe("ready");
    await interval;
    expect(refreshes).toBe(1);
  });

  test("records refresh failure and can recover without clearing prior state", async () => {
    const errors: string[] = [];
    let attempt = 0;
    const refresher = new ThreadCatalogRefresher(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("temporary catalog failure");
      return "recovered";
    }, { onError: (error) => errors.push(error.message) });

    await expect(refresher.refreshNow()).resolves.toBeUndefined();
    await expect(refresher.refreshNow()).resolves.toBe("recovered");
    expect(errors).toEqual(["temporary catalog failure"]);
  });

  test("publishes successful catalog values to monitoring consumers", async () => {
    const updates: string[] = [];
    const refresher = new ThreadCatalogRefresher(async () => "catalog-1", {
      onUpdated: (value) => updates.push(value),
    });

    await expect(refresher.refreshNow()).resolves.toBe("catalog-1");
    expect(updates).toEqual(["catalog-1"]);
  });

  test("close cancels scheduling and prevents later refreshes", async () => {
    const clock = fakeClock();
    let refreshes = 0;
    const refresher = new ThreadCatalogRefresher(async () => {
      refreshes += 1;
    }, clock.options);
    refresher.browserConnected();
    await Bun.sleep(0);

    refresher.close();
    await refresher.refreshNow();
    await clock.intervals[0]?.callback();

    expect(clock.cleared).toEqual([1]);
    expect(refreshes).toBe(1);
  });
});

function fakeClock() {
  const intervals: Array<{ id: number; callback: () => void | Promise<void>; milliseconds: number }> = [];
  const cleared: number[] = [];
  return {
    intervals,
    cleared,
    options: {
      setInterval(callback: () => void | Promise<void>, milliseconds: number): number {
        const id = intervals.length + 1;
        intervals.push({ id, callback, milliseconds });
        return id;
      },
      clearInterval(id: unknown): void {
        cleared.push(Number(id));
      },
    },
  };
}
