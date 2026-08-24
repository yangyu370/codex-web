import { expect, test, type Page } from "@playwright/test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function selectReasoningEffort(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Reasoning effort" }).click();
  const dialog = page.getByRole("dialog", { name: "Reasoning effort" });
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name: "High", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function selectWorkspacePermissions(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Permissions" }).click();
  const dialog = page.getByRole("dialog", { name: "How should Codex run?" });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) throw new Error("Permission menu geometry was unavailable");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  await page.getByRole("button", { name: "Approve when needed" }).click();
}

test("keeps a large permissions catalog reachable inside a short viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Short desktop viewport regression");
  await page.setViewportSize({ width: 720, height: 360 });
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "Permissions" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "How should Codex run?" });
  await expect(dialog).toBeVisible();

  const longUnknownId = `:unknown-${"x".repeat(220)}`;
  const lastOption = dialog.getByRole("button", { name: longUnknownId });
  await lastOption.scrollIntoViewIfNeeded();
  await expect(lastOption).toBeVisible();

  const geometry = await dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const lastBox = element.querySelector(".composer-menu__option:last-child")?.getBoundingClientRect();
    return {
      bottom: box.bottom,
      clientHeight: element.clientHeight,
      lastBottom: lastBox?.bottom,
      lastTop: lastBox?.top,
      overflowY: getComputedStyle(element).overflowY,
      scrollHeight: element.scrollHeight,
      top: box.top,
    };
  });
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(360);
  expect(geometry.overflowY).toBe("auto");
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  expect(geometry.lastTop).toBeGreaterThanOrEqual(geometry.top);
  expect(geometry.lastBottom).toBeLessThanOrEqual(geometry.bottom);

  await lastOption.click();
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toHaveAccessibleDescription(longUnknownId);
});

test("keeps the composer in the initial viewport with a long task history", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Desktop grid regression");
  await page.goto("/");

  await expect(page.getByRole("textbox", { name: "Message Codex" })).toBeInViewport();
});

test("keeps the full shell visible at an intermediate desktop width", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Intermediate desktop regression");
  await page.setViewportSize({ width: 950, height: 720 });
  await page.goto("/");

  await expect(page.getByRole("navigation", { name: "Workspace sections" })).toBeVisible();
  const tabs = await page.getByRole("navigation", { name: "Workspace sections" }).boundingBox();
  const sidebar = await page.getByRole("navigation", { name: "Tasks" }).boundingBox();
  expect(tabs).not.toBeNull();
  expect(sidebar).not.toBeNull();
  expect(tabs?.x).toBe(sidebar?.width);
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);
});

test("uses the full compact width for task context and navigation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Compact-width regression");
  await page.setViewportSize({ width: 768, height: 820 });
  await page.goto("/");

  const tabs = await page.getByRole("navigation", { name: "Workspace sections" }).boundingBox();
  const context = await page.getByRole("group", { name: "Task context" }).boundingBox();
  const cwd = await page.getByRole("combobox", { name: "Working directory" }).boundingBox();
  expect(tabs).not.toBeNull();
  expect(tabs?.x).toBe(0);
  expect((tabs?.x ?? 0) + (tabs?.width ?? 0)).toBeLessThanOrEqual(768);
  expect(context).not.toBeNull();
  expect(cwd).not.toBeNull();
  expect(cwd?.width ?? 0).toBeGreaterThan((context?.width ?? 0) * 0.6);
});

test("selects a working directory from the Codex host", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Browse server directories" }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a server directory" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("This path belongs to the machine running Codex.")).toBeVisible();
  await dialog.getByRole("button", { name: "Use this folder" }).click();

  await expect(page.getByRole("combobox", { name: "Working directory" })).not.toHaveValue("");
});

test("daily Codex workflow", async ({ page }, testInfo) => {
  await page.goto("/");
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "Tasks" }).click();
  }
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByRole("combobox", { name: "Working directory" }).fill(process.cwd());
  await page.getByRole("textbox", { name: "Message Codex" }).fill("Create a file");
  await page.getByRole("button", { name: "Send" }).click();
  if (testInfo.project.name !== "desktop") {
    await page.getByRole("button", { name: "Activity" }).click();
  }
  await expect(page.getByText("Approve file changes")).toBeVisible();
  // The local fake resolves synchronously and removes the approval card in the same event turn.
  await page.getByRole("button", { name: "Approve" }).dispatchEvent("click");
  await expect(page.getByLabel("Activity").getByText("Turn completed")).toBeVisible();
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);
  await testInfo.attach(`daily-workflow-${testInfo.project.name}`, {
    body: await page.screenshot({ animations: "disabled", fullPage: true }),
    contentType: "image/png",
  });
});

