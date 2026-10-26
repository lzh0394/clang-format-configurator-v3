import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import {
  expectEditorText,
  expectEditorTextContains,
  expectEditorTextToMatch,
  openApp,
  openSettings,
  readEditorText,
  setEditorText,
} from "./helpers";

// M2 acceptance (plan §9): CodeMirror editors, true split diff, structured
// error panel, config drawer and the keyboard/font/language controls.
//
// Everything goes through the page (no disk state); output text is read through
// the CodeMirror helpers because each logical line is its own `.cm-line` div.
// In diff mode the normal panes unmount, so `getByTestId("source"/"output")`
// still resolves to exactly one element on the page.

const CONFIG_YAML = "config-yaml";

async function openDrawer(page: Page): Promise<void> {
  await page.getByTestId("open-config").click();
  await expect(page.getByTestId("config-drawer")).toBeVisible();
  await expect(page.getByTestId(CONFIG_YAML)).toBeVisible();
}

/** Open the M1 export dialog, read the minimal YAML and close it again. */
async function readMinimalExport(page: Page): Promise<string> {
  await page.getByTestId("open-export").click();
  const yaml = page.getByTestId(CONFIG_YAML);
  await expect(yaml).toBeVisible();
  const text = await yaml.inputValue();
  await page.getByTestId("dialog-close").click();
  await expect(page.getByTestId("config-dialog")).toBeHidden();
  return text;
}

/**
 * Click the drawer's Download button and return the serialized YAML it wrote.
 *
 * CodeMirror only renders the lines in its viewport, so the rendered `.cm-line`
 * text is not the whole document for large YAML (and how many lines fit depends
 * on the interface size tier). The download is the deterministic full copy.
 */
async function readDownloadedConfig(page: Page): Promise<string> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("config-download").click();
  const download = await downloadPromise;
  const path = await download.path();
  if (path === null) throw new Error("config download did not produce a file");
  return readFile(path, "utf8");
}

// ---------------------------------------------------------------------------
// Editors: source editable, formatted output read-only
// ---------------------------------------------------------------------------

test("source is editable while the formatted output is read-only", async ({ page }) => {
  await openApp(page);
  const source = page.getByTestId("source");
  const output = page.getByTestId("output");

  await expect(source).toHaveAttribute("contenteditable", "true");
  await expect(source).toHaveAttribute("aria-readonly", "false");
  await expect(output).toHaveAttribute("contenteditable", "false");
  await expect(output).toHaveAttribute("aria-readonly", "true");

  // Typing into the read-only pane must not change it.
  const before = await readEditorText(page, "output");
  await output.click();
  await page.keyboard.type("XYZ");
  expect(await readEditorText(page, "output")).toBe(before);

  // The source pane accepts edits and they are formatted.
  await setEditorText(page, "source", "int main(){return 0;}\n");
  await expectEditorTextContains(page, "output", "int main() { return 0; }");
});

// ---------------------------------------------------------------------------
// Keyboard: Ctrl/Cmd+Enter formats even with Auto off
// ---------------------------------------------------------------------------

test("Ctrl/Cmd+Enter formats immediately when Auto is off", async ({ page }) => {
  await openApp(page);
  await page.getByRole("checkbox", { name: "Auto" }).uncheck();

  const before = await readEditorText(page, "output");
  await setEditorText(page, "source", "int f(int a,int b){return a+b;}\n");
  // Auto is off: the debounced formatter must not run on its own.
  await page.waitForTimeout(600);
  expect(await readEditorText(page, "output")).toBe(before);

  await page.keyboard.press("ControlOrMeta+Enter");
  await expectEditorTextContains(page, "output", "int f(int a, int b) { return a + b; }");
});

// ---------------------------------------------------------------------------
// Language badge derived from the filename
// ---------------------------------------------------------------------------

test("language badge follows the filename", async ({ page }) => {
  await openApp(page);
  const badge = page.getByTestId("language");
  const filename = page.getByLabel("Filename");

  const cases = [
    ["main.cc", "C/C++"],
    ["Main.java", "Java"],
    ["Program.cs", "C#"],
    ["service.proto", "Protobuf"],
    [".clang-format", "YAML"],
    ["README", "Plain text"],
  ] as const;

  for (const [name, label] of cases) {
    await filename.fill(name);
    await expect(badge).toHaveText(label);
  }
});

