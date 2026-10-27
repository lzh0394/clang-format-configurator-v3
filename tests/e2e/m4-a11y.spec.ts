import { expect, test, type Page } from "@playwright/test";

import { openApp } from "./helpers";

// M4 acceptance: the accessibility / interaction leftovers from M3.
//
// 1. The virtualized options list is a single Tab stop with a roving model:
//    arrow keys, Home/End and PageUp/PageDown reach every one of the 209 rows
//    even though only the visible window is in the DOM.
// 2. Tab enters the controls of the active row and Shift+Tab returns to it.
// 3. ConfigDialog traps Tab, closes on Escape and returns focus to its trigger
//    (the drawer already did; both now share focus-trap.ts).
// 4. Docs HTML `<pre>` blocks are focusable tab stops and leaked RST markers
//    (`.. code-block:: c++`) are gone.
// 5. When both modals are open, only the top-most one (the drawer paints above
//    the dialog) owns Tab/Escape.
//
// Written but not run by the M4 a11y owner: the Lead runs the whole Playwright
// suite against a fresh `vite preview` (port 4173 must be free).

const FIRST_OPTION = "AccessModifierOffset";
/** Index of the last option in clang-format 23.1.1 (209 options, 0-based). */
const LAST_INDEX = 208;

/** Index of the virtual row that currently has focus, or null when focus is elsewhere. */
async function activeRowIndex(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const active = document.activeElement;
    const wrapper = active instanceof Element ? active.closest("[data-index]") : null;
    if (!(wrapper instanceof HTMLElement)) return null;
    const value = wrapper.getAttribute("data-index");
    return value === null ? null : Number(value);
  });
}

/** Rendered rows that are in the tab order; the roving model allows exactly one. */
async function countRovingTabStops(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="option-"]')).filter(
        (row) => row.tabIndex === 0,
      ).length,
  );
}

async function countRenderedRows(page: Page): Promise<number> {
  return page.getByTestId("options-scroll").locator('[data-index]').count();
}

/** Focus inside the element with `testId`? */
async function focusIsInside(page: Page, testId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const root = document.querySelector(`[data-testid="${id}"]`);
    const active = document.activeElement;
    return root !== null && active !== null && root.contains(active);
  }, testId);
}

// ---------------------------------------------------------------------------
// 1. Roving navigation across the virtualized window
// ---------------------------------------------------------------------------

test("arrow keys move the roving tab stop across the whole virtualized list", async ({ page }) => {
  await openApp(page);

  const first = page.getByTestId(`option-${FIRST_OPTION}`);
  await expect(first).toBeVisible();
  await expect(first).toHaveAttribute("tabindex", "0");
  await first.focus();
  await expect(first).toBeFocused();

  // Only the active row is in the tab order, and virtualization keeps the DOM
  // far smaller than the 209 options.
  expect(await countRovingTabStops(page)).toBe(1);
  const renderedBefore = await countRenderedRows(page);
  expect(renderedBefore).toBeGreaterThan(1);
  expect(renderedBefore).toBeLessThan(209);

  // 40 rows down: well past the first virtual window.
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press("ArrowDown");
  }
  await expect.poll(() => activeRowIndex(page)).toBe(40);
  // Focus is on the row itself, not on one of its controls.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? ""))
    .toMatch(/^option-/);
  // The list really scrolled and the first row left the DOM: cross-window
  // movement, not just moving inside the initial window.
  expect(await page.getByTestId("options-scroll").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(first).toHaveCount(0);
  expect(await countRovingTabStops(page)).toBe(1);

  // Home jumps back to the top; the row is re-rendered and focused.
  await page.keyboard.press("Home");
  await expect.poll(() => activeRowIndex(page)).toBe(0);
  await expect(page.getByTestId(`option-${FIRST_OPTION}`)).toBeFocused();

  // End jumps to the last option (also outside any window near the top).
  await page.keyboard.press("End");
  await expect.poll(() => activeRowIndex(page)).toBe(LAST_INDEX);
  expect(await countRovingTabStops(page)).toBe(1);

  // PageUp moves up by a page but not to the top, PageDown returns to the end.
  await page.keyboard.press("PageUp");
  const afterPageUp = await activeRowIndex(page);
  expect(afterPageUp).not.toBeNull();
  expect(afterPageUp as number).toBeGreaterThan(0);
  expect(afterPageUp as number).toBeLessThan(LAST_INDEX);
  await page.keyboard.press("PageDown");
  await expect.poll(() => activeRowIndex(page)).toBe(LAST_INDEX);

  // Search and filter changes converge the stop onto a visible row: a new search
  // restarts the list at the top, so row 0 of the (shorter) result is the stop.
  await page.getByTestId("options-search").fill("IndentWidth");
  await page.waitForTimeout(180);
  await expect(page.getByTestId("option-IndentWidth")).toHaveCount(1);
  await expect(page.getByTestId("options-count")).not.toContainText("209 / 209");
  expect(await countRovingTabStops(page)).toBe(1);
  const rovingIndex = async (): Promise<number | null> =>
    page.evaluate(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="option-"]')).find(
        (element) => element.tabIndex === 0,
      );
      const wrapper = row?.closest("[data-index]") ?? null;
      const value = wrapper?.getAttribute("data-index") ?? null;
      return value === null ? null : Number(value);
    });
  expect(await rovingIndex()).toBe(0);

  await page.getByTestId("options-search").fill("");
  await page.waitForTimeout(180);
  await expect(page.getByTestId(`option-${FIRST_OPTION}`)).toHaveAttribute("tabindex", "0");
  expect(await countRovingTabStops(page)).toBe(1);
});

