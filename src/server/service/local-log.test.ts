import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { LocalEventLog } from "./local-log";

describe("LocalEventLog", () => {
  test("persists bounded redacted diagnostics and approval audit entries", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codex-web-log-"));
    try {
      const log = new LocalEventLog(directory, ["secret-token"]);
      log.append("diagnostic", { diagnosticId: "d1", message: "failed secret-token" });
      log.append("approval", { approvalId: "a1", decision: "accept" });
      await log.flush();

      const contents = await readFile(path.join(directory, "events.jsonl"), "utf8");
      expect(contents).toContain("d1");
      expect(contents).toContain("a1");
      expect(contents).toContain("[REDACTED]");
      expect(contents).not.toContain("secret-token");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
