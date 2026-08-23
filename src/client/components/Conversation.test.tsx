import { beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Conversation } from "./Conversation";
import type { VisibleItem } from "../../shared/protocol";

beforeEach(cleanup);

function message(id: string, text: string): VisibleItem {
  return { id, type: "message", role: "assistant", text, streaming: false };
}

function buildItems(count: number): VisibleItem[] {
  return Array.from({ length: count }, (_, index) =>
    message(`item-${index}`, `Message number ${index} with some body text.`));
}

describe("Conversation lazy rendering", () => {
  test("renders every item in full for sessions within the window", () => {
    render(<Conversation items={buildItems(40)} />);

    expect(document.querySelectorAll(".conversation-preview")).toHaveLength(0);
    expect(document.querySelectorAll(".message")).toHaveLength(40);
    expect(screen.getByText("Message number 0 with some body text.")).not.toBeNull();
    expect(screen.getByText("Message number 39 with some body text.")).not.toBeNull();
  });

  test("renders older items as single-line previews and the newest window in full", () => {
    render(<Conversation items={buildItems(60)} />);

    expect(document.querySelectorAll(".conversation-preview")).toHaveLength(20);
    expect(document.querySelectorAll(".message")).toHaveLength(40);
    expect(document.querySelector(".conversation-preview")?.textContent)
      .toContain("Message number 0 with some body text.");
    expect(screen.getByText("Message number 59 with some body text.")).not.toBeNull();
  });

  test("expands a preview on click and renders the full message", async () => {
    render(<Conversation items={buildItems(60)} />);
    const user = userEvent.setup();

    const previews = document.querySelectorAll<HTMLButtonElement>(".conversation-preview");
    expect(previews.length).toBe(20);
    const first = previews[0]!;
    expect(first.textContent).toContain("Message number 0 with some body text.");

    await user.click(first);

    expect(document.querySelectorAll(".conversation-preview")).toHaveLength(19);
    expect(screen.getByText("Message number 0 with some body text.")).not.toBeNull();
  });

  test("previews show the first line of long messages only", () => {
    const items = [
      message("long-0", "First line of a long message\nsecond line\nthird line"),
      ...buildItems(40),
    ];
    render(<Conversation items={items} />);

    const preview = document.querySelector(".conversation-preview");
    expect(preview?.textContent).toContain("First line of a long message");
    expect(preview?.textContent).not.toContain("second line");
  });
});
