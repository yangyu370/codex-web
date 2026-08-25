import { describe, expect, test } from "bun:test";

import {
  buildRemoteCliArguments,
  validateRemoteCliArguments,
} from "./app-server-lifecycle";

describe("Windows shared CLI argument forwarding", () => {
  test.each([
    ["--remote", "ws://127.0.0.1:9999"],
    ["--remote=ws://127.0.0.1:9999"],
    ["--remote-auth-token-env", "TOKEN"],
    ["--remote-auth-token-env=TOKEN"],
  ])("rejects caller-controlled remote flags", (...args) => {
    expect(() => validateRemoteCliArguments(args)).toThrow("managed remote endpoint");
  });

  test("preserves spaces, Unicode, quotes, and argument terminator", () => {
    const forwarded = ["-C", "C:\\项目\\demo app", "--", "say \"hello\""];

    expect(buildRemoteCliArguments("ws://127.0.0.1:4500", forwarded)).toEqual([
      "--remote",
      "ws://127.0.0.1:4500",
      ...forwarded,
    ]);
  });
});
