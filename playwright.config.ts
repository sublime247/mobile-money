import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const repoRoot = __dirname;

export default defineConfig({
  testDir: path.join(repoRoot, "tests", "e2e"),
  outputDir: path.join(repoRoot, "test-results", "e2e"),
  timeout: 30_000,
  expect: {
    timeout: 5000,
  },
  fullyParallel: true,
  reporter: [
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder: path.join(repoRoot, "playwright-report"),
      },
    ],
  ],
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:3000",
        headless: true,
        ignoreHTTPSErrors: true,
      },
    },
  ],
  use: {
    actionTimeout: 0,
    trace: "retain-on-failure",
  },
});
