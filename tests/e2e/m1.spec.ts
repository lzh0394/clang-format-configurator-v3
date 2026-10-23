import { expect, test, type Locator, type Page } from "@playwright/test";
import { parse as parseYaml } from "yaml";

// M1 acceptance (plan §9, contract §5.2): a usable `.clang-format` can be built
// through the UI alone, export -> import -> export is byte-identical, and every
// control type renders correctly.
//
// `page.goto("./")` keeps the deployment sub-path from baseURL, so the same
// suite works locally at `/` and on GitHub Pages at `/<repo>/`. Tests never read
// from disk: all state travels through the page.

const APP_READY_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function openApp(page: Page): Promise<void> {
  await page.goto("./");
  // The wasm formatter must finish once before any UI interaction (contract §5.2).
  await expect(page.getByTestId("output")).toContainText("class Widget {", { timeout: APP_READY_TIMEOUT });
  await expect(page.getByTestId("options-panel")).toBeVisible({ timeout: APP_READY_TIMEOUT });
  await warmDocs(page);
}

/**
 * Docs are fetched lazily on the first search and widen the match set when they
 * arrive. Load them once up front so a later search cannot re-filter and move
 * rows out from under a test while it is interacting with the virtual list.
 */
async function warmDocs(page: Page): Promise<void> {
  const docsResponse = page
    .waitForResponse((response) => response.url().includes("/docs.json") && response.ok(), { timeout: 10_000 })
    .catch(() => null);
  await page.getByTestId("options-search").fill("zzzzzz-not-an-option");
  await docsResponse;
  await page.waitForTimeout(120);
  await page.getByTestId("options-search").fill("");
  await expect(page.getByTestId("options-count")).toContainText("189 / 189");
  await expect(page.getByTestId("option-AccessModifierOffset")).toBeVisible();
}

/**
 * Return a virtualized option row, scrolling the list until the row is mounted.
 * Rows live in a virtualizer, so a filtered row that is out of view may not be
 * in the DOM at all; this walks the scroller instead of blindly expecting.
 */
async function findOptionRow(page: Page, key: string): Promise<Locator> {
  const row = page.getByTestId(`option-${key}`);
  const scroller = page.getByTestId("options-scroll");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if ((await row.count()) > 0) {
      await row.scrollIntoViewIfNeeded();
      return row;
    }
    const advanced = await scroller.evaluate((element) => {
      const view = element as HTMLElement;
      const before = view.scrollTop;
      view.scrollTop = Math.min(view.scrollTop + view.clientHeight * 0.75, view.scrollHeight);
      return view.scrollTop > before;
    });
    if (!advanced) break;
    await page.waitForTimeout(25);
  }
  throw new Error(`row option-${key} was never rendered — the options list could not be searched/scrolled`);
}

/** Type into the search box (the panel debounces it by 120 ms) and find the row. */
async function searchOption(page: Page, key: string): Promise<Locator> {
  const search = page.getByTestId("options-search");
  if ((await search.inputValue()) !== key) {
    await search.fill(key);
    await page.waitForTimeout(180);
  }
  return findOptionRow(page, key);
}

/** Search for a top-level scalar/enum option, type a value and commit it on blur. */
async function fillOption(page: Page, key: string, value: string): Promise<void> {
  await searchOption(page, key);
  const input = page.getByTestId(`value-${key}`);
  await input.scrollIntoViewIfNeeded();
  await input.fill(value);
  await input.press("Tab");
}

/** The status bar's modified counter: text such as `1 modified`. */
async function expectModifiedCount(page: Page, count: number): Promise<void> {
  await expect(page.getByTestId("modified-count")).toContainText(new RegExp(`\\b${count}\\s+modified\\b`, "i"));
}

/** Assert the formatted output indents the class member by exactly `spaces`. */
async function expectIndent(page: Page, spaces: number): Promise<void> {
  const output = page.getByTestId("output");
  await expect
    .poll(async () => (await output.textContent()) ?? "", { timeout: 15_000 })
    .toMatch(new RegExp(`^ {${spaces}}int id_;$`, "m"));
}

function dialogLocator(page: Page): Locator {
  return page.getByTestId("config-dialog");
}

async function openExportDialog(page: Page): Promise<Locator> {
  await page.getByTestId("open-export").click();
  await expect(dialogLocator(page)).toBeVisible();
  const yamlArea = page.getByTestId("config-yaml");
  await expect(yamlArea).toBeVisible();
  return yamlArea;
}

