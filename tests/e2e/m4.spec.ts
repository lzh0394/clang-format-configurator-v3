import { expect, test, type Browser, type Page } from "@playwright/test";

import { shareUrlFor, type ShareState } from "../../src/lib/share-link";
import {
  APP_READY_TIMEOUT,
  expectEditorText,
  expectEditorTextContains,
  openApp,
  openSettings,
  readEditorText,
  setEditorText,
} from "./helpers";

// M4 acceptance (plan §9 M4 row):
//   - share links: #s=... encodes the session, hash > localStorage, invalid
//     hashes fall back to storage, the fragment is stripped after hydrating
//   - interface font-size scaling: rem-based multiplier, independent from the
//     editor font, persisted, virtual list still lays out correctly
//   - all published wasm versions are selectable and actually format

const STORAGE_KEY = "clang-format-configurator:v3";
const CONFIG_YAML = "config-yaml";

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function applyConfig(page: Page, yaml: string): Promise<void> {
  await page.getByTestId("open-config").click();
  await expect(page.getByTestId("config-drawer")).toBeVisible();
  await setEditorText(page, CONFIG_YAML, yaml);
  await expect(page.getByTestId("config-valid")).toBeVisible();
  await page.getByTestId("config-apply").click();
  await expect(page.getByTestId("config-drawer")).toBeHidden();
}

async function readStoredSession(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, STORAGE_KEY);
}

async function expectStoredField(page: Page, key: string, value: unknown): Promise<void> {
  await expect
    .poll(async () => (await readStoredSession(page))?.[key], { timeout: 5_000 })
    .toEqual(value);
}

/** Capture navigator.clipboard.writeText (headless Edge has no real clipboard). */
async function stubClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as unknown as { __copiedShareLink?: string };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          target.__copiedShareLink = text;
        },
      },
    });
  });
}

async function copiedShareLink(page: Page): Promise<string> {
  const link = await page.evaluate(
    () => (window as unknown as { __copiedShareLink?: string }).__copiedShareLink,
  );
  expect(link).toBeTruthy();
  expect(link).toContain("#s=");
  return link as string;
}