test("continues a CLI-first task from Web and can interrupt the turn", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Shared CLI handoff regression");
  await page.goto("/");

  await page.getByRole("button", { name: /Shared CLI task/ }).click();
  await expect(page.getByText("CLI and Web are connected")).toBeVisible();
  const message = page.getByRole("textbox", { name: "Message Codex" });
  await expect(message).toBeEnabled();
  await message.fill("Continue from Web");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Approve file changes")).toBeVisible();

  await page.getByRole("button", { name: "Stop" }).first().click();
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
});

test("monitors an ordinary CLI task read-only and retries read-write after release", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Private writer monitoring regression");
  await page.goto("/");
  const task = page.getByRole("button", { name: /Private CLI task/ });

  await task.click();
  await expect(page.getByText("READ ONLY · LOCAL CLI")).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "This CLI task was not started in shared mode",
  );
  await expect(page.getByRole("textbox", { name: "Message Codex" })).toBeDisabled();
  await expect(page.getByRole("article").getByText("Private CLI update 2")).toBeVisible({ timeout: 5_000 });

  await task.click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message Codex" })).toBeEnabled();
});

test("uploads server-side context and removes it after the turn", async ({ page }, testInfo) => {
  const project = await mkdtemp(join(tmpdir(), "codex-web-upload-e2e-"));
  try {
    await page.goto("/");
    if (testInfo.project.name === "mobile") {
      await page.getByRole("button", { name: "Tasks" }).click();
    }
    await page.getByRole("button", { name: "New task" }).click();
    await page.getByRole("combobox", { name: "Working directory" }).fill(project);
    await page.getByLabel("Choose attachment files").setInputFiles([
      {
        name: "notes.ts",
        mimeType: "text/plain",
        buffer: Buffer.from("export const ok = true;\n"),
      },
      {
        name: "pixel.png",
        mimeType: "image/png",
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
    ]);
    await expect(page.getByText("notes.ts")).toBeVisible();
    await expect(page.getByText("pixel.png")).toBeVisible();
    await expect(page.getByText(/Ready/)).toHaveCount(2);
    await page.getByRole("button", { name: "Send" }).click();
    if (testInfo.project.name !== "desktop") {
      await page.getByRole("button", { name: "Activity" }).click();
    }
    await expect(page.getByText("Approve file changes")).toBeVisible();
    await page.getByRole("button", { name: "Approve" }).dispatchEvent("click");
    await expect(page.getByLabel("Activity").getByText("Turn completed")).toBeVisible();
    await expect.poll(async () => {
      try {
        await access(join(project, ".codex-web", "attachments"));
        return true;
      } catch {
        return false;
      }
    }).toBe(false);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("changes task controls and reviews a structured diff inline", async ({ page }, testInfo) => {
  await page.goto("/");
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "Tasks" }).click();
  }
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByRole("combobox", { name: "Working directory" }).fill(process.cwd());
  await selectReasoningEffort(page);
  await selectWorkspacePermissions(page);
  await page.getByRole("textbox", { name: "Message Codex" }).fill("Create a file to review");
  await page.getByRole("button", { name: "Send" }).click();

  if (testInfo.project.name !== "desktop") {
    await page.getByRole("button", { name: "Activity" }).click();
  }
  await expect(page.getByText("Approve file changes")).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).dispatchEvent("click");
  await expect(page.getByLabel("Activity").getByText("Turn completed")).toBeVisible();

  if (testInfo.project.name !== "desktop") {
    await page.getByRole("button", { name: "Chat" }).click();
  }
  await selectReasoningEffort(page);
  await selectWorkspacePermissions(page);
  await page.getByRole("button", { name: "Review changes" }).click();

  const changes = page.getByLabel("Changes");
  await expect(changes.getByRole("button", { name: /src\/hello\.ts/ })).toBeVisible();
  await expect(changes.getByText('export const greeting = "hello from web";')).toBeVisible();
  await expect(changes.getByText("2").first()).toBeVisible();
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);
});
