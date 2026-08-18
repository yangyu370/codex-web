import { describe, expect, test } from "bun:test";

import type { BrowserSnapshot } from "../shared/protocol";
import { assertCompatibleSnapshot } from "./bootstrap";

const snapshot: BrowserSnapshot = {
  kind: "snapshot",
  protocolVersion: 2,
  sequence: 0,
  service: { status: "ready", platform: "macos" },
  models: [],
  threads: [],
  visibleItems: [],
  pendingApprovals: [],
};

describe("assertCompatibleSnapshot", () => {
  test("accepts the frontend protocol emitted by the current backend", () => {
    expect(assertCompatibleSnapshot(snapshot)).toEqual(snapshot);
  });

  test("blocks a missing or mismatched backend protocol before WebSocket use", () => {
    expect(() => assertCompatibleSnapshot({ ...snapshot, protocolVersion: 1 })).toThrow(
      "Restart Codex Web to finish the update",
    );
    const { protocolVersion: _removed, ...oldBackendSnapshot } = snapshot;
    expect(() => assertCompatibleSnapshot(oldBackendSnapshot)).toThrow(
      "Restart Codex Web to finish the update",
    );
  });
});
