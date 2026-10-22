import { defineConfig } from "@playwright/test";

// PW_BASE_URL points the suite at a deployed site (used by the Pages smoke
// test); otherwise Playwright starts `vite preview` against the local build.
// PW_CHANNEL switches the browser: msedge locally (no download), chromium in CI.
const externalBaseUrl = process.env.PW_BASE_URL;
const channel = process.env.PW_CHANNEL ?? "msedge";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 45_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: externalBaseUrl ?? "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [{ name: channel, use: channel === "chromium" ? {} : { channel } }],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: "npm run preview -- --port 4173 --strictPort",
        url: "http://127.0.0.1:4173",
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
