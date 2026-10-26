import { expect, test, type Page } from "@playwright/test";

import { APP_READY_TIMEOUT, openApp, openSettings, readEditorText, setEditorText } from "./helpers";

// Soft-wrap preference acceptance coverage.
//
// Contract under test:
//   - Settings popover checkbox `soft-wrap` ("Soft wrap"), checked by default on
//     a fresh browser context.
//   - Persisted in the versioned localStorage document as the boolean field
//     `softWrap` (debounced ~400 ms) and restored on the next boot.
//   - When on, every CodeMirror `.cm-content` (source/output panes, both sides
//     of the split diff view, the Config drawer YAML editor) carries the
//     `cm-lineWrapping` class, so long logical lines wrap instead of scrolling
//     horizontally. Toggling reconfigures the live views (no remount).

const STORAGE_KEY = "clang-format-configurator:v3";
const CONFIG_YAML = "config-yaml";
const WRAPPING_CLASS = /cm-lineWrapping/;
const SAMPLE_OUTPUT = "class Widget {";
const LONG_LINE = `int x = 0; // ${"a".repeat(300)}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The persisted `softWrap` field, or undefined when no session was written yet. */
async function readStoredSoftWrap(page: Page): Promise<unknown> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return undefined;
    try {
      return (JSON.parse(raw) as Record<string, unknown>).softWrap;
    } catch {
      return "unparseable";
    }
  }, STORAGE_KEY);
}

/** Wait for the debounced persistence write to store `softWrap === value`. */
async function expectStoredSoftWrap(page: Page, value: boolean): Promise<void> {
  await expect.poll(() => readStoredSoftWrap(page), { timeout: 5_000 }).toBe(value);
}

/** Open the settings popover and move the soft-wrap checkbox to `checked`. */
async function setSoftWrap(page: Page, checked: boolean): Promise<void> {
  await openSettings(page);
  const checkbox = page.getByTestId("soft-wrap");
  await expect(checkbox).toBeVisible();
  if (checked) {
    await checkbox.check();
    await expect(checkbox).toBeChecked();
  } else {
    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
  }
}

/** Reload and wait until the app is interactive again (same waits as openApp). */
async function reloadApp(page: Page): Promise<void> {
  await page.reload();
  await expect(page.getByTestId("options-panel")).toBeAttached({ timeout: APP_READY_TIMEOUT });
  await expect.poll(() => readEditorText(page, "output"), { timeout: APP_READY_TIMEOUT }).toContain(SAMPLE_OUTPUT);
}

type EditorMetrics = {
  /** Number of logical lines (`.cm-line` elements); wrapping must not add any. */
  lineCount: number;
  /** Height of the tallest rendered logical line, in CSS pixels. */
  tallestLineHeight: number;
  scrollWidth: number;
  clientWidth: number;
};

/** Geometry of one CodeMirror editor; `testId` targets its `.cm-content` element. */
async function editorMetrics(page: Page, testId: string): Promise<EditorMetrics> {
  return page.getByTestId(testId).evaluate((content, id) => {
    const scroller = content.closest(".cm-editor")?.querySelector<HTMLElement>(".cm-scroller") ?? null;
    if (scroller === null) throw new Error(`${id}: editor has no .cm-scroller`);
    const lines = Array.from(content.querySelectorAll<HTMLElement>(".cm-line"));
    return {
      lineCount: lines.length,
      tallestLineHeight: lines.reduce((tallest, line) => Math.max(tallest, line.getBoundingClientRect().height), 0),
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth,
    };
  }, testId);
}

/**
 * Height of one text row: the shortest `.cm-line` of the (multi-line) sample
 * document. The sample contains short lines, so the minimum is exactly one row
 * even when some long sample lines already wrap.
 */
async function oneRowHeight(page: Page, testId: string): Promise<number> {
  return page.getByTestId(testId).evaluate((content, id) => {
    const heights = Array.from(content.querySelectorAll<HTMLElement>(".cm-line"), (line) =>
      line.getBoundingClientRect().height,
    );
    if (heights.length === 0) throw new Error(`${id}: no .cm-line rendered`);
    return Math.min(...heights);
  }, testId);
}

// ---------------------------------------------------------------------------
// Default state and live toggle in the main panes
// ---------------------------------------------------------------------------

test("soft wrap is on by default and toggles the main editors live", async ({ page }) => {
  await openApp(page);

  // Default ON: both main panes carry the CodeMirror wrapping class.
  await expect(page.getByTestId("source")).toHaveClass(WRAPPING_CLASS);
  await expect(page.getByTestId("output")).toHaveClass(WRAPPING_CLASS);
  await openSettings(page);
  await expect(page.getByTestId("soft-wrap")).toBeChecked();

  // One row height, measured before the long line replaces the sample content.
  const oneRow = await oneRowHeight(page, "source");
  expect(oneRow).toBeGreaterThan(10);
  expect(oneRow).toBeLessThan(40);

  // Mark the content element: toggling must reconfigure the live view in place
  // (no remount), so the marker has to survive both toggles below.
  await page.getByTestId("source").evaluate((content) => content.setAttribute("data-soft-wrap-probe", "keep"));

  // A 300+ character single line cannot fit the pane. With wrap on it stays one
  // logical line but takes several visual rows and does not overflow sideways.
  await setEditorText(page, "source", LONG_LINE);
  await expect(page.getByTestId("source")).toHaveClass(WRAPPING_CLASS);
  await expect(page.getByTestId("source").locator(".cm-line")).toHaveCount(1);
  await expect
    .poll(async () => (await editorMetrics(page, "source")).tallestLineHeight, { timeout: 5_000 })
    .toBeGreaterThan(oneRow * 1.5);
  await expect
    .poll(
      async () => {
        const metrics = await editorMetrics(page, "source");
        return metrics.scrollWidth - metrics.clientWidth;
      },
      { timeout: 5_000 },
    )
    .toBeLessThanOrEqual(1);

  // Unchecking removes the class live and lets the long line scroll sideways.
  await setSoftWrap(page, false);
  await expect(page.getByTestId("source")).not.toHaveClass(WRAPPING_CLASS);
  await expect(page.getByTestId("output")).not.toHaveClass(WRAPPING_CLASS);
  await expect
    .poll(async () => (await editorMetrics(page, "source")).tallestLineHeight, { timeout: 5_000 })
    .toBeLessThanOrEqual(oneRow + 2);
  await expect
    .poll(
      async () => {
        const metrics = await editorMetrics(page, "source");
        return metrics.scrollWidth - metrics.clientWidth;
      },
      { timeout: 5_000 },
    )
    .toBeGreaterThan(0);

  // Re-checking wraps the line again on the same, never-remounted editor.
  await setSoftWrap(page, true);
  await expect(page.getByTestId("source")).toHaveClass(WRAPPING_CLASS);
  await expect
    .poll(async () => (await editorMetrics(page, "source")).tallestLineHeight, { timeout: 5_000 })
    .toBeGreaterThan(oneRow * 1.5);
  expect(await page.getByTestId("source").getAttribute("data-soft-wrap-probe")).toBe("keep");
});

// ---------------------------------------------------------------------------
// Persistence across reloads
// ---------------------------------------------------------------------------

test("soft-wrap preference persists in localStorage across reloads", async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  await expect(page.getByTestId("soft-wrap")).toBeChecked();

  // Turn wrapping off; the session is written ~400 ms after the last change.
  await page.getByTestId("soft-wrap").uncheck();
  await expectStoredSoftWrap(page, false);

  // A full reload restores the saved preference (wrapping stays off).
  await reloadApp(page);
  await openSettings(page);
  await expect(page.getByTestId("soft-wrap")).not.toBeChecked();
  await expect(page.getByTestId("source")).not.toHaveClass(WRAPPING_CLASS);

  // Turn it back on, persist, reload: wrapping is restored again.
  await page.getByTestId("soft-wrap").check();
  await expectStoredSoftWrap(page, true);
  await reloadApp(page);
  await openSettings(page);
  await expect(page.getByTestId("soft-wrap")).toBeChecked();
  await expect(page.getByTestId("source")).toHaveClass(WRAPPING_CLASS);
});

// ---------------------------------------------------------------------------
// Split diff view follows the preference
// ---------------------------------------------------------------------------

test("soft wrap applies to both sides of the split diff view", async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  await expect(page.getByTestId("soft-wrap")).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-menu")).toBeHidden();

  await page.getByTestId("diff-toggle").check();
  const diffView = page.getByTestId("diff-view");
  await expect(diffView).toBeVisible();
  await expect(diffView.getByTestId("source")).toHaveClass(WRAPPING_CLASS);
  await expect(diffView.getByTestId("output")).toHaveClass(WRAPPING_CLASS);

  // Unchecking while the diff is open reconfigures both editors live.
  await setSoftWrap(page, false);
  await expect(diffView.getByTestId("source")).not.toHaveClass(WRAPPING_CLASS);
  await expect(diffView.getByTestId("output")).not.toHaveClass(WRAPPING_CLASS);

  // Re-checking restores wrapping on both sides.
  await setSoftWrap(page, true);
  await expect(diffView.getByTestId("source")).toHaveClass(WRAPPING_CLASS);
  await expect(diffView.getByTestId("output")).toHaveClass(WRAPPING_CLASS);

  // Closing the diff brings the normal panes back, still wrapped.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-menu")).toBeHidden();
  await page.getByTestId("diff-toggle").uncheck();
  await expect(diffView).toBeHidden();
  await expect(page.getByTestId("source")).toHaveClass(WRAPPING_CLASS);
  await expect(page.getByTestId("output")).toHaveClass(WRAPPING_CLASS);
});

// ---------------------------------------------------------------------------
// Config drawer YAML editor follows the preference (mount-time path)
// ---------------------------------------------------------------------------

test("soft wrap applies to the configuration drawer YAML editor", async ({ page }) => {
  await openApp(page);

  // The drawer mounts a fresh editor each time it opens, so this covers the
  // mount-time path of the preference.
  await page.getByTestId("open-config").click();
  await expect(page.getByTestId("config-drawer")).toBeVisible();
  await expect(page.getByTestId(CONFIG_YAML)).toBeVisible();
  await expect(page.getByTestId(CONFIG_YAML)).toHaveClass(WRAPPING_CLASS);

  await page.getByTestId("config-close").click();
  await expect(page.getByTestId("config-drawer")).toBeHidden();

  // With wrapping off, the next drawer mount must not wrap either.
  await setSoftWrap(page, false);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-menu")).toBeHidden();

  await page.getByTestId("open-config").click();
  await expect(page.getByTestId("config-drawer")).toBeVisible();
  await expect(page.getByTestId(CONFIG_YAML)).toBeVisible();
  await expect(page.getByTestId(CONFIG_YAML)).not.toHaveClass(WRAPPING_CLASS);
});
