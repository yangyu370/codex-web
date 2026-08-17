import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";

import type { BrowserSnapshot } from "../shared/protocol";
import { App } from "./App";

const emptySnapshot: BrowserSnapshot = {
  kind: "snapshot",
  sequence: 0,
  service: {
    status: "ready",
    platform: "macos",
    codexVersion: "codex-cli 1.2.3",
  },
  models: [
    {
      id: "gpt-5.6",
      displayName: "GPT-5.6",
      description: "Frontier coding model",
      isDefault: true,
    },
  ],
  threads: [],
  visibleItems: [],
  pendingApprovals: [],
};

describe("Codex web shell", () => {
  test("renders the daily-work layout and empty composer", () => {
    render(<App initialSnapshot={emptySnapshot} />);

    expect(screen.getByRole("navigation", { name: "Tasks" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "New task" })).not.toBeNull();
    expect(screen.getByRole("main").textContent).toContain("What would you like to build?");
    expect(screen.getByRole("complementary", { name: "Activity" })).not.toBeNull();
    expect(
      (screen.getByRole("textbox", { name: "Message Codex" }) as HTMLTextAreaElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement).value,
    ).toBe("gpt-5.6");
  });

  test("renders loaded conversation and pending work", () => {
    render(
      <App
        initialSnapshot={{
          ...emptySnapshot,
          loadedThreadId: "t1",
          threads: [
            {
              id: "t1",
              title: "Build the web UI",
              preview: "Build the web UI",
              createdAt: 1,
              updatedAt: 2,
              cwd: "/work/codex-web",
            },
          ],
          visibleItems: [
            {
              id: "u1",
              type: "message",
              role: "user",
              text: "Match the Codex client",
            },
            {
              id: "c1",
              type: "command",
              command: "bun test",
              output: "18 pass",
              status: "completed",
            },
          ],
          pendingApprovals: [
            {
              id: "a1",
              requestId: 9,
              kind: "fileChange",
              threadId: "t1",
              turnId: "turn1",
              reason: "Apply the patch",
              availableDecisions: ["accept", "decline"],
              status: "pending",
            },
          ],
        }}
      />,
    );

    expect(screen.getAllByText("Build the web UI").length).toBeGreaterThan(0);
    expect(screen.getByText("Match the Codex client")).not.toBeNull();
    expect(screen.getAllByText("18 pass")).toHaveLength(2);
    expect(screen.getByText("Apply the patch")).not.toBeNull();
  });
});
