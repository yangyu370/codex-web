import { beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";

import { ThreadSidebar } from "./ThreadSidebar";
import type { ThreadSummary } from "../../shared/protocol";

beforeEach(cleanup);

const service = { status: "ready" as const, platform: "macos" as const, liveHandoff: "unavailable" as const };

function thread(overrides: Partial<ThreadSummary> & Pick<ThreadSummary, "id" | "title" | "updatedAt">): ThreadSummary {
  return {
    preview: "",
    createdAt: overrides.updatedAt,
    cwd: undefined,
    ...overrides,
  } as ThreadSummary;
}

function groups(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".thread-directory"));
}

describe("ThreadSidebar directory grouping", () => {
  test("groups recent tasks by working directory with basename labels and counts", () => {
    render(
      <ThreadSidebar
        connection="connected"
        onNewTask={() => undefined}
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        query=""
        service={service}
        threads={[
          thread({ id: "a", title: "Fix parser", updatedAt: 300, cwd: "/Users/dev/codex-web" }),
          thread({ id: "b", title: "Add tests", updatedAt: 200, cwd: "/Users/dev/codex-web" }),
          thread({ id: "c", title: "Tune daemon", updatedAt: 100, cwd: "/Users/dev/codex-app" }),
          thread({ id: "d", title: "Scratch notes", updatedAt: 50 }),
        ]}
      />,
    );

    const directories = groups();
    expect(directories.map((group) => group.querySelector(".thread-directory__name")?.textContent))
      .toEqual(["codex-web", "codex-app", "No directory"]);
    expect(directories[0]?.querySelectorAll(".thread-row")).toHaveLength(2);
    expect(directories[0]?.querySelector(".thread-directory__count")?.textContent).toBe("2");
    expect(directories[0]?.querySelector(".thread-directory__header")?.getAttribute("title"))
      .toBe("/Users/dev/codex-web");
    expect(directories[1]?.querySelectorAll(".thread-row")).toHaveLength(1);
    expect(directories[2]?.querySelector(".thread-directory__header")?.getAttribute("title")).toBeNull();
  });

  test("sorts directories by latest activity and keeps rows newest-first inside each group", () => {
    render(
      <ThreadSidebar
        connection="connected"
        onNewTask={() => undefined}
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        query=""
        service={service}
        threads={[
          thread({ id: "old-project", title: "Older project task", updatedAt: 10, cwd: "/work/first" }),
          thread({ id: "newer-in-old", title: "Newer in quiet project", updatedAt: 40, cwd: "/work/first" }),
          thread({ id: "busy-latest", title: "Busy project latest", updatedAt: 900, cwd: "/work/second" }),
          thread({ id: "busy-older", title: "Busy project older", updatedAt: 500, cwd: "/work/second" }),
        ]}
      />,
    );

    const directories = groups();
    expect(directories.map((group) => group.querySelector(".thread-directory__name")?.textContent))
      .toEqual(["second", "first"]);
    const titles = Array.from(directories[0]!.querySelectorAll(".thread-row__title"))
      .map((element) => element.textContent);
    expect(titles).toEqual(["Busy project latest", "Busy project older"]);
  });

  test("handles Windows-style paths and trailing separators", () => {
    render(
      <ThreadSidebar
        connection="connected"
        onNewTask={() => undefined}
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        query=""
        service={{ ...service, platform: "windows" }}
        threads={[
          thread({ id: "win", title: "Windows task", updatedAt: 5, cwd: "C:\\Users\\dev\\codex-web\\" }),
        ]}
      />,
    );

    expect(groups()[0]?.querySelector(".thread-directory__name")?.textContent).toBe("codex-web");
  });

  test("keeps live CLI tasks in the global Running group instead of directory groups", () => {
    render(
      <ThreadSidebar
        connection="connected"
        onNewTask={() => undefined}
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        query=""
        service={{ ...service, liveHandoff: "available" }}
        threadAccess={{ threadId: "cli-live", mode: "readWrite" }}
        threads={[
          thread({
            id: "cli-live",
            title: "Live CLI task",
            updatedAt: 900,
            cwd: "/work/second",
            source: "cli",
            canAcceptDirectInput: true,
            status: "idle",
          }),
          thread({ id: "recent", title: "Recent task", updatedAt: 100, cwd: "/work/first" }),
        ]}
      />,
    );

    const running = screen.getByRole("region", { name: "Running" });
    expect(running.querySelectorAll(".thread-row")).toHaveLength(1);
    expect(groups()).toHaveLength(1);
    expect(groups()[0]?.querySelector(".thread-directory__name")?.textContent).toBe("first");
    expect(screen.getByText("LIVE · CLI")).not.toBeNull();
    expect(screen.getByText("Shared Codex")).not.toBeNull();
  });

  test("labels the selected private CLI thread read-only without treating it as running", () => {
    render(
      <ThreadSidebar
        connection="connected"
        onNewTask={() => undefined}
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        query=""
        selectedId="cli-local"
        service={{ ...service, platform: "windows", liveHandoff: "available" }}
        threadAccess={{ threadId: "cli-local", mode: "historyOnly", reason: "activeWriter" }}
        threads={[thread({
          id: "cli-local",
          title: "Local CLI task",
          updatedAt: 900,
          cwd: "C:\\work",
          source: "cli",
          canAcceptDirectInput: true,
          status: "idle",
        })]}
      />,
    );

    expect(screen.queryByRole("region", { name: "Running" })).toBeNull();
    expect(screen.getByText("READ ONLY · LOCAL CLI")).not.toBeNull();
    expect(screen.getByText("Shared Codex")).not.toBeNull();
  });

  test("keeps the grouping while searching and hides empty directories", async () => {
    function SearchHarness() {
      const [query, setQuery] = useState("");
      return <ThreadSidebar
        connection="connected"
        onNewTask={() => undefined}
        onQueryChange={setQuery}
        onSelect={() => undefined}
        query={query}
        service={service}
        threads={[
          thread({ id: "a", title: "Fix parser", updatedAt: 300, cwd: "/work/codex-web", preview: "parser bug" }),
          thread({ id: "c", title: "Tune daemon", updatedAt: 100, cwd: "/work/codex-app", preview: "daemon tuning" }),
        ]}
      />;
    }
    render(<SearchHarness />);
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox", { name: "Search tasks" }), "parser");

    expect(groups().map((group) => group.querySelector(".thread-directory__name")?.textContent))
      .toEqual(["codex-web"]);
    expect(screen.getByText("Fix parser")).not.toBeNull();
    expect(screen.queryByText("Tune daemon")).toBeNull();
  });

  test("collapses and expands a directory group from its header", async () => {
    render(
      <ThreadSidebar
        connection="connected"
        onNewTask={() => undefined}
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        query=""
        service={service}
        threads={[thread({ id: "a", title: "Fix parser", updatedAt: 300, cwd: "/work/codex-web" })]}
      />,
    );
    const user = userEvent.setup();
    const header = groups()[0]!.querySelector("summary")!;

    await user.click(header);
    expect((groups()[0] as HTMLDetailsElement).open).toBe(false);
    await user.click(header);
    expect((groups()[0] as HTMLDetailsElement).open).toBe(true);
  });
});
