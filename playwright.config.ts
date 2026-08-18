import { defineConfig, devices } from "@playwright/test";

const port = process.env.CODEX_WEB_PORT ?? "4173";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.pw.ts",
  timeout: 30_000,
  workers: 1,
  expect: { timeout: 5_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], browserName: "chromium", channel: "chrome" },
    },
  ],
  webServer: {
    command: "bun tests/e2e/start.ts",
    url: `http://127.0.0.1:${port}/api/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
