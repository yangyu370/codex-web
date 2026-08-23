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

describe("TaskSettings", () => {
  test("reports the selected model through onModelChange", async () => {
    const selections: string[] = [];
    render(
      <TaskSettings
        editableModel
        model="gpt-5.6"
        models={models}
        onModelChange={(model) => selections.push(model)}
        onReview={() => undefined}
      />,
    );
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText("Task model"), "fast");

    expect(selections).toEqual(["fast"]);
  });

  test("shows the model as read-only while the loaded task controls it", () => {
    render(
      <TaskSettings
        model="gpt-5.6"
        models={models}
        onModelChange={() => undefined}
        onReview={() => undefined}
      />,
    );

    const model = screen.getByLabelText("Task model") as HTMLSelectElement;
    expect(model.disabled).toBe(true);
    expect(model.title).toBe("The loaded task controls its model");
  });

  test("disables review with an exact reason", () => {
    render(
      <TaskSettings
        model="gpt-5.6"
        models={models}
        onModelChange={() => undefined}
        onReview={() => undefined}
        reviewDisabledReason="Wait for the active turn to finish"
      />,
    );

    const review = screen.getByRole("button", { name: "Review changes" });
    expect((review as HTMLButtonElement).disabled).toBe(true);
    expect(review.getAttribute("title")).toBe("Wait for the active turn to finish");
  });
});
