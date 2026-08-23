import { beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TaskSettings } from "./TaskSettings";

beforeEach(cleanup);

const models = [
  {
    id: "gpt-5.6",
    displayName: "GPT-5.6",
    supportedReasoningEfforts: [
      { id: "low", description: "Fast" },
      { id: "high", description: "Thorough" },
    ],
    defaultReasoningEffort: "high",
  },
  {
    id: "fast",
    displayName: "Fast",
    supportedReasoningEfforts: [{ id: "low", description: "Fast" }],
    defaultReasoningEffort: "low",
  },
];

const profiles = [
  { id: ":read-only", description: "Server read-only description", allowed: true },
  { id: ":workspace", description: "Workspace access", allowed: true },
  { id: ":danger-full-access", description: "Server full access description", allowed: true },
  { id: ":custom", description: "Custom native profile", allowed: true },
  { id: ":blocked", description: "Managed policy blocks this profile", allowed: false },
];

describe("TaskSettings", () => {
  test("opens the permissions menu with friendly names and sends the native full-access profile id", async () => {
    const changes: unknown[] = [];
    render(
      <TaskSettings
        effort="low"
        model="gpt-5.6"
        models={models}
        onReview={() => undefined}
        onSettingsChange={(change) => changes.push(change)}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
        reviewEnabled
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Permissions" }));

    expect(screen.getByRole("dialog", { name: "How should Codex run?" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Ask for approval" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Approve when needed" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Full access" })).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Full access" }));
    await user.selectOptions(screen.getByLabelText("Reasoning effort"), "high");

    expect(changes).toEqual([
      { permissionProfile: ":danger-full-access" },
      { effort: "high" },
    ]);
  });

  test("keeps disallowed profiles disabled and does not select them", async () => {
    const changes: unknown[] = [];
    render(
      <TaskSettings
        model="gpt-5.6"
        models={models}
        onReview={() => undefined}
        onSettingsChange={(change) => changes.push(change)}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Permissions" }));

    const blocked = screen.getByRole("button", { name: ":blocked" }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(screen.getByText("Managed policy blocks this profile")).not.toBeNull();
    await user.click(blocked);

    expect(changes).toEqual([]);
  });

  test("dismisses the open permissions menu with Escape and restores trigger focus", async () => {
    render(
      <TaskSettings
        model="gpt-5.6"
        models={models}
        onReview={() => undefined}
        onSettingsChange={() => undefined}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
      />,
    );
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Permissions" });

    await user.click(trigger);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "How should Codex run?" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("keeps an unknown allowed profile selectable by its native id", async () => {
    const changes: unknown[] = [];
    render(
      <TaskSettings
        model="gpt-5.6"
        models={models}
        onReview={() => undefined}
        onSettingsChange={(change) => changes.push(change)}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Permissions" }));
    expect(screen.getByRole("button", { name: ":custom" })).not.toBeNull();
    expect(screen.getByText("Custom native profile")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: ":custom" }));

    expect(changes).toEqual([{ permissionProfile: ":custom" }]);
  });

  test("dismisses the open permissions menu on an outside pointer interaction", async () => {
    render(
      <TaskSettings
        model="gpt-5.6"
        models={models}
        onReview={() => undefined}
        onSettingsChange={() => undefined}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Permissions" }));
    expect(screen.getByRole("dialog", { name: "How should Codex run?" })).not.toBeNull();
    await user.click(document.body);

    expect(screen.queryByRole("dialog", { name: "How should Codex run?" })).toBeNull();
  });

  test("selects an option from the keyboard and restores focus to the trigger", async () => {
    const changes: unknown[] = [];
    render(
      <TaskSettings
        model="gpt-5.6"
        models={models}
        onReview={() => undefined}
        onSettingsChange={(change) => changes.push(change)}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
      />,
    );
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Permissions" });

    await user.click(trigger);
    const fullAccess = screen.getByRole("button", { name: "Full access" });
    fullAccess.focus();
    await user.keyboard("{Enter}");

    expect(changes).toEqual([{ permissionProfile: ":danger-full-access" }]);
    expect(document.activeElement).toBe(trigger);
  });

  test("disables the permissions trigger while its setting update is pending", () => {
    render(
      <TaskSettings
        model="gpt-5.6"
        models={models}
        onReview={() => undefined}
        onSettingsChange={() => undefined}
        pending="permissionProfile"
        permissionProfile=":workspace"
        permissionProfiles={profiles}
      />,
    );

    expect((screen.getByRole("button", { name: "Permissions" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("moves to the selected model default when the current effort is unsupported", async () => {
    const selections: unknown[] = [];
    render(
      <TaskSettings
        editableModel
        effort="high"
        model="gpt-5.6"
        models={models}
        onModelChange={(model, effort) => selections.push({ model, effort })}
        onReview={() => undefined}
        onSettingsChange={() => undefined}
        permissionProfiles={profiles}
        reviewEnabled
      />,
    );
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText("Task model"), "fast");

    expect(selections).toEqual([{ model: "fast", effort: "low" }]);
  });

  test("marks running changes for the next turn and disables review with an exact reason", () => {
    render(
      <TaskSettings
        effort="high"
        model="gpt-5.6"
        models={models}
        onReview={() => undefined}
        onSettingsChange={() => undefined}
        permissionProfiles={profiles}
        reviewDisabledReason="Wait for the active turn to finish"
        running
      />,
    );

    expect(screen.getAllByText("Next turn")).toHaveLength(2);
    const review = screen.getByRole("button", { name: "Review changes" });
    expect((review as HTMLButtonElement).disabled).toBe(true);
    expect(review.getAttribute("title")).toBe("Wait for the active turn to finish");
  });

  test("preserves an authoritative reasoning effort not yet present in model metadata", () => {
    render(
      <TaskSettings
        effort="ultra"
        model="gpt-5.6"
        models={models}
        onReview={() => undefined}
        onSettingsChange={() => undefined}
        permissionProfiles={profiles}
      />,
    );

    const effort = screen.getByRole("combobox", { name: "Reasoning effort" }) as HTMLSelectElement;
    expect(effort.value).toBe("ultra");
    expect(screen.getByRole("option", { name: "ultra · Current task value" })).not.toBeNull();
  });
});
