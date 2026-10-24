import { expect, test, type Page } from "@playwright/test";

import {
  APP_READY_TIMEOUT,
  expectEditorText,
  expectEditorTextContains,
  openApp,
  openSettings,
  readEditorText,
  setEditorText,
} from "./helpers";

// M3 acceptance (plan §9): versioned localStorage persistence, the theme system,
// the settings popover, mobile Options/Code tabs, service-worker offline mode,
// the skip link and the a11y pass. Plain browser tests only; wasm-vs-native and
// the performance budgets live in golden.spec.ts / perf.spec.ts.

const STORAGE_KEY = "clang-format-configurator:v3";
const CONFIG_YAML = "config-yaml";

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function waitForFormatted(page: Page, needle = "class Widget {"): Promise<void> {
  await expect(page.getByTestId("options-panel")).toBeVisible({ timeout: APP_READY_TIMEOUT });
  await expectEditorTextContains(page, "output", needle, APP_READY_TIMEOUT);
}

/** The persisted session document, or null when nothing was written yet. */
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

async function openDrawer(page: Page): Promise<void> {
  await page.getByTestId("open-config").click();
  await expect(page.getByTestId("config-drawer")).toBeVisible();
  await expect(page.getByTestId(CONFIG_YAML)).toBeVisible();
}

/** Apply a whole `.clang-format` document through the config drawer. */
async function applyConfig(page: Page, yaml: string): Promise<void> {
  await openDrawer(page);
  await setEditorText(page, CONFIG_YAML, yaml);
  await expect(page.getByTestId("config-valid")).toBeVisible();
  await page.getByTestId("config-apply").click();
  await expect(page.getByTestId("config-drawer")).toBeHidden();
}

async function expectStoredField(page: Page, key: string, value: unknown): Promise<void> {
  await expect
    .poll(async () => (await readStoredSession(page))?.[key], { timeout: 5_000 })
    .toEqual(value);
}

// ---------------------------------------------------------------------------
// Persistence: option / code / theme / font are restored after a reload
// ---------------------------------------------------------------------------

test("restores the saved session (option, code, theme, font) after a reload", async ({ page }) => {
  await openApp(page);

  // Option change (config drawer is the shortest deterministic path).
  await applyConfig(page, "BasedOnStyle: LLVM\nIndentWidth: 7\n");
  await expect(page.getByTestId("modified-count")).toContainText("1 modified");

  // Source edit.
  await setEditorText(page, "source", "int persisted_fn(){return 1;}\n");
  await expectEditorTextContains(page, "output", "int persisted_fn()");

  // Theme + editor font size live in the settings popover.
  await openSettings(page);
  await page.getByTestId("theme-dark").check();
  await page.getByTestId("editor-font-size").selectOption("18");
  await page.keyboard.press("Escape");

  // Persistence is debounced (400 ms); wait for the document instead of sleeping.
  await expectStoredField(page, "editorFontSize", 18);
  await expectStoredField(page, "theme", "dark");
  await expectStoredField(page, "code", "int persisted_fn(){return 1;}\n");

  await page.reload();
  await waitForFormatted(page, "int persisted_fn()");

  // Everything came back from localStorage, not from defaults.
  await expect(page.getByTestId("modified-count")).toContainText("1 modified");
  expect(await readEditorText(page, "source")).toBe("int persisted_fn(){return 1;}\n");
  expect(await readEditorText(page, "output")).toContain("int persisted_fn() { return 1; }");
  expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
  expect(await page.getByTestId("source").evaluate((element) => getComputedStyle(element).fontSize)).toBe("18px");

  // The restored option is part of the configuration again.
  await openDrawer(page);
  await expectEditorText(page, CONFIG_YAML, "BasedOnStyle: LLVM\nIndentWidth: 7\n");
});

// ---------------------------------------------------------------------------
// Persistence: the selected clang-format version is restored too
// ---------------------------------------------------------------------------

