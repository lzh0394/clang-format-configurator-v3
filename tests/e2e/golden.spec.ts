import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { openApp } from "./helpers";

// wasm-vs-native gate (plan §1, §8): every fixture in tests/golden/golden-21.1.8.json
// carries the byte output of **native** clang-format 21.1.8 for the same
// code/filename/style. Feed the identical inputs to the wasm build in the page
// and compare EXACT bytes — no trimming, no line-ending normalization (the
// fixtures intentionally cover CRLF, tabs, trailing spaces, empty input and
// missing trailing newlines). The expectations are generated, never hand-edited
// (tools/gen-golden.mjs), so a mismatch here means wasm drifted from native.

type GoldenFixture = {
  name: string;
  filename: string;
  style: Record<string, unknown>;
  code: string;
  expected: string;
};

type GoldenDocument = {
  clangFormatVersion: string;
  fixtures: GoldenFixture[];
};

/** tests/golden/... resolved from the Playwright working directory (repo root). */
const GOLDEN_PATH = path.join(process.cwd(), "tests", "golden", "golden-21.1.8.json");

function loadGolden(): GoldenDocument {
  return JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenDocument;
}

test("wasm 21.1.8 matches the native golden fixtures byte for byte", async ({ page }) => {
  test.setTimeout(120_000);

  const golden = loadGolden();
  expect(golden.clangFormatVersion).toBe("21.1.8");
  // plan §1 requires at least 24 fixture groups; the committed set has 29.
  expect(golden.fixtures.length).toBeGreaterThanOrEqual(24);
  expect(golden.fixtures.length).toBe(29);

  // Serve the page first: the wasm entry and its .wasm sibling are relative to
  // the app's base path (including the GitHub Pages sub-path).
  await openApp(page);

  const inputs = golden.fixtures.map(({ name, filename, style, code }) => ({ name, filename, style, code }));
  const result = await page.evaluate(async (fixtures) => {
    type WasmModule = {
      default: () => Promise<unknown>;
      format: (content: string, filename?: string, style?: string) => string;
      version?: () => string;
    };
    const url = new URL("wasm/21.1.8/entry.js", document.baseURI).href;
    const module = (await import(url)) as WasmModule;
    await module.default();
    return {
      version: module.version?.() ?? "",
      outputs: fixtures.map((fixture) => ({
        name: fixture.name,
        actual: module.format(fixture.code, fixture.filename, JSON.stringify(fixture.style)),
      })),
    };
  }, inputs);

  expect(result.version).toContain("21.1.8");
  expect(result.outputs.length).toBe(golden.fixtures.length);

  const actualByName = new Map(result.outputs.map((output) => [output.name, output.actual]));
  for (const fixture of golden.fixtures) {
    expect(actualByName.get(fixture.name), `missing output for fixture "${fixture.name}"`).toBeDefined();
    // Exact string comparison: no trim/normalize anywhere.
    expect(actualByName.get(fixture.name), `fixture ${fixture.name} (${fixture.filename})`).toBe(fixture.expected);
  }
});
