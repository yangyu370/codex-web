import { beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { TaskSettings } from "./TaskSettings";

beforeEach(cleanup);

describe("TaskSettings", () => {
  test("disables review with an exact reason", () => {
    render(
      <TaskSettings
        onReview={() => undefined}
        reviewDisabledReason="Wait for the active turn to finish"
      />,
    );

    const review = screen.getByRole("button", { name: "Review changes" });
    expect((review as HTMLButtonElement).disabled).toBe(true);
    expect(review.getAttribute("title")).toBe("Wait for the active turn to finish");
  });

  test("keeps review enabled for an idle task without a reason", () => {
    render(<TaskSettings reviewEnabled onReview={() => undefined} />);

    const review = screen.getByRole("button", { name: "Review changes" }) as HTMLButtonElement;
    expect(review.disabled).toBe(false);
    expect(review.title).toBe("Review uncommitted changes inline");
  });
});