async function readExportYaml(page: Page): Promise<string> {
  const yamlArea = await openExportDialog(page);
  return yamlArea.inputValue();
}

async function closeDialog(page: Page): Promise<void> {
  await page.getByTestId("dialog-close").click();
  await expect(dialogLocator(page)).toBeHidden();
}

async function openImportDialog(page: Page): Promise<Locator> {
  await page.getByTestId("open-import").click();
  await expect(dialogLocator(page)).toBeVisible();
  const textarea = page.getByTestId("import-text");
  await expect(textarea).toBeVisible();
  return textarea;
}

/** Paste `text` into the Import tab and apply it; App closes the dialog on success. */
async function applyImport(page: Page, text: string): Promise<void> {
  const textarea = await openImportDialog(page);
  await textarea.fill(text);
  await page.getByTestId("import-apply").click();
  await expect(dialogLocator(page)).toBeHidden();
}

/** Import warnings are shown by App as a dismissible notice. */
async function closeNoticeIfVisible(page: Page): Promise<void> {
  const notice = page.getByTestId("notice");
  const appeared = await notice
    .waitFor({ state: "visible", timeout: 1_500 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  await page.getByTestId("notice-close").click();
  await expect(notice).toBeHidden();
}

function parseConfigYaml(text: string): Record<string, any> {
  const parsed: unknown = parseYaml(text);
  expect(parsed).not.toBeNull();
  expect(typeof parsed).toBe("object");
  return parsed as Record<string, any>;
}

// ---------------------------------------------------------------------------
// 1. Build a configuration through the UI only
// ---------------------------------------------------------------------------

test("builds a config through the UI only", async ({ page }) => {
  await openApp(page);

  await fillOption(page, "IndentWidth", "4");
  await fillOption(page, "ColumnLimit", "100");
  await expectModifiedCount(page, 2);
  await expectIndent(page, 4);

  const yaml = await readExportYaml(page);
  expect(yaml).toContain("BasedOnStyle: LLVM");
  expect(yaml).toContain("IndentWidth: 4");
  expect(yaml).toContain("ColumnLimit: 100");
});

// ---------------------------------------------------------------------------
// 2. Reset restores the inherited value
// ---------------------------------------------------------------------------

test("reset restores the inherited value", async ({ page }) => {
  await openApp(page);
  await fillOption(page, "IndentWidth", "4");
  await fillOption(page, "ColumnLimit", "100");
  await expectModifiedCount(page, 2);
  await expectIndent(page, 4);

  await searchOption(page, "IndentWidth");
  await page.getByTestId("reset-IndentWidth").click();
  await expectModifiedCount(page, 1);
  await expectIndent(page, 2);

  const yaml = await readExportYaml(page);
  expect(yaml).not.toContain("IndentWidth");
  expect(yaml).toContain("ColumnLimit: 100");
});

// ---------------------------------------------------------------------------
// 3. Minimal export -> import -> export is byte-identical
// ---------------------------------------------------------------------------

test("minimal export survives an import/export roundtrip byte for byte", async ({ page }) => {
  await openApp(page);
  await fillOption(page, "IndentWidth", "4");
  await fillOption(page, "ColumnLimit", "100");
  await expectModifiedCount(page, 2);

  const first = await readExportYaml(page);
  expect(first).toContain("BasedOnStyle: LLVM");
  expect(first).toContain("IndentWidth: 4");
  await closeDialog(page);

  await applyImport(page, first);
  await closeNoticeIfVisible(page);

  const second = await readExportYaml(page);
  expect(second).toBe(first);
});

// ---------------------------------------------------------------------------
// 4. Full mode roundtrip
// ---------------------------------------------------------------------------

test("full export survives an import/export roundtrip byte for byte", async ({ page }) => {
  await openApp(page);

  const yamlArea = await openExportDialog(page);
  await page.getByTestId("export-mode-full").check();
  await expect.poll(async () => (await yamlArea.inputValue()).length).toBeGreaterThan(1_000);
  const first = await yamlArea.inputValue();
  expect(first).toContain("BasedOnStyle: LLVM");
  expect(first).toContain("IndentWidth: 2");
  await closeDialog(page);

  await applyImport(page, first);
  await closeNoticeIfVisible(page);

  await openExportDialog(page);
  await page.getByTestId("export-mode-full").check();
  const second = await page.getByTestId("config-yaml").inputValue();
  expect(second).toBe(first);
});

// ---------------------------------------------------------------------------
// 5. Import validation + legacy conversion
// ---------------------------------------------------------------------------

test("import reports warnings, applies the style and converts legacy forms", async ({ page }) => {
  await openApp(page);
  const text = [
    "BasedOnStyle: GNU",
    "IndentWidth: 8",
    "NotARealOption: 1",
    "AlignConsecutiveMacros: true",
  ].join("\n");
  await applyImport(page, text);

  const notice = page.getByTestId("notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("NotARealOption");
  await expect(notice).toContainText(/legacy/i);
  await page.getByTestId("notice-close").click();
  await expect(notice).toBeHidden();

  await expect(page.getByLabel("Style")).toHaveValue("GNU");

  await searchOption(page, "AlignConsecutiveMacros");
  await page.getByTestId("expand-AlignConsecutiveMacros").click();
  const enabled = page.getByTestId("value-AlignConsecutiveMacros.Enabled");
  await enabled.scrollIntoViewIfNeeded();
  await expect(enabled).toBeChecked();

  const yaml = await readExportYaml(page);
  expect(yaml).toContain("AlignConsecutiveMacros:");
  expect(yaml).toContain("Enabled: true");
  expect(yaml).not.toContain("NotARealOption");
});

// ---------------------------------------------------------------------------
// 6. Map control
// ---------------------------------------------------------------------------

test("map option edits are exported sparsely", async ({ page }) => {
  await openApp(page);

  await searchOption(page, "BraceWrapping");
  await page.getByTestId("expand-BraceWrapping").click();
  const afterClass = page.getByTestId("value-BraceWrapping.AfterClass");
  await afterClass.scrollIntoViewIfNeeded();
  await afterClass.check();
  await expectModifiedCount(page, 1);

  const yaml = await readExportYaml(page);
  expect(yaml).toContain("BraceWrapping:");
  expect(yaml).toContain("AfterClass: true");
});

// ---------------------------------------------------------------------------
// 7. Struct list control
// ---------------------------------------------------------------------------

test("struct list options edit and add items", async ({ page }) => {
  await openApp(page);

  await searchOption(page, "IncludeCategories");
  await page.getByTestId("expand-IncludeCategories").click();
  const priority = page.getByTestId("value-IncludeCategories.0.Priority");
  await priority.scrollIntoViewIfNeeded();
  await priority.fill("5");
  await priority.press("Tab");
  await expectModifiedCount(page, 1);

  const first = parseConfigYaml(await readExportYaml(page));
  const firstCategories = first.IncludeCategories as Array<Record<string, unknown>>;
  expect(Array.isArray(firstCategories)).toBe(true);
  expect(firstCategories[0]?.Priority).toBe(5);
  await closeDialog(page);

  await searchOption(page, "IncludeCategories");
  const addItem = page.getByTestId("add-item-IncludeCategories");
  if (!(await addItem.isVisible().catch(() => false))) {
    await page.getByTestId("expand-IncludeCategories").click();
  }
  await addItem.scrollIntoViewIfNeeded();
  await addItem.click();

  const second = parseConfigYaml(await readExportYaml(page));
  const secondCategories = second.IncludeCategories as unknown[];
  expect(secondCategories.length).toBe(firstCategories.length + 1);
});

// ---------------------------------------------------------------------------
// 8. list<string> control
// ---------------------------------------------------------------------------

test("list of strings edits are exported in full", async ({ page }) => {
  await openApp(page);

  await searchOption(page, "ForEachMacros");
  await page.getByTestId("expand-ForEachMacros").click();
  const editor = page.getByTestId("value-ForEachMacros");
  await editor.scrollIntoViewIfNeeded();
  await editor.fill("MY_FOREACH\nQ_FOREACH");
  await editor.press("Tab");
  await expectModifiedCount(page, 1);

  const config = parseConfigYaml(await readExportYaml(page));
  expect(config.ForEachMacros).toEqual(["MY_FOREACH", "Q_FOREACH"]);
});

// ---------------------------------------------------------------------------
// 9. Filter chips
// ---------------------------------------------------------------------------

test("filter chips narrow the option list", async ({ page }) => {
  await openApp(page);
  await fillOption(page, "IndentWidth", "4");
  await expectModifiedCount(page, 1);

  await page.getByTestId("options-search").fill("");
  await page.getByTestId("filter-modified").click();
  await expect(page.getByTestId("filter-modified")).toHaveAttribute("aria-pressed", "true");
  await findOptionRow(page, "IndentWidth");
  await expect(page.getByTestId("option-ColumnLimit")).toHaveCount(0);

  await page.getByTestId("filter-deprecated").click();
  await expect(page.getByTestId("filter-deprecated")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("option-AlwaysBreakAfterReturnType")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Dialog behaviour: focus, Escape and overlay closing
// ---------------------------------------------------------------------------

test("dialog manages focus and closes on Escape or overlay click", async ({ page }) => {
  await openApp(page);

  await page.getByTestId("open-import").click();
  await expect(dialogLocator(page)).toBeVisible();
  await expect(page.getByTestId("dialog-close")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialogLocator(page)).toBeHidden();
  await expect(page.getByTestId("open-import")).toBeFocused();

  await page.getByTestId("open-export").click();
  await expect(dialogLocator(page)).toBeVisible();
  await page.mouse.click(3, 3);
  await expect(dialogLocator(page)).toBeHidden();
});

// ---------------------------------------------------------------------------
// Import error path: inline, non-destructive, dialog stays open
// ---------------------------------------------------------------------------

test("invalid YAML shows an inline error and keeps the dialog open", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("open-import").click();
  await expect(page.getByTestId("import-text")).toBeVisible();

  await page.getByTestId("import-text").fill("BasedOnStyle: [LLVM");
  await page.getByTestId("import-apply").click();

  const error = page.getByTestId("import-error");
  await expect(error).toBeVisible();
  await expect(error).toHaveAttribute("role", "alert");
  await expect(error).not.toHaveText("");
  await expect(dialogLocator(page)).toBeVisible();

  // The dialog stays usable: fixing the text and applying succeeds.
  await page.getByTestId("import-text").fill("BasedOnStyle: GNU\n");
  await page.getByTestId("import-apply").click();
  await expect(dialogLocator(page)).toBeHidden();
  await expect(page.getByLabel("Style")).toHaveValue("GNU");
});

// ---------------------------------------------------------------------------
// File picker and download
// ---------------------------------------------------------------------------

test("loading a file fills the import textarea", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("open-import").click();
  const contents = "BasedOnStyle: Google\nIndentWidth: 3\n";
  await page.getByTestId("import-file").setInputFiles({
    name: ".clang-format",
    mimeType: "text/plain",
    buffer: Buffer.from(contents, "utf8"),
  });
  await expect(page.getByTestId("import-text")).toHaveValue(contents);
});

test("download saves a .clang-format file", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("open-export").click();
  await expect(page.getByTestId("config-yaml")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download-config").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain("clang-format");
});

// ---------------------------------------------------------------------------
// Copy to clipboard
// ---------------------------------------------------------------------------

test("copy puts the exported YAML on the clipboard", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "clipboard permissions are only granted on Chromium");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page);
  await page.getByTestId("open-export").click();
  const yaml = await page.getByTestId("config-yaml").inputValue();
  await page.getByTestId("copy-config").click();
  await expect(page.getByTestId("copy-config")).toHaveText(/copied/i);
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  // Windows clipboard normalizes line endings to CRLF; the YAML itself uses LF.
  expect(clipboard.replace(/\r\n/g, "\n")).toBe(yaml);
});

// ---------------------------------------------------------------------------
// Docs expand: lazy docs.json load and build-time HTML rendering
// ---------------------------------------------------------------------------

test("docs expand lazily loads and renders the option documentation", async ({ page }) => {
  const failed: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);
  });

  await openApp(page);
  // No search yet: docs have not been fetched, the expand button must load them.
  const row = await findOptionRow(page, "IndentWidth");
  await expect(row).toBeVisible();
  await page.getByTestId("docs-IndentWidth").click();

  const docs = page.getByTestId("docs-content-IndentWidth");
  await expect(docs).toBeVisible({ timeout: 15_000 });
  await expect(docs).toContainText(/indent/i);
  expect(failed).toEqual([]);
});

// ---------------------------------------------------------------------------
// Top-level enum and boolean controls
// ---------------------------------------------------------------------------

test("enum and boolean controls edit options", async ({ page }) => {
  await openApp(page);

  await searchOption(page, "AlignAfterOpenBracket");
  await page.getByTestId("value-AlignAfterOpenBracket").selectOption("AlwaysBreak");

  await searchOption(page, "Cpp11BracedListStyle");
  const bool = page.getByTestId("value-Cpp11BracedListStyle");
  await expect(bool).toBeChecked();
  await bool.uncheck();
  await expectModifiedCount(page, 2);

  const yaml = await readExportYaml(page);
  expect(yaml).toContain("AlignAfterOpenBracket: AlwaysBreak");
  expect(yaml).toContain("Cpp11BracedListStyle: false");
});