/** Open a fresh browser context whose localStorage already holds `session`. */
async function openWithStoredSession(
  browser: Browser,
  origin: string,
  session: Record<string, unknown>,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({
    storageState: {
      cookies: [],
      origins: [
        {
          origin,
          localStorage: [{ name: STORAGE_KEY, value: JSON.stringify({ stateVersion: 1, ...session }) }],
        },
      ],
    },
  });
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------

test("copies a share link that restores the whole session from the URL hash", async ({ page, context }) => {
  await stubClipboard(page);
  await openApp(page);

  await applyConfig(page, "BasedOnStyle: Google\nIndentWidth: 6\n");
  await expect(page.getByTestId("modified-count")).toContainText("1 modified");
  await setEditorText(page, "source", "int shared_fn(){return 1;}\n");
  await expectEditorTextContains(page, "output", "int shared_fn() { return 1; }");

  await page.getByTestId("copy-link").click();
  await expect(page.getByTestId("notice")).toContainText("Share link copied");
  const link = await copiedShareLink(page);
  await page.getByTestId("notice-close").click();

  // A different tab with empty storage hydrates entirely from the fragment.
  const other = await context.newPage();
  await other.goto(link);
  await expect(other.getByTestId("options-panel")).toBeVisible({ timeout: APP_READY_TIMEOUT });
  await expect(other.getByLabel("Style")).toHaveValue("Google");
  await expect(other.getByTestId("modified-count")).toContainText("1 modified");
  await expect.poll(() => readEditorText(other, "source"), { timeout: 10_000 }).toBe("int shared_fn(){return 1;}\n");
  await expectEditorTextContains(other, "output", "int shared_fn() { return 1; }");

  const notice = other.getByTestId("notice");
  await expect(notice).toContainText("Loaded a shared configuration");
  await expect(notice).toContainText("source code included");
  // The fragment is stripped after hydrating so reloads use localStorage.
  expect(new URL(other.url()).hash).toBe("");
  await other.close();
});

test("a share link wins over the saved localStorage session", async ({ page, browser }) => {
  await openApp(page);
  const origin = new URL("./", page.url()).origin;

  const shared: ShareState = {
    version: "21.1.8",
    style: "Google",
    modified: { IndentWidth: 3 },
    code: "int from_share(){return 3;}\n",
  };
  const stored = {
    version: "21.1.8",
    style: "GNU",
    modified: { IndentWidth: 9 },
    code: "int from_storage(){return 9;}\n",
    theme: "dark",
    editorFontSize: 18,
    uiFontScale: 1,
  };
  const { page: sharedPage, close } = await openWithStoredSession(browser, origin, stored);
  try {
    // A query parameter forces a real navigation; a hash-only change would not
    // reload the app and therefore would not exercise the hash-first restore.
    await sharedPage.goto(shareUrlFor("./?shared=1", shared, page.url()));
    await expect(sharedPage.getByTestId("options-panel")).toBeVisible({ timeout: APP_READY_TIMEOUT });

    await expect(sharedPage.getByLabel("Style")).toHaveValue("Google");
    await expect(sharedPage.getByTestId("modified-count")).toContainText("1 modified");
    await expect.poll(() => readEditorText(sharedPage, "source"), { timeout: 10_000 }).toBe(
      "int from_share(){return 3;}\n",
    );
    await expectEditorTextContains(sharedPage, "output", "int from_share() { return 3; }");
    // The stored session (GNU / from_storage) was not applied.
    await expect(sharedPage.getByLabel("Style")).not.toHaveValue("GNU");
    // Theme/editor font still come from storage: the hash only carries the
    // configuration (plan §5 priority is about configuration state).
    expect(await sharedPage.locator("html").getAttribute("data-theme")).toBe("dark");
  } finally {
    await close();
  }
});

test("an invalid share hash falls back to the saved session", async ({ page, browser }) => {
  await openApp(page);
  const origin = new URL("./", page.url()).origin;
  const stored = {
    version: "21.1.8",
    style: "Mozilla",
    modified: { IndentWidth: 9 },
    code: "int from_storage(){return 9;}\n",
    theme: "light",
    editorFontSize: 13,
    uiFontScale: 1,
  };
  const { page: fallback, close } = await openWithStoredSession(browser, origin, stored);
  try {
    await fallback.goto(`${new URL("./", page.url()).href}#s=%%%not-a-valid-share-link%%%`);
    await expect(fallback.getByTestId("options-panel")).toBeVisible({ timeout: APP_READY_TIMEOUT });

    await expect(fallback.getByLabel("Style")).toHaveValue("Mozilla");
    await expect.poll(() => readEditorText(fallback, "source"), { timeout: 10_000 }).toBe(
      "int from_storage(){return 9;}\n",
    );
    await expect(fallback.getByTestId("notice")).toHaveCount(0);
  } finally {
    await close();
  }
});

test("share payloads decode before first paint (no flash of stored state)", async ({ page, browser }) => {
  // The hash state must already be in the first render (App decodes it in the
  // useState initializer); a stored session with different content is present
  // and must not win.
  await openApp(page);
  const origin = new URL("./", page.url()).origin;
  const stored = {
    version: "21.1.8",
    style: "GNU",
    modified: {},
    code: "int from_storage(){return 9;}\n",
    theme: "light",
    editorFontSize: 13,
    uiFontScale: 1,
  };
  const shared: ShareState = {
    version: "21.1.8",
    style: "Chromium",
    modified: {},
    code: "int first_paint(){return 0;}\n",
  };
  const { page: sharedPage, close } = await openWithStoredSession(browser, origin, stored);
  try {
    await sharedPage.goto(shareUrlFor("./", shared, page.url()));
    await expect(sharedPage.getByTestId("options-panel")).toBeVisible({ timeout: APP_READY_TIMEOUT });
    await expect
      .poll(() => readEditorText(sharedPage, "source"), { timeout: 10_000 })
      .toBe("int first_paint(){return 0;}\n");
    await expect(sharedPage.getByLabel("Style")).toHaveValue("Chromium");
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Interface font-size scaling (M4, plan §5 界面字号)
// ---------------------------------------------------------------------------

function rootFontSize(page: Page): Promise<number> {
  return page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
}

test("interface size scales the UI (not the editor) and persists", async ({ page }) => {
  await openApp(page);
  // The design baseline is 130% of the browser default: 16px -> 20.8px.
  expect(await rootFontSize(page)).toBe(20.8);
  const editorFont = await page.getByTestId("source").evaluate((element) => getComputedStyle(element).fontSize);

  await openSettings(page);
  await page.getByTestId("ui-font-scale").selectOption("1.15");
  await page.keyboard.press("Escape");

  await expect.poll(() => rootFontSize(page)).toBeCloseTo(23.92, 1);
  // The editor keeps its own --font-size-editor (plan §5 字号解耦).
  expect(await page.getByTestId("source").evaluate((element) => getComputedStyle(element).fontSize)).toBe(editorFont);

  // Text inside the UI really grew (the toggle is 0.8125rem: 16.9px at
  // Standard, 19.435px at Large on the 130% baseline).
  await openSettings(page);
  const toggleFont = await page
    .getByTestId("settings-toggle")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(toggleFont).toBeCloseTo(19.435, 1);

  // Bigger interface sizes make the header wrap; the popover must still be
  // fully on screen (it is anchored to the toggle, which can wrap near the
  // left edge).
  const menuBox = await page.getByTestId("settings-menu").boundingBox();
  expect(menuBox).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  expect(menuBox!.x).toBeGreaterThanOrEqual(0);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport!.width);
  expect(menuBox!.y).toBeGreaterThanOrEqual(0);
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(viewport!.height);
  await page.keyboard.press("Escape");

  // Virtual list rows still lay out without overlapping after re-measuring.
  // The row heights are measured asynchronously (ResizeObserver behind
  // @tanstack/react-virtual), so poll instead of sampling once.
  const overlapCount = async (): Promise<number> => {
    const rows = page.locator('[data-testid^="option-"]');
    const boxes: { top: number; bottom: number }[] = [];
    const count = await rows.count();
    for (let index = 0; index < Math.min(count, 12); index += 1) {
      const box = await rows.nth(index).boundingBox();
      if (box !== null) boxes.push({ top: box.y, bottom: box.y + box.height });
    }
    let overlaps = 0;
    for (let index = 1; index < boxes.length; index += 1) {
      if (boxes[index]!.top < boxes[index - 1]!.bottom - 1) overlaps += 1;
    }
    return overlaps;
  };
  await expect.poll(overlapCount, { timeout: 5_000, message: "scaled rows must not overlap" }).toBe(0);
  expect(await page.locator('[data-testid^="option-"]').count()).toBeGreaterThan(5);

  // Search + export still work at the larger size.
  await page.getByTestId("options-search").fill("Indent");
  await expect(page.getByTestId("options-count")).toContainText(/\//u);
  await expect(page.getByTestId("options-count")).not.toContainText(/169 \/ 169|189 \/ 189|209 \/ 209/u);
  await page.getByTestId("open-export").click();
  await expect(page.getByTestId("config-dialog")).toBeVisible();
  await page.getByTestId("dialog-close").click();

  await expectStoredField(page, "uiFontScale", 1.15);
  await page.reload();
  await expect(page.getByTestId("options-panel")).toBeVisible({ timeout: APP_READY_TIMEOUT });
  await expect.poll(() => rootFontSize(page)).toBeCloseTo(23.92, 1);

  // Back to the standard tier.
  await openSettings(page);
  await expect(page.getByTestId("ui-font-scale")).toHaveValue("1.15");
  await page.getByTestId("ui-font-scale").selectOption("1");
  await page.keyboard.press("Escape");
  await expect.poll(() => rootFontSize(page)).toBe(20.8);
});

// ---------------------------------------------------------------------------
// Desktop layout: the options panel fills its column, no horizontal overflow
// ---------------------------------------------------------------------------

test("desktop columns fill their tracks without horizontal page overflow", async ({ page }) => {
  // CodeMirror's content is as wide as its longest line; before the grid tracks
  // used minmax(0, 1fr) that min-content size widened the page and left an
  // unpainted strip next to the options panel.
  await openApp(page);

  for (const width of [1600, 1360, 1280, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const main = document.querySelector("main");
      if (main === null) throw new Error("main is missing");
      const optionsArea = main.firstElementChild as HTMLElement | null;
      const workbench = main.lastElementChild as HTMLElement | null;
      const panel = document.querySelector<HTMLElement>('[data-testid="options-panel"]');
      if (optionsArea === null || workbench === null || panel === null) throw new Error("layout nodes are missing");
      return {
        optionsAreaWidth: optionsArea.getBoundingClientRect().width,
        panelWidth: panel.getBoundingClientRect().width,
        workbenchRight: workbench.getBoundingClientRect().right,
        mainRight: main.getBoundingClientRect().right,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });

    // The panel stretches to the whole track (no gray strip to its right)...
    expect(
      Math.abs(layout.panelWidth - layout.optionsAreaWidth),
      `options panel should fill its column at ${width}px`,
    ).toBeLessThanOrEqual(1);
    // ...and the editor track stays inside the viewport (long lines scroll
    // inside CodeMirror instead of widening the page).
    expect(layout.workbenchRight, `workbench should stay inside main at ${width}px`).toBeLessThanOrEqual(
      layout.mainRight + 1,
    );
    expect(layout.scrollWidth, `no page overflow at ${width}px`).toBeLessThanOrEqual(layout.clientWidth + 1);
  }
});

test("narrow desktop keeps options left and stacks source above formatted on the right", async ({ page }) => {
  await openApp(page);

  // Measure the pane wrappers (grid items), not the CodeMirror content: a long
  // line makes the inner .cm-content wider than its pane, so its box is not a
  // reliable layout probe.
  const geometry = async (): Promise<{
    options: { left: number; right: number };
    source: { left: number; right: number; top: number; bottom: number };
    formatted: { left: number; right: number; top: number; bottom: number };
    scrollWidth: number;
    clientWidth: number;
  }> =>
    page.evaluate(() => {
      const pane = (testId: string): DOMRect => {
        const content = document.querySelector(`[data-testid="${testId}"]`);
        const section = content?.closest("section");
        if (section === null || section === undefined) throw new Error(`${testId} pane is missing`);
        return section.getBoundingClientRect();
      };
      const main = document.querySelector("main");
      if (main === null) throw new Error("main is missing");
      const options = main.firstElementChild?.getBoundingClientRect();
      if (options === undefined) throw new Error("options area is missing");
      const pick = (box: DOMRect): { left: number; right: number; top: number; bottom: number } => ({
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
      });
      return {
        options: { left: options.left, right: options.right },
        source: pick(pane("source")),
        formatted: pick(pane("output")),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });

  // 769–900px: below the three-column breakpoint but above the mobile tabs.
  for (const width of [900, 860, 820, 769]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await geometry();
    // Options stays on the left; both panes are to its right...
    expect(layout.source.left, `source should be right of options at ${width}px`).toBeGreaterThan(
      layout.options.right,
    );
    expect(layout.formatted.left, `formatted should be right of options at ${width}px`).toBeGreaterThan(
      layout.options.right,
    );
    // ...with source upper-right and formatted lower-right.
    expect(layout.source.bottom, `source should sit above formatted at ${width}px`).toBeLessThanOrEqual(
      layout.formatted.top + 1,
    );
    expect(layout.scrollWidth, `no page overflow at ${width}px`).toBeLessThanOrEqual(layout.clientWidth + 1);
  }

  // 901–1100px still uses three side-by-side columns (source left of formatted).
  await page.setViewportSize({ width: 1100, height: 900 });
  const wide = await geometry();
  expect(wide.source.right).toBeLessThanOrEqual(wide.formatted.left + 1);
  expect(wide.source.left).toBeGreaterThan(wide.options.right);
});

// ---------------------------------------------------------------------------
// Language switching example snippets (M4, plan §9 "C#/proto 代码示例")
// ---------------------------------------------------------------------------

test("switching the filename follows with the matching sample snippet", async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId("language")).toHaveText("C/C++");

  // A pristine sample is replaced by the sample for the new language.
  await page.getByLabel("Filename").fill("Program.cs");
  await expect(page.getByTestId("language")).toHaveText("C#");
  await expect.poll(() => readEditorText(page, "source"), { timeout: 10_000 }).toContain("namespace Demo");
  await expectEditorTextContains(page, "output", "namespace Demo {");

  await page.getByLabel("Filename").fill("service.proto");
  await expect(page.getByTestId("language")).toHaveText("Protobuf");
  await expect.poll(() => readEditorText(page, "source"), { timeout: 10_000 }).toContain('syntax = "proto3";');
  await expectEditorTextContains(page, "output", "message Widget");

  // Typed code is never replaced by a later filename change.
  await setEditorText(page, "source", "int keep_me(){return 1;}\n");
  await page.getByLabel("Filename").fill("main.cc");
  await expect(page.getByTestId("language")).toHaveText("C/C++");
  await expect.poll(() => readEditorText(page, "source"), { timeout: 10_000 }).toBe("int keep_me(){return 1;}\n");
});

// ---------------------------------------------------------------------------
// All published wasm versions are selectable and usable
// ---------------------------------------------------------------------------

test("ships every published wasm version (16.0.6–23.1.1) and formats with the edges", async ({ page }) => {
  await openApp(page);
  await expect(page.getByLabel("Version").locator("option")).toHaveCount(52);
  await expect(page.getByLabel("Version")).toHaveValue("23.1.1");

  // Newest first, and only the newest entry carries the "latest" label.
  const versionOptions = page.getByLabel("Version").locator("option");
  await expect(versionOptions.first()).toHaveText("23.1.1 (latest)");
  await expect(versionOptions.nth(1)).toHaveText("23.1.0");
  await expect(versionOptions.last()).toHaveText("16.0.6");
  await expect(page.getByLabel("Version").locator("option", { hasText: "(latest)" })).toHaveCount(1);

  // Oldest version: schema comes from a native dump, formatting from wasm.
  await page.getByLabel("Version").selectOption("16.0.6");
  await expect(page.getByTestId("status")).toContainText("clang-format 16.0.6 ready", {
    timeout: APP_READY_TIMEOUT,
  });
  await expectEditorTextContains(page, "output", "class Widget {");

  // Mid-range version (the long-standing 21.x default): still fully usable.
  await page.getByLabel("Version").selectOption("21.1.8");
  await expect(page.getByTestId("status")).toContainText("clang-format 21.1.8 ready", {
    timeout: APP_READY_TIMEOUT,
  });
  await expectEditorTextContains(page, "output", "class Widget {");

  // Back to the newest version — the preselected default: the sample still formats.
  await page.getByLabel("Version").selectOption("23.1.1");
  await expect(page.getByTestId("status")).toContainText("clang-format 23.1.1 ready", {
    timeout: APP_READY_TIMEOUT,
  });
  await expectEditorTextContains(page, "output", "class Widget {");
});
