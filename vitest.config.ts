import { defineConfig } from "vitest/config";

// Unit tests only. Playwright drives the browser suite in tests/e2e.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
