import { expect, test } from "@playwright/test";

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
