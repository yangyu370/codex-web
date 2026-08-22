import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "bun:test";

import { ChangesPanel } from "./ChangesPanel";

beforeEach(cleanup);

const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-const value = 1;
+const value = 2;
 keep();
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -8,0 +9,1 @@
+export const ready = true;`;

describe("ChangesPanel", () => {
  test("lists changed files and presents structured line numbers", () => {
    render(<ChangesPanel turnDiff={{ threadId: "t1", turnId: "turn1", diff }} items={[]} />);

    expect(screen.getByRole("button", { name: /src\/a\.ts/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /src\/b\.ts/ }));
    expect(screen.getByText("export const ready = true;")).not.toBeNull();
    expect(screen.getByText("9")).not.toBeNull();
    expect(screen.getByLabelText("1 addition, 0 deletions")).not.toBeNull();
  });

  test("falls back to the original text when a diff is malformed", () => {
    render(<ChangesPanel turnDiff={{ threadId: "t1", turnId: "turn1", diff: "not a unified diff" }} items={[]} />);
    expect(screen.getByText("not a unified diff")).not.toBeNull();
  });

  test("explains empty, running, failed, and truncated change states", () => {
    const { rerender } = render(<ChangesPanel items={[]} />);
    expect(screen.getByText("No changes to inspect")).not.toBeNull();

    rerender(<ChangesPanel items={[{ id: "f1", type: "fileChange", path: "a.ts", status: "running" }]} />);
    expect(screen.getByText("Changes are still being collected")).not.toBeNull();

    rerender(<ChangesPanel items={[{ id: "f2", type: "fileChange", path: "a.ts", status: "failed" }]} />);
    expect(screen.getByText("The file change could not be loaded")).not.toBeNull();

    rerender(<ChangesPanel turnDiff={{ threadId: "t1", turnId: "turn1", diff, truncated: true }} items={[]} />);
    expect(screen.getByText("Diff truncated")).not.toBeNull();
  });
});
