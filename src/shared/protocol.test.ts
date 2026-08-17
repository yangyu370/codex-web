import { describe, expect, test } from "bun:test";

import { parseClientMessage } from "./protocol";

describe("parseClientMessage", () => {
  test("accepts a correlated thread list request", () => {
    expect(
      parseClientMessage(
        '{"kind":"request","id":"r1","method":"thread.list","params":{}}',
      ),
    ).toEqual({
      kind: "request",
      id: "r1",
      method: "thread.list",
      params: {},
    });
  });

  test("rejects unknown envelope kinds", () => {
    expect(() => parseClientMessage('{"kind":"raw-app-server"}')).toThrow(
      "invalidRequest",
    );
  });

  test("rejects messages larger than 64 KiB before parsing JSON", () => {
    expect(() => parseClientMessage("{".repeat(65_537))).toThrow(
      "invalidRequest: message exceeds 65536 bytes",
    );
  });
});
