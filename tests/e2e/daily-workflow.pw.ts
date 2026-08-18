import { expect, test } from "@playwright/test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("keeps the composer in the initial viewport with a long task history", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Desktop grid regression");
  await page.goto("/");

  await expect(page.getByRole("textbox", { name: "Message Codex" })).toBeInViewport();
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
  if (testInfo.project.name === "mobile") {
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
    if (testInfo.project.name === "mobile") {
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
