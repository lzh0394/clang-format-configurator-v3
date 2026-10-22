import { expect, test } from "@playwright/test";

// M0 acceptance: the built app loads a version, runs the wasm formatter in a
// worker, and can switch style and version.

test("formats source with the wasm build", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await expect(page.getByTestId("output")).toContainText("class Widget {", { timeout: 30_000 });
  await expect(page.getByTestId("status")).toContainText("189 options");
  expect(errors).toEqual([]);
});

test("switching style reformats with the new preset", async ({ page }) => {
  await page.goto("/");
  const output = page.getByTestId("output");
  await expect(output).toContainText("class Widget {");

  await page.getByLabel("Style").selectOption("GNU");
  await expect(output).toContainText(/class Widget\n\{/);

  await page.getByLabel("Style").selectOption("LLVM");
  await expect(output).toContainText("class Widget {");
});

test("switching version loads that wasm build", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("output")).toContainText("class Widget {");

  await page.getByLabel("Version").selectOption("18.1.8");
  await expect(page.getByTestId("status")).toContainText("163 options");
  await expect(page.getByTestId("status")).toContainText("clang-format version 18.1.8");
  await expect(page.getByTestId("output")).toContainText("class Widget {");
});

test("editing source updates the output", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("output")).toContainText("class Widget {");

  await page.getByTestId("source").fill("int f(int a,int b){return a+b;}\n");
  await expect(page.getByTestId("output")).toContainText("int f(int a, int b) { return a + b; }");
});
