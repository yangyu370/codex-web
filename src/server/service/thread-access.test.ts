import { describe, expect, test } from "bun:test";

import type { ThreadAccess, ThreadSummary } from "../../shared/protocol";
import { CodexRejectedError } from "../app-server/adapter";
import { JsonRpcResponseError } from "../app-server/json-rpc";
import { ThreadAccessController } from "./thread-access";

const thread: ThreadSummary = {
  id: "thread-1",
  title: "Task",
  preview: "Task",
  createdAt: 1,
  updatedAt: 2,
  canAcceptDirectInput: true,
};

describe("ThreadAccessController", () => {
  test("opens a resumable thread read-write", async () => {
    const calls: Array<[string, string, ThreadAccess]> = [];
    const access = new ThreadAccessController({
      resumeThread: async (threadId, nextAccess) => {
        calls.push(["resume", threadId, nextAccess]);
        return thread;
      },
      readThread: async (threadId, nextAccess) => {
        calls.push(["read", threadId, nextAccess]);
        return thread;
      },
    });

    await expect(access.open("thread-1")).resolves.toEqual({
      thread,
      access: { threadId: "thread-1", mode: "readWrite" },
    });
    expect(calls).toEqual([
      ["resume", "thread-1", { threadId: "thread-1", mode: "readWrite" }],
    ]);
  });

  test("falls back to history only for the 0.149.1 active-writer response", async () => {
    const calls: Array<[string, ThreadAccess]> = [];
    const access = new ThreadAccessController({
      resumeThread: async () => {
        throw new CodexRejectedError(
          "thread/resume",
          new JsonRpcResponseError(-32600, "thread thread-1 already has an active writer"),
        );
      },
      readThread: async (_threadId, nextAccess) => {
        calls.push(["read", nextAccess]);
        return { ...thread, canAcceptDirectInput: false };
      },
    });

    await expect(access.open("thread-1")).resolves.toEqual({
      thread: { ...thread, canAcceptDirectInput: false },
      access: {
        threadId: "thread-1",
        mode: "historyOnly",
        reason: "activeWriter",
      },
    });
    expect(calls).toEqual([["read", {
      threadId: "thread-1",
      mode: "historyOnly",
      reason: "activeWriter",
    }]]);
  });

  test("does not hide a generic native rejection behind history-only mode", async () => {
    let reads = 0;
    const rejection = new CodexRejectedError(
      "thread/resume",
      new JsonRpcResponseError(-32600, "authentication required"),
    );
    const access = new ThreadAccessController({
      resumeThread: async () => { throw rejection; },
      readThread: async () => { reads += 1; return thread; },
    });

    await expect(access.open("thread-1")).rejects.toBe(rejection);
    expect(reads).toBe(0);
  });

  test("single-flights concurrent opens of the same thread", async () => {
    let resumes = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const access = new ThreadAccessController({
      resumeThread: async () => {
        resumes += 1;
        await pending;
        return thread;
      },
      readThread: async () => thread,
    });

    const first = access.open("thread-1");
    const second = access.open("thread-1");
    await Bun.sleep(0);
    expect(resumes).toBe(1);
    release();
    expect(await first).toBe(await second);
  });

  test("prevents an older selection from projecting after a newer task opens", async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const projected: string[] = [];
    const access = new ThreadAccessController({
      resumeThread: async (threadId, _nextAccess, isCurrent) => {
        if (threadId === "thread-a") await firstPending;
        if (isCurrent()) projected.push(threadId);
        return { ...thread, id: threadId };
      },
      readThread: async (threadId) => ({ ...thread, id: threadId }),
    });

    const first = access.open("thread-a");
    await Bun.sleep(0);
    await access.open("thread-b");
    releaseFirst();
    await first;

    expect(projected).toEqual(["thread-b"]);
  });
});