test("restores the saved clang-format version after a reload", async ({ page }) => {
  await openApp(page);

  await page.getByLabel("Version").selectOption("18.1.8");
  await expect(page.getByTestId("status")).toContainText("clang-format 18.1.8 ready", { timeout: APP_READY_TIMEOUT });
  await expectEditorTextContains(page, "output", "class Widget {");

  await expectStoredField(page, "version", "18.1.8");

  await page.reload();
  await waitForFormatted(page);

  await expect(page.getByLabel("Version")).toHaveValue("18.1.8");
  await expect(page.getByTestId("status")).toContainText("clang-format 18.1.8");
  await expect(page.getByTestId("status")).toContainText("163 options");
});

// ---------------------------------------------------------------------------
// Corrupt / version-mismatched storage is discarded, app keeps working
// ---------------------------------------------------------------------------

test("discards a corrupt saved session and keeps working", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((key) => localStorage.setItem(key, "{this is not valid json"), STORAGE_KEY);

  await openApp(page);
  const notice = page.getByTestId("notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Saved session was discarded");
  await expect(notice).toContainText(/could not be read/i);
  await page.getByTestId("notice-close").click();
  await expect(notice).toBeHidden();

  // Defaults are in use and the app is fully functional.
  await expect(page.getByLabel("Style")).toHaveValue("LLVM");
  await setEditorText(page, "source", "int ok(){return 1;}\n");
  await expectEditorTextContains(page, "output", "int ok() { return 1; }");
  expect(errors).toEqual([]);
});

test("discards a session from an incompatible state version", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const future = JSON.stringify({
    stateVersion: 999,
    version: "21.1.8",
    style: "GNU",
    modified: {},
    code: "int not_the_sample;",
    theme: "dark",
    editorFontSize: 20,
  });
  await page.addInitScript(
    ({ key, raw }: { key: string; raw: string }) => localStorage.setItem(key, raw),
    { key: STORAGE_KEY, raw: future },
  );

  await openApp(page);
  const notice = page.getByTestId("notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Saved session was discarded");
  await expect(notice).toContainText(/incompatible build/i);
  await page.getByTestId("notice-close").click();
  await expect(notice).toBeHidden();

  // The incompatible document (GNU / int not_the_sample) was not applied.
  await expect(page.getByLabel("Style")).toHaveValue("LLVM");
  expect(await readEditorText(page, "source")).toContain("class Widget{public:");
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// Theme: explicit choice overrides the system preference and persists
// ---------------------------------------------------------------------------

test("theme choice overrides the system preference and persists", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openApp(page);

  const DARK_BG = "rgb(15, 18, 22)";
  const LIGHT_BG = "rgb(246, 247, 249)";
  const themeState = () =>
    page.evaluate(() => ({
      attr: document.documentElement.getAttribute("data-theme"),
      inline: document.documentElement.style.colorScheme,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    }));

  // "system" follows the emulated dark preference: no override attributes.
  await expect.poll(async () => (await themeState()).attr).toBeNull();
  expect(await themeState()).toEqual({ attr: null, inline: "", bodyBg: DARK_BG });

  await openSettings(page);
  await page.getByTestId("theme-light").check();
  await expect.poll(async () => (await themeState()).attr).toBe("light");
  expect(await themeState()).toEqual({ attr: "light", inline: "light", bodyBg: LIGHT_BG });

  await page.getByTestId("theme-dark").check();
  await expect.poll(async () => (await themeState()).attr).toBe("dark");
  expect(await themeState()).toEqual({ attr: "dark", inline: "dark", bodyBg: DARK_BG });

  // An explicit choice is persisted (and pre-painted before first paint).
  await expectStoredField(page, "theme", "dark");
  await page.reload();
  await waitForFormatted(page);
  expect(await themeState()).toEqual({ attr: "dark", inline: "dark", bodyBg: DARK_BG });

  // Back to "system": the attributes are removed and the dark OS preference wins.
  await openSettings(page);
  await expect(page.getByTestId("theme-dark")).toBeChecked();
  await page.getByTestId("theme-system").check();
  await expect.poll(async () => (await themeState()).attr).toBeNull();
  expect(await themeState()).toEqual({ attr: null, inline: "", bodyBg: DARK_BG });
});