// ---------------------------------------------------------------------------
// Editor font size
// ---------------------------------------------------------------------------

test("editor font-size select changes the editor font size", async ({ page }) => {
  await openApp(page);
  const source = page.getByTestId("source");
  const sourceFontSize = () => source.evaluate((element) => getComputedStyle(element).fontSize);

  expect(await sourceFontSize()).toBe("13px");
  // M3 moved the font-size select into the header settings popover.
  await openSettings(page);
  await page.getByTestId("editor-font-size").selectOption("18");
  await expect.poll(sourceFontSize).toBe("18px");
  const outputFontSize = await page
    .getByTestId("output")
    .evaluate((element) => getComputedStyle(element).fontSize);
  expect(outputFontSize).toBe("18px");

  await page.getByTestId("editor-font-size").selectOption("12");
  await expect.poll(sourceFontSize).toBe("12px");
});

// ---------------------------------------------------------------------------
// True split diff (@codemirror/merge)
// ---------------------------------------------------------------------------

test("diff toggle renders a split merge view with changed lines", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("diff-toggle").check();

  const diffView = page.getByTestId("diff-view");
  await expect(diffView).toBeVisible();
  // The normal panes unmount: exactly one source/output, both inside the diff.
  await expect(diffView.getByTestId("source")).toHaveCount(1);
  await expect(diffView.getByTestId("output")).toHaveCount(1);
  await expect(page.getByTestId("source")).toHaveCount(1);
  await expect(page.getByTestId("output")).toHaveCount(1);

  // Real line-level diff: the unformatted sample differs from the output and
  // the merge view marks the changed lines/chunks.
  await expect.poll(() => page.locator(".cm-changedLine").count()).toBeGreaterThan(0);
  await expect.poll(() => page.locator(".cm-changedText").count()).toBeGreaterThan(0);

  await expectEditorTextContains(page, "output", "class Widget {");
  await expectEditorTextContains(page, "source", "class Widget{public:");
});

test("editing the left side of the diff reformats the right side", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("diff-toggle").check();
  const diffView = page.getByTestId("diff-view");
  await expect(diffView).toBeVisible();
  await expectEditorTextContains(page, "output", "class Widget {");

  await setEditorText(page, "source", "int  g( int x ){return x*2;}\n");
  await expectEditorTextContains(page, "output", "int g(int x) { return x * 2; }");
  await expect.poll(() => page.locator(".cm-changedLine").count()).toBeGreaterThan(0);

  // Toggling back restores the normal side-by-side panes with the new result.
  await page.getByTestId("diff-toggle").uncheck();
  await expect(diffView).toBeHidden();
  await expect(page.getByTestId("source")).toHaveCount(1);
  await expect(page.getByTestId("output")).toHaveCount(1);
  await expectEditorTextContains(page, "output", "int g(int x) { return x * 2; }");
});

// ---------------------------------------------------------------------------
// Config drawer: live validation, preview, apply, modes, download, close
// ---------------------------------------------------------------------------

test("config drawer validates YAML live and previews the added keys", async ({ page }) => {
  await openApp(page);
  await openDrawer(page);

  // Opening the drawer starts from the current (empty) configuration.
  await expectEditorText(page, CONFIG_YAML, "BasedOnStyle: LLVM\n");

  await setEditorText(page, CONFIG_YAML, "BasedOnStyle: [LLVM");
  const errors = page.getByTestId("config-errors");
  await expect(errors).toBeVisible();
  await expect(errors).toHaveAttribute("role", "alert");
  await expect(errors).toContainText(/line 1/i);

  // Fatal errors keep the drawer open (non-destructive apply).
  await page.getByTestId("config-apply").click();
  await expect(page.getByTestId("config-drawer")).toBeVisible();
  await expect(errors).toBeVisible();

  await setEditorText(page, CONFIG_YAML, "BasedOnStyle: LLVM\nIndentWidth: 7\n");
  await expect(page.getByTestId("config-valid")).toBeVisible();
  await expect(errors).toBeHidden();
  const preview = page.getByTestId("config-preview");
  await expect(preview).toContainText("Added");
  await expect(preview).toContainText("IndentWidth");

  // Recoverable problems are warnings, not fatal errors.
  await setEditorText(page, CONFIG_YAML, "BasedOnStyle: LLVM\nNotARealOption: 1\n");
  const warnings = page.getByTestId("config-warnings");
  await expect(warnings).toBeVisible();
  await expect(warnings).toContainText("NotARealOption");
  await expect(errors).toBeHidden();
});

