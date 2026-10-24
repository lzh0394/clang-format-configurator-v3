import { defineConfig } from "@playwright/test";

// PW_BASE_URL points the suite at a deployed site (used by the Pages smoke
// test); otherwise Playwright starts `vite preview` against the local build.
// PW_CHANNEL switches the browser: msedge locally (no download), chromium in CI.
// VITE_BASE is the deployment sub-path; preview is opened under it too.
const externalBaseUrl = process.env.PW_BASE_URL;
const channel = process.env.PW_CHANNEL ?? "msedge";
const localBaseUrl = new URL(process.env.VITE_BASE ?? "/", "http://127.0.0.1:4173").href;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 45_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: externalBaseUrl ?? localBaseUrl,
    trace: "retain-on-failure",
    video: "off",
  },
  // Two projects so the latency budgets never compete with the wasm-heavy rest
  // of the suite for CPU. `perf` depends on the channel project, which makes
  // Playwright run it only after every other test (and therefore mostly alone);
  // with 52 versions the parallel suite was enough to push a 200 ms cached
  // switch over budget on CI even though the same switch alone takes ~80 ms.
  projects: [
    { name: channel, use: channel === "chromium" ? {} : { channel }, testIgnore: ["**/perf.spec.ts"] },
    {
      name: "perf",
      use: channel === "chromium" ? {} : { channel },
      testMatch: ["**/perf.spec.ts"],
      dependencies: [channel],
    },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        // Bind explicitly: on CI `localhost` may resolve to ::1 while the
        // client connects to 127.0.0.1, which makes the wait time out.
        command: "npm run preview -- --port 4173 --strictPort --host 127.0.0.1",
        url: localBaseUrl,
        reuseExistingServer: !process.env.CI,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
      },
});