// ---------------------------------------------------------------------------
// Settings popover: Escape / outside click / focus restoration, radio names
// ---------------------------------------------------------------------------

test("settings menu closes with Escape or an outside click and restores focus", async ({ page }) => {
  await openApp(page);
  const toggle = page.getByTestId("settings-toggle");
  const menu = page.getByTestId("settings-menu");

  await expect(toggle).toHaveAttribute("aria-haspopup", "dialog");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toHaveCount(0);

  await openSettings(page);
  await expect(menu).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  // Opening moves focus to the checked theme radio.
  await expect(page.getByTestId("theme-system")).toBeChecked();
  await expect(page.getByTestId("theme-system")).toBeFocused();
  await expect(page.getByRole("radio", { name: "Light" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Dark" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();

  await openSettings(page);
  await page.mouse.click(10, 10); // header brand, outside the popover
  await expect(menu).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

// ---------------------------------------------------------------------------
// Responsive: mobile Options / Code tabs
// ---------------------------------------------------------------------------

test("mobile tabs switch between options and code at 390 px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await openApp(page);

  const optionsTab = page.getByTestId("tab-options");
  const codeTab = page.getByTestId("tab-code");
  await expect(optionsTab).toBeVisible();
  await expect(codeTab).toBeVisible();
  await expect(codeTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("source")).toBeVisible();
  await expect(page.getByTestId("options-search")).toBeHidden();

  await optionsTab.click();
  await expect(optionsTab).toHaveAttribute("aria-selected", "true");
  await expect(codeTab).toHaveAttribute("aria-selected", "false");
  await expect(page.getByTestId("options-search")).toBeVisible();
  await expect(page.getByTestId("source")).toBeHidden();

  await codeTab.click();
  await expect(codeTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("source")).toBeVisible();

  // Arrow keys move the selection and the focus together.
  await codeTab.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(optionsTab).toHaveAttribute("aria-selected", "true");
  await expect(optionsTab).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(codeTab).toHaveAttribute("aria-selected", "true");
  await expect(codeTab).toBeFocused();
});

test("desktop layout has no options/code tabs", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page);

  await expect(page.getByTestId("tab-options")).toHaveCount(0);
  await expect(page.getByTestId("tab-code")).toHaveCount(0);
  // Both panels are visible side by side.
  await expect(page.getByTestId("options-panel")).toBeVisible();
  await expect(page.getByTestId("source")).toBeVisible();

  // Resizing down to mobile mounts the tabs (matchMedia state is live).
  await page.setViewportSize({ width: 390, height: 780 });
  await expect(page.getByTestId("tab-options")).toBeVisible();
  await expect(page.getByTestId("tab-code")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByTestId("tab-options")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Skip link
// ---------------------------------------------------------------------------

test("skip link moves keyboard focus into the main content", async ({ page }) => {
  await openApp(page);

  await page.evaluate(() => document.body.focus());
  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Skip to content" });
  await expect(skipLink).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
  await expect.poll(() => page.evaluate(() => document.querySelector("#main")?.matches(":target") ?? false)).toBe(
    true,
  );
  // Following the link moves the focus navigation start point to #main: the
  // next Tab lands on the first control inside it.
  await page.keyboard.press("Tab");
  await expect.poll(() =>
    page.evaluate(() => {
      const main = document.querySelector("#main");
      const active = document.activeElement;
      return main !== null && active !== null && main.contains(active);
    }),
  ).toBe(true);
  await expect(page.getByTestId("options-search")).toBeFocused();
});

// ---------------------------------------------------------------------------
// Offline: the service worker serves the cached app and wasm without network
// ---------------------------------------------------------------------------

test("service worker keeps the app and formatter working offline", async ({ page, context }) => {
  test.setTimeout(90_000);
  await openApp(page);

  const supported = await page.evaluate(
    () => typeof navigator.serviceWorker !== "undefined" && window.isSecureContext,
  );
  test.skip(!supported, "service workers need a secure context (https or localhost)");

  // The worker installs, activates and claims its clients on the first visit.
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state ?? null), { timeout: 20_000 })
    .toBe("activated");

  // One controlled reload: every asset is now fetched through the service
  // worker, which caches it for offline use.
  await page.reload();
  await waitForFormatted(page);

  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const entries: string[] = [];
          for (const name of await caches.keys()) {
            const cache = await caches.open(name);
            for (const request of await cache.keys()) entries.push(new URL(request.url).pathname);
          }
          return {
            hasShell: entries.some((path) => path.endsWith("/") || path.endsWith("/index.html")),
            hasWasmEntry: entries.some((path) => path.includes("/wasm/21.1.8/entry.js")),
            hasWasmBinary: entries.some((path) => path.endsWith(".wasm")),
          };
        }),
      { timeout: 20_000 },
    )
    .toEqual({ hasShell: true, hasWasmEntry: true, hasWasmBinary: true });

  await context.setOffline(true);
  try {
    await expect(page.getByTestId("offline-banner")).toBeVisible();

    // Full offline reload: navigation is served from the cache, the wasm
    // worker still formats, and the offline banner explains the state.
    await page.reload();
    await waitForFormatted(page);
    await expect(page.getByTestId("offline-banner")).toBeVisible();
    await expect(page.getByTestId("status")).toContainText("clang-format 21.1.8 ready");
  } finally {
    await context.setOffline(false);
  }
});