test("config drawer apply updates the configuration and the output", async ({ page }) => {
  await openApp(page);
  await openDrawer(page);

  await setEditorText(page, CONFIG_YAML, "BasedOnStyle: LLVM\nIndentWidth: 7\n");
  await expect(page.getByTestId("config-valid")).toBeVisible();
  await page.getByTestId("config-apply").click();
  await expect(page.getByTestId("config-drawer")).toBeHidden();

  await expect(page.getByTestId("modified-count")).toContainText("1 modified");
  await expectEditorTextToMatch(page, "output", /^ {7}int id_;$/m);

  const exported = await readMinimalExport(page);
  expect(exported).toContain("BasedOnStyle: LLVM");
  expect(exported).toContain("IndentWidth: 7");
});

test("config drawer mode radios re-serialize the YAML", async ({ page }) => {
  await openApp(page);
  await openDrawer(page);

  await expect(page.getByTestId("config-mode-minimal")).toBeChecked();
  await expectEditorText(page, CONFIG_YAML, "BasedOnStyle: LLVM\n");

  await page.getByTestId("config-mode-full").check();
  await expect(page.getByTestId("config-mode-full")).toBeChecked();
  // Read the downloaded YAML, not the rendered editor: CodeMirror only renders
  // the visible viewport, so the rendered line count depends on font size.
  const full = await readDownloadedConfig(page);
  expect(full.length).toBeGreaterThan(1_000);
  expect(full).toContain("AccessModifierOffset");
  expect(full).toContain("BasedOnStyle: LLVM");

  await page.getByTestId("config-mode-minimal").check();
  await expect(page.getByTestId("config-mode-minimal")).toBeChecked();
  await expectEditorText(page, CONFIG_YAML, "BasedOnStyle: LLVM\n");
});

test("config drawer downloads the edited YAML", async ({ page }) => {
  await openApp(page);
  await openDrawer(page);

  await setEditorText(page, CONFIG_YAML, "BasedOnStyle: Google\nIndentWidth: 5\n");
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("config-download").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain("clang-format");
});

test("config drawer closes via its close button and Escape", async ({ page }) => {
  await openApp(page);
  await openDrawer(page);

  await page.getByTestId("config-close").click();
  await expect(page.getByTestId("config-drawer")).toBeHidden();
  await expect(page.getByTestId("open-config")).toBeFocused();

  await openDrawer(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("config-drawer")).toBeHidden();
  await expect(page.getByTestId("open-config")).toBeFocused();
});

// ---------------------------------------------------------------------------
// Structured error panel: summary + expandable LLVM diagnostics, and recovery
// ---------------------------------------------------------------------------

test("structured error panel shows LLVM diagnostics and formatting recovers", async ({ page }) => {
  await openApp(page);
  await openDrawer(page);

  // A value the schema accepts (integer) but clang-format rejects makes the
  // formatter fail through the normal UI path — no test-only injection needed.
  await setEditorText(page, CONFIG_YAML, "BasedOnStyle: LLVM\nColumnLimit: 1e21\n");
  await page.getByTestId("config-apply").click();
  await expect(page.getByTestId("config-drawer")).toBeHidden();

  const panel = page.getByTestId("error-panel");
  await expect(panel).toBeVisible();
  const summary = page.getByTestId("error-summary");
  await expect(summary).toHaveAttribute("role", "alert");
  await expect(summary).toContainText("Invalid argument");

  const detail = page.getByTestId("error-detail");
  await expect(detail).toBeVisible();
  await detail.locator("summary").click();
  await expect(detail.locator("pre")).toContainText("invalid number");
  await expect(detail.locator("pre")).toContainText("ColumnLimit");

  await page.getByTestId("error-dismiss").click();
  await expect(panel).toBeHidden();

  // Clearing the bad value lets the next format succeed again.
  await openDrawer(page);
  await setEditorText(page, CONFIG_YAML, "BasedOnStyle: LLVM\n");
  await expect(page.getByTestId("config-valid")).toBeVisible();
  await page.getByTestId("config-apply").click();
  await expect(page.getByTestId("config-drawer")).toBeHidden();
  await expect(page.getByTestId("error-panel")).toBeHidden();
  await expectEditorTextContains(page, "output", "class Widget {");
});
