import { beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
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

beforeEach(cleanup);

describe("live client workflows", () => {
  test("browses and selects a project directory on the Codex host", async () => {
    const socket = new WorkflowSocket();
    const client = new CodexWebClient(emptySnapshot, () => socket);
    client.connect();
    socket.onopen?.();
    render(<App client={client} initialSnapshot={emptySnapshot} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Browse server directories" }));
    const rootRequest = JSON.parse(socket.sent[0] ?? "null");
    expect(rootRequest).toMatchObject({ method: "directory.list", params: {} });
    act(() => {
      socket.receive({
        kind: "response",
        id: rootRequest.id,
        result: {
          current: { name: "developer", path: "/Users/developer" },
          roots: [{ name: "Home", path: "/Users/developer" }],
          directories: [{ name: "projects", path: "/Users/developer/projects" }],
          truncated: false,
        },
      });
    });

    expect(await screen.findByRole("dialog", { name: "Choose a server directory" })).not.toBeNull();
    await user.click(screen.getByRole("button", { name: /projects/ }));
    const childRequest = JSON.parse(socket.sent[1] ?? "null");
    expect(childRequest).toMatchObject({
      method: "directory.list",
      params: { path: "/Users/developer/projects" },
    });
    act(() => {
      socket.receive({
        kind: "response",
        id: childRequest.id,
        result: {
          current: { name: "projects", path: "/Users/developer/projects" },
          parent: "/Users/developer",
          roots: [{ name: "Home", path: "/Users/developer" }],
          directories: [{ name: "codex", path: "/Users/developer/projects/codex" }],
          truncated: false,
        },
      });
    });

    await screen.findByText("/Users/developer/projects");
    await user.click(screen.getByRole("button", { name: "Use this folder" }));

    expect((screen.getByRole("combobox", { name: "Working directory" }) as HTMLInputElement).value)
      .toBe("/Users/developer/projects");
    expect(screen.queryByRole("dialog", { name: "Choose a server directory" })).toBeNull();
  });

  test("starts a thread before sending the first turn", async () => {
    const socket = new WorkflowSocket();
    const client = new CodexWebClient(emptySnapshot, () => socket);
    client.connect();
    socket.onopen?.();
    render(<App client={client} initialSnapshot={emptySnapshot} />);
    const user = userEvent.setup();

    await user.type(screen.getByRole("combobox", { name: "Working directory" }), "/work/app");
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
      activeTurn: { id: "turn1", threadId: "t1", status: "inProgress" },
        visibleItems: [
          { id: "a1", type: "message", role: "assistant", text: "Tests are running" },
        ],
        pendingApprovals: [
          {
            id: "approval:9",
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
    await user.click(screen.getAllByRole("button", { name: "Stop" })[0]!);
    expect(JSON.parse(socket.sent.at(-1) ?? "null")).toMatchObject({
      method: "turn.interrupt",
      params: { threadId: "t1", turnId: "turn1" },
    });
  });

  test("resumes an existing native thread when selected", async () => {
    const socket = new WorkflowSocket();
    const snapshot: BrowserSnapshot = {
      ...emptySnapshot,
      threads: [{
        id: "existing",
        title: "Existing task",
        preview: "Continue work",
        createdAt: 1,
        updatedAt: 2,
        cwd: "/work/existing",
      }],
    };
    const client = new CodexWebClient(snapshot, () => socket);
    client.connect();
    socket.onopen?.();
    render(<App client={client} initialSnapshot={snapshot} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Existing task/ }));

    expect(JSON.parse(socket.sent[0] ?? "null")).toMatchObject({
      method: "thread.resume",
      params: { threadId: "existing" },
    });
  });

  test("selects a model that arrives after the initial bootstrap", async () => {
    const socket = new WorkflowSocket();
    const snapshot = { ...emptySnapshot, models: [] };
    const client = new CodexWebClient(snapshot, () => socket);
    client.connect();
    socket.onopen?.();
    render(<App client={client} initialSnapshot={snapshot} />);
    const user = userEvent.setup();

    act(() => {
      socket.receive({
        kind: "event",
        sequence: 1,
        type: "models.updated",
        payload: { models: emptySnapshot.models },
      });
    });
    await user.type(screen.getByRole("combobox", { name: "Working directory" }), "/work/app");
    await user.type(screen.getByRole("textbox", { name: "Message Codex" }), "Hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(JSON.parse(socket.sent[0] ?? "null")).toMatchObject({
      method: "thread.start",
      params: { cwd: "/work/app", model: "gpt-5.6" },
    });
  });

  test("keeps new-task mode when an old-thread event arrives before send", async () => {
    const socket = new WorkflowSocket();
    const oldSnapshot: BrowserSnapshot = {
      ...emptySnapshot,
      loadedThreadId: "old",
      threads: [{ id: "old", title: "Old", preview: "", createdAt: 1, updatedAt: 2, cwd: "/work/old" }],
    };
    const client = new CodexWebClient(oldSnapshot, () => socket);
    client.connect();
    socket.onopen?.();
    render(<App client={client} initialSnapshot={oldSnapshot} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "New task" }));
    act(() => {
      socket.receive({
        kind: "event",
        sequence: 1,
        type: "threads.updated",
        payload: { threads: oldSnapshot.threads },
      });
    });
    await user.clear(screen.getByRole("combobox", { name: "Working directory" }));
    await user.type(screen.getByRole("combobox", { name: "Working directory" }), "/work/new");
    await user.type(screen.getByRole("textbox", { name: "Message Codex" }), "Start fresh");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(JSON.parse(socket.sent[0] ?? "null")).toMatchObject({ method: "thread.start" });
  });
});
