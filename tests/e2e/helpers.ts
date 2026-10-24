import { expect, type Page } from "@playwright/test";

// Shared helpers for driving the CodeMirror 6 editors (M2).
//
// CodeMirror renders each logical line in its own `.cm-line` div, so the DOM
// node's `textContent` has no line breaks and `toContainText`/`fill()` do not
// behave like they do for a textarea. These helpers reconstruct the editor's
// logical document from the line divs, poll it (formatting is debounced) and
// replace the document through real keyboard input.
//
// `page.goto("./")` (not `/`) keeps the deployment sub-path from baseURL, so the
// same suite covers `/` locally and `/<repo>/` on GitHub Pages.

/** The wasm formatter / schema need a moment on a cold start. */
export const APP_READY_TIMEOUT = 30_000;
/** Default poll budget for debounced formatting results (250 ms debounce). */
export const FORMAT_TIMEOUT = 15_000;

/**
 * Read the logical text of a CodeMirror editor.
 *
 * `testId` targets the `.cm-content` element (both CodeEditor and DiffPane put
 * it there). Each `.cm-line` is one logical line; joining their text restores
 * the document's newlines. Non-breaking spaces (used by CodeMirror for some
 * whitespace rendering) are normalized back to plain spaces.
 */
export async function readEditorText(page: Page, testId: string): Promise<string> {
  return page.getByTestId(testId).evaluate((element) => {
    const lines = Array.from(element.querySelectorAll(".cm-line"), (line) => line.textContent ?? "");
    const text = lines.length > 0 ? lines.join("\n") : (element.textContent ?? "");
    return text.replace(/\u00a0/g, " ");
  });
}

/** Poll until the editor's logical text contains `expected` (string or RegExp). */
export async function expectEditorTextContains(
  page: Page,
  testId: string,
  expected: string | RegExp,
  timeout = FORMAT_TIMEOUT,
): Promise<void> {
  await expect.poll(async () => readEditorText(page, testId), { timeout }).toContain(expected);
}

/** Poll until the editor's logical text matches `pattern` (with `/m` for lines). */
export async function expectEditorTextToMatch(
  page: Page,
  testId: string,
  pattern: RegExp,
  timeout = FORMAT_TIMEOUT,
): Promise<void> {
  await expect.poll(async () => readEditorText(page, testId), { timeout }).toMatch(pattern);
}

/** Poll until the editor's logical text is exactly `expected`. */
export async function expectEditorText(
  page: Page,
  testId: string,
  expected: string,
  timeout = FORMAT_TIMEOUT,
): Promise<void> {
  await expect.poll(async () => readEditorText(page, testId), { timeout }).toBe(expected);
}

/**
 * Replace the whole document of a CodeMirror editor through real input events:
 * focus it, select all, then `insertText` (which works on contenteditable and is
 * one fast input event, unlike `fill()`).
 */
export async function setEditorText(page: Page, testId: string, text: string): Promise<void> {
  const content = page.getByTestId(testId);
  await content.click();
  await page.keyboard.press("ControlOrMeta+A");
  if (text === "") {
    await page.keyboard.press("Delete");
  } else {
    await page.keyboard.insertText(text);
  }
  // The controlled component echoes the value back; wait until the document
  // really holds the new text so callers do not race the debounce.
  await expect.poll(async () => readEditorText(page, testId), { timeout: 5_000 }).toBe(text);
}

/**
 * Open the app at the baseURL (production build) and wait until the wasm
 * formatter has produced the sample output, i.e. the app is fully interactive.
 */
export async function openApp(page: Page): Promise<void> {
  await page.goto("./");
  // The options panel is only mounted once the schema has loaded. It is merely
  // attached (not visible) on the mobile layout, where the Code tab is default,
  // so wait for attachment rather than visibility to stay layout-agnostic.
  await expect(page.getByTestId("options-panel")).toBeAttached({ timeout: APP_READY_TIMEOUT });
  await expectEditorTextContains(page, "output", "class Widget {", APP_READY_TIMEOUT);
}

/**
 * Open the header settings popover (M3). Theme and editor font size live in the
 * popover, so tests must open it before touching `editor-font-size` or
 * `theme-*`. Safe to call when it is already open.
 */
export async function openSettings(page: Page): Promise<void> {
  const toggle = page.getByTestId("settings-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(page.getByTestId("settings-menu")).toBeVisible();
}