// ---------------------------------------------------------------------------
// A11y semantics smoke: names, states, labelled dialogs, live region
// ---------------------------------------------------------------------------

test("a11y semantics: names, states and labelled dialogs", async ({ page }) => {
  await openApp(page);

  // Search input and filter chips expose names and pressed state.
  await expect(page.getByRole("searchbox", { name: "Search options" })).toBeVisible();
  const modifiedChip = page.getByTestId("filter-modified");
  const allChip = page.getByTestId("filter-all");
  await expect(modifiedChip).toHaveAttribute("aria-pressed", "false");
  await expect(allChip).toHaveAttribute("aria-pressed", "true");
  await modifiedChip.click();
  await expect(modifiedChip).toHaveAttribute("aria-pressed", "true");
  await expect(allChip).toHaveAttribute("aria-pressed", "false");
  await allChip.click();
  await expect(allChip).toHaveAttribute("aria-pressed", "true");

  // Docs disclosure exposes aria-expanded and an accessible name.
  await page.getByTestId("options-search").fill("IndentWidth");
  const docs = page.getByTestId("docs-IndentWidth");
  await expect(docs).toBeVisible({ timeout: 15_000 });
  await expect(docs).toHaveAttribute("aria-label", "Docs for IndentWidth");
  await expect(docs).toHaveAttribute("aria-expanded", "false");
  await docs.click();
  await expect(docs).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("docs-content-IndentWidth")).toContainText(/indent/i, { timeout: 15_000 });

  // Live region for the formatting status.
  const live = page.getByTestId("live-status");
  await expect(live).toHaveAttribute("role", "status");
  await expect(live).toHaveAttribute("aria-live", "polite");
  await expect(live).toContainText("Formatted output updated");

  // Modal dialog is labelled by its visible title.
  await page.getByTestId("open-import").click();
  const dialog = page.getByTestId("config-dialog");
  const dialogLabel = await dialog.getAttribute("aria-labelledby");
  expect(dialogLabel).not.toBeNull();
  await expect(page.locator(`#${dialogLabel}`)).toBeVisible();
  await expect(page.locator(`#${dialogLabel}`)).toHaveText("Configuration");
  await expect(page.getByRole("dialog", { name: "Configuration" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // The configuration drawer is labelled the same way.
  await openDrawer(page);
  const drawer = page.getByTestId("config-drawer");
  const drawerLabel = await drawer.getAttribute("aria-labelledby");
  expect(drawerLabel).not.toBeNull();
  await expect(page.locator(`#${drawerLabel}`)).toBeVisible();
  await expect(page.locator(`#${drawerLabel}`)).toHaveText("Configuration");
});
