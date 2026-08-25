import { expect, test } from "bun:test";

import { parseLifecycleArguments } from "./app-server-lifecycle";

test("parses public lifecycle commands without accepting extra arguments", () => {
  expect(parseLifecycleArguments(["start"])).toEqual({ command: "start" });
  expect(parseLifecycleArguments(["restart"])).toEqual({ command: "restart" });
  expect(() => parseLifecycleArguments(["status", "extra"])).toThrow("unexpected argument");
});

test("parses exact internal host identity arguments", () => {
  expect(parseLifecycleArguments([
    "host",
    "--endpoint", "ws://127.0.0.1:4500",
    "--codex-home", "C:\\Users\\dev\\.codex",
    "--executable", "C:\\Tools\\codex.exe",
    "--generation", "generation-1",
    "--data-directory", "C:\\Data\\Codex Web",
  ])).toEqual({
    command: "host",
    endpoint: "ws://127.0.0.1:4500",
    codexHome: "C:\\Users\\dev\\.codex",
    executable: "C:\\Tools\\codex.exe",
    generation: "generation-1",
    dataDirectory: "C:\\Data\\Codex Web",
  });
});
