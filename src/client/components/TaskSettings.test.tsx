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
  { id: ":workspace", description: "Workspace access", allowed: true },
  { id: ":blocked", description: "Managed policy blocks this profile", allowed: false },
];

describe("TaskSettings", () => {
  test("selects allowed profiles and efforts while explaining blocked profiles", async () => {
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

    await user.selectOptions(screen.getByLabelText("Permission profile"), ":workspace");
    await user.selectOptions(screen.getByLabelText("Reasoning effort"), "high");

    expect(changes).toEqual([
      { permissionProfile: ":workspace" },
      { effort: "high" },
    ]);
    const blocked = document.querySelector('option[value=":blocked"]') as HTMLOptionElement;
    expect(blocked.disabled).toBe(true);
    expect(blocked.textContent).toContain("Managed policy blocks this profile");
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
});
