import { describe, expect, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { BrowserSnapshot } from "../shared/protocol";
import { App } from "./App";
import { CodexWebClient, type SocketLike } from "./websocket";

class WorkflowSocket implements SocketLike {
  readyState = 1;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(value: string): void { this.sent.push(value); }
  close(): void { this.onclose?.(); }
  receive(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

const emptySnapshot: BrowserSnapshot = {
  kind: "snapshot",
  sequence: 0,
  service: { status: "ready", platform: "macos" },
  models: [{ id: "gpt-5.6", displayName: "GPT-5.6", isDefault: true }],
  threads: [],
  visibleItems: [],
  pendingApprovals: [],
};

describe("live client workflows", () => {
  test("starts a thread before sending the first turn", async () => {
    const socket = new WorkflowSocket();
    const client = new CodexWebClient(emptySnapshot, () => socket);
    client.connect();
    socket.onopen?.();
    render(<App client={client} initialSnapshot={emptySnapshot} />);
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox", { name: "Working directory" }), "/work/app");
    await user.type(screen.getByRole("textbox", { name: "Message Codex" }), "Run the tests");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const start = JSON.parse(socket.sent[0] ?? "null");
    expect(start).toMatchObject({
      method: "thread.start",
      params: { cwd: "/work/app", model: "gpt-5.6" },
    });
    socket.receive({ kind: "response", id: start.id, result: { id: "t1" } });
    await Bun.sleep(0);
    const turn = JSON.parse(socket.sent[1] ?? "null");
    expect(turn).toMatchObject({
      method: "turn.start",
      params: { threadId: "t1", text: "Run the tests" },
    });
  });

  test("applies live snapshots and resolves an approval", async () => {
    const socket = new WorkflowSocket();
    const client = new CodexWebClient(emptySnapshot, () => socket);
    client.connect();
    socket.onopen?.();
    render(<App client={client} initialSnapshot={emptySnapshot} />);
    const user = userEvent.setup();

    act(() => {
      socket.receive({
        ...emptySnapshot,
        sequence: 2,
        loadedThreadId: "t1",
        visibleItems: [
          { id: "a1", type: "message", role: "assistant", text: "Tests are running" },
        ],
        pendingApprovals: [
          {
            id: "approval:9",
            requestId: 9,
            kind: "command",
            threadId: "t1",
            turnId: "turn1",
            reason: "Install dependencies",
            availableDecisions: ["accept", "decline"],
            status: "pending",
          },
        ],
      });
    });
    expect(await screen.findByText("Tests are running")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(JSON.parse(socket.sent.at(-1) ?? "null")).toMatchObject({
      method: "approval.resolve",
      params: { approvalId: "approval:9", decision: "accept" },
    });
  });
});
