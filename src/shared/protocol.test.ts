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

  test("accepts a server-directory listing request", () => {
    expect(
      parseClientMessage(
        '{"kind":"request","id":"r2","method":"directory.list","params":{"path":"/srv/projects"}}',
      ),
    ).toEqual({
      kind: "request",
      id: "r2",
      method: "directory.list",
      params: { path: "/srv/projects" },
    });
  });

  test("accepts task settings, permission catalog, and review requests", () => {
    expect(
      parseClientMessage(
        '{"kind":"request","id":"r3","method":"permissionProfile.list","params":{}}',
      ),
    ).toEqual({
      kind: "request",
      id: "r3",
      method: "permissionProfile.list",
      params: {},
    });
    expect(
      parseClientMessage(
        '{"kind":"request","id":"r4","method":"thread.settings.update","params":{"threadId":"thread-1","effort":"high","permissionProfile":":workspace"}}',
      ),
    ).toEqual({
      kind: "request",
      id: "r4",
      method: "thread.settings.update",
      params: {
        threadId: "thread-1",
        effort: "high",
        permissionProfile: ":workspace",
      },
    });
    expect(
      parseClientMessage(
        '{"kind":"request","id":"r5","method":"review.start","params":{"threadId":"thread-1"}}',
      ),
    ).toEqual({
      kind: "request",
      id: "r5",
      method: "review.start",
      params: { threadId: "thread-1" },
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
