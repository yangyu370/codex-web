import { describe, expect, test } from "bun:test";

import type { NativeTurnInput } from "../app-server/adapter";
import { WebState } from "./state";
import { TurnCoordinator } from "./turn-coordinator";

describe("TurnCoordinator", () => {
  test("builds escaped manifest text and exact native image inputs", async () => {
    const state = stateWithThread();
    const inputs: NativeTurnInput[][] = [];
    const calls: unknown[] = [];
    const coordinator = new TurnCoordinator(state, {
      prepareForTurn: async (sessionId, cwd) => {
        calls.push(["prepare", sessionId, cwd]);
        return {
          sessionId,
          attachments: [
            { name: "notes\n\".ts", size: 5, kind: "text", path: "/project/a-notes.ts" },
            { name: "photo.png", size: 8, kind: "image", path: "/project/a-photo.png" },
          ],
        };
      },
      bindTurn: async (...args) => { calls.push(["bind", ...args]); },
      releaseTurn: async (...args) => { calls.push(["release", ...args]); },
      completeTurn: async (...args) => { calls.push(["complete", ...args]); },
    }, () => ({
      startTurn: async (_threadId, value) => {
        inputs.push(value);
        return { id: "turn-1", threadId: "thread-1", status: "inProgress" as const };
      },
    }));

    await coordinator.start(
      "thread-1",
      "",
      "11111111-1111-4111-8111-111111111111",
    );

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.[0]).toMatchObject({ type: "text" });
    expect((inputs[0]?.[0] as { text: string }).text).toContain("Review the attached files.");
    expect((inputs[0]?.[0] as { text: string }).text).toContain('"notes\\n\\\".ts"');
    expect(inputs[0]?.[1]).toEqual({ type: "localImage", path: "/project/a-photo.png" });
    expect(calls).toEqual([
      ["prepare", "11111111-1111-4111-8111-111111111111", "/project"],
      ["bind", "11111111-1111-4111-8111-111111111111", "thread-1", "turn-1"],
    ]);
    coordinator.close();
  });

  test("releases a prepared session when turn start fails", async () => {
    const state = stateWithThread();
    const calls: unknown[] = [];
    const coordinator = new TurnCoordinator(state, attachmentActions(calls), () => ({
      startTurn: async () => { throw new Error("codexRejected: turn/start"); },
    }));

    await expect(coordinator.start("thread-1", "retry", "session-1"))
      .rejects.toThrow("codexRejected");
    expect(calls.at(-1)).toEqual(["release", "session-1"]);
    coordinator.close();
  });

  test("forwards terminal events even when completion races ahead of binding", async () => {
    const state = stateWithThread();
    const calls: unknown[] = [];
    const coordinator = new TurnCoordinator(state, attachmentActions(calls), () => ({
      startTurn: async () => {
        state.applyNotification({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        });
        return { id: "turn-1", threadId: "thread-1", status: "inProgress" as const };
      },
    }));

    await coordinator.start("thread-1", "done", "session-1");

    expect(calls).toContainEqual(["complete", "thread-1", "turn-1"]);
    expect(calls).toContainEqual(["bind", "session-1", "thread-1", "turn-1"]);
    coordinator.close();
  });
});

function stateWithThread(): WebState {
  const state = new WebState("macos");
  state.upsertThread({
    id: "thread-1",
    title: "Task",
    preview: "Task",
    cwd: "/project",
    createdAt: 1,
    updatedAt: 2,
  });
  return state;
}

function attachmentActions(calls: unknown[]) {
  return {
    prepareForTurn: async (sessionId: string) => {
      calls.push(["prepare", sessionId]);
      return { sessionId, attachments: [] };
    },
    bindTurn: async (...args: string[]) => { calls.push(["bind", ...args]); },
    releaseTurn: async (...args: string[]) => { calls.push(["release", ...args]); },
    completeTurn: async (...args: string[]) => { calls.push(["complete", ...args]); },
  };
}
