import { expect, test } from "@playwright/test";

import {
  expectEditorTextContains,
  expectEditorTextToMatch,
  openApp,
  setEditorText,
} from "./helpers";

// M0 acceptance: the built app loads a version, runs the wasm formatter in a
// worker, and can switch style and version.
//
// Output text is read through the CodeMirror helpers: the editors render one
// div per line, so DOM `textContent` has no newlines (M2).
//
// `./` (not `/`) is deliberate: it keeps the deployment sub-path from baseURL,
// so the same suite covers `/` locally and `/<repo>/` on GitHub Pages.

test("formats source with the wasm build", async ({ page }) => {
  const errors: string[] = [];
  const failed: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);
  });

  await openApp(page);
  await expect(page.getByTestId("status")).toContainText("189 options");
  expect(errors).toEqual([]);
  expect(failed).toEqual([]);
});

test("switching style reformats with the new preset", async ({ page }) => {
  await openApp(page);

  await page.getByLabel("Style").selectOption("GNU");
  await expectEditorTextToMatch(page, "output", /class Widget\n\{/);

  await page.getByLabel("Style").selectOption("LLVM");
  await expectEditorTextContains(page, "output", "class Widget {");
});

test("switching version loads that wasm build", async ({ page }) => {
  await openApp(page);

  await page.getByLabel("Version").selectOption("18.1.8");
  await expect(page.getByTestId("status")).toContainText("163 options");
  await expect(page.getByTestId("status")).toContainText("clang-format 18.1.8");
  await expectEditorTextContains(page, "output", "class Widget {");
});

test("editing source updates the output", async ({ page }) => {
  await openApp(page);

  await setEditorText(page, "source", "int f(int a,int b){return a+b;}\n");
  await expectEditorTextContains(page, "output", "int f(int a, int b) { return a + b; }");
});
