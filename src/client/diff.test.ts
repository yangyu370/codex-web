import { describe, expect, test } from "bun:test";

import { parseUnifiedDiff } from "./diff";

describe("parseUnifiedDiff", () => {
  test("parses modified lines with old and new line numbers", () => {
    const source = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@ export const value =",
      "-old",
      "+new",
      " same",
    ].join("\n");

    const parsed = parseUnifiedDiff(source);

    expect(parsed.parsed).toBe(true);
    expect(parsed.raw).toBe(source);
    expect(parsed.files[0]).toMatchObject({
      oldPath: "src/a.ts",
      newPath: "src/a.ts",
      kind: "modify",
      additions: 1,
      deletions: 1,
    });
    expect(parsed.files[0]?.hunks[0]?.lines).toEqual([
      { kind: "delete", text: "old", oldLine: 1 },
      { kind: "add", text: "new", newLine: 1 },
      { kind: "context", text: "same", oldLine: 2, newLine: 2 },
    ]);
  });

  test("parses add, delete, rename, multiple files, and multiple hunks", () => {
    const source = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1 @@",
      "+new",
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-old",
      "diff --git \"a/old name.ts\" \"b/new name.ts\"",
      "similarity index 100%",
      "rename from old name.ts",
      "rename to new name.ts",
      "--- \"a/old name.ts\"",
      "+++ \"b/new name.ts\"",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "@@ -10 +10 @@",
      " context",
    ].join("\n");

    const parsed = parseUnifiedDiff(source);

    expect(parsed.files).toHaveLength(3);
    expect(parsed.files.map((file) => file.kind)).toEqual(["add", "delete", "rename"]);
    expect(parsed.files[2]).toMatchObject({
      oldPath: "old name.ts",
      newPath: "new name.ts",
      additions: 1,
      deletions: 1,
    });
    expect(parsed.files[2]?.hunks).toHaveLength(2);
  });

  test("retains missing-newline markers without advancing line numbers", () => {
    const parsed = parseUnifiedDiff([
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ].join("\n"));

    expect(parsed.files[0]?.hunks[0]?.lines).toEqual([
      { kind: "delete", text: "old", oldLine: 1 },
      { kind: "meta", text: "No newline at end of file" },
      { kind: "add", text: "new", newLine: 1 },
      { kind: "meta", text: "No newline at end of file" },
    ]);
  });

  test.each([
    ["plain text", "not a diff"],
    ["malformed hunk", "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ broken\n+new"],
    ["headers only", "--- a/a\n+++ b/a"],
  ])("returns a raw fallback for %s", (_label, source) => {
    expect(parseUnifiedDiff(source)).toEqual({ files: [], raw: source, parsed: false });
  });

  test("falls back to raw when one file in a multi-file diff is malformed", () => {
    const source = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ malformed @@",
      "+hidden",
    ].join("\n");

    expect(parseUnifiedDiff(source)).toEqual({ files: [], raw: source, parsed: false });
  });
});
