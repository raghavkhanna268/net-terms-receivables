/**
 * Playwright config for Web Vitals performance tests (S23).
 *
 * This config is used for running the perf harness tests only.
 * It's separate from any e2e tests and uses Chromium exclusively.
 */

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  timeout: 120000,
  use: {
    trace: "off",
    screenshot: "off",
    video: "off",
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
