import { expect, test } from "@playwright/test";

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