// ---------------------------------------------------------------------------
// 2. Single Tab stop: Tab enters the row controls, Shift+Tab returns to the row
// ---------------------------------------------------------------------------

test("the list is one Tab stop and Tab enters the active row", async ({ page }) => {
  await openApp(page);

  const row = page.getByTestId(`option-${FIRST_OPTION}`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("tabindex", "0");

  // Tab order from the search box: filter chips, then the active row. No other
  // rendered row is a tab stop, so the list itself costs exactly one Tab.
  await page.getByTestId("options-search").focus();
  await page.keyboard.press("Tab"); // filter-all
  await page.keyboard.press("Tab"); // filter-modified
  await page.keyboard.press("Tab"); // filter-deprecated
  await page.keyboard.press("Tab"); // the roving tab stop
  await expect(row).toBeFocused();

  // Tab moves into the row's own controls…
  await page.keyboard.press("Tab");
  await expect(page.getByTestId(`docs-${FIRST_OPTION}`)).toBeFocused();
  // …and Shift+Tab returns to the row (the roving tab stop).
  await page.keyboard.press("Shift+Tab");
  await expect(row).toBeFocused();

  // Enter toggles the documentation of the focused row (M4 row behaviour).
  const docsButton = page.getByTestId(`docs-${FIRST_OPTION}`);
  await expect(docsButton).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(docsButton).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId(`docs-content-${FIRST_OPTION}`)).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Enter");
  await expect(docsButton).toHaveAttribute("aria-expanded", "false");

  // Arrow keys pressed inside a row control keep their native behaviour: the
  // number input steps instead of moving the roving stop.
  await expect(row).toBeFocused();
  await page.keyboard.press("Tab"); // docs button
  await page.keyboard.press("Tab"); // number input
  await expect(page.getByTestId(`value-${FIRST_OPTION}`)).toBeFocused();
  const before = await activeRowIndex(page);
  await page.keyboard.press("ArrowDown");
  expect(await activeRowIndex(page)).toBe(before);
});

// ---------------------------------------------------------------------------
// 3. ConfigDialog focus trap (aligned with ConfigDrawer)
// ---------------------------------------------------------------------------

test("ConfigDialog traps Tab, closes on Escape and restores focus", async ({ page }) => {
  await openApp(page);

  await page.getByTestId("open-import").click();
  const dialog = page.getByTestId("config-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("dialog-close")).toBeFocused();

  // Shift+Tab from the first stop wraps to the last one (Apply)…
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("import-apply")).toBeFocused();
  // …and Tab from there wraps back to the close button.
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("dialog-close")).toBeFocused();

  // Many Tabs never leave the dialog (no M3 "Tab walks behind the modal").
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press("Tab");
    expect(await focusIsInside(page, "config-dialog")).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("open-import")).toBeFocused();
});

// ---------------------------------------------------------------------------
// 4. Docs code blocks: focusable <pre>, no leaked RST markers
// ---------------------------------------------------------------------------

test("docs code blocks are focusable and leaked RST markers are cleaned", async ({ page }) => {
  await openApp(page);

  // IndentWidth docs contain a real <pre><code> example block.
  await page.getByTestId("options-search").fill("IndentWidth");
  await page.waitForTimeout(180);
  await page.getByTestId("docs-IndentWidth").click();
  const docs = page.getByTestId("docs-content-IndentWidth");
  await expect(docs).toBeVisible({ timeout: 15_000 });

  const codeBlock = docs.locator("pre").first();
  await expect(codeBlock).toHaveAttribute("tabindex", "0");
  await codeBlock.focus();
  await expect(codeBlock).toBeFocused();
  // It is the scroll container of the snippet, so the focus ring is meaningful.
  await expect(codeBlock).toHaveCSS("overflow-x", "auto");

  // Enum tables used to show the generator's raw `.. code-block:: c++` marker in
  // the "Meaning" column; the render layer cleans it up (tools/gen-schema.mjs is
  // owned by another M4 task and is not touched here). BreakBeforeBraces is the
  // enum that still carries such a marker in the newest schema
  // (AlignAfterOpenBracket became a bool in clang-format 22).
  await page.getByTestId("options-search").fill("BreakBeforeBraces");
  await page.waitForTimeout(180);
  await page.getByTestId("docs-BreakBeforeBraces").click();
  const enumDocs = page.getByTestId("docs-content-BreakBeforeBraces");
  await expect(enumDocs).toBeVisible({ timeout: 15_000 });
  await expect(enumDocs).not.toContainText("code-block::");
  await expect(enumDocs).toContainText("Always attach braces to surrounding context");
  expect(await enumDocs.locator("pre").count()).toBe(0);
});

// ---------------------------------------------------------------------------
// 5. Two open modals: the top-most (drawer) owns the keyboard
// ---------------------------------------------------------------------------

test("when both modals are open only the top-most one traps and closes", async ({ page }) => {
  await openApp(page);

  await page.getByTestId("open-config").click();
  const drawer = page.getByTestId("config-drawer");
  await expect(drawer).toBeVisible();

  // The header buttons sit behind the drawer overlay, so open the dialog the way
  // App's independent state allows: dispatch the click on the real button.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-testid="open-export"]')?.click();
  });
  const dialog = page.getByTestId("config-dialog");
  await expect(dialog).toBeVisible();
  await expect(drawer).toBeVisible();

  // The drawer's overlay paints above the dialog's (z-index 110 vs 100): Tab
  // stays in the drawer even while the dialog is open.
  await page.keyboard.press("Tab");
  expect(await focusIsInside(page, "config-drawer")).toBe(true);

  // Escape closes only the drawer; the dialog is still open and keeps working.
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Tab");
  expect(await focusIsInside(page, "config-dialog")).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
