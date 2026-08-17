import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.pw.ts",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://127.0.0.1:4173",
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
    url: "http://127.0.0.1:4173/api/healthz",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
