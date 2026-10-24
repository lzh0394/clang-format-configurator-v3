import { expect, test, type Page } from "@playwright/test";

import { APP_READY_TIMEOUT, openApp } from "./helpers";

// M4 acceptance (plan §9 items 2 and 3): the PWA layer (manifest + icons,
// service-worker precache, install banner) and the extra filename/language
// mappings. Plain browser tests only; no wasm byte comparisons here.
//
// The suite uses the production build served by `vite preview` (see
// playwright.config.ts), so the service worker is registered. `page.goto("./")`
// keeps the deployment sub-path from baseURL, which also exercises the relative
// manifest/icon URLs on GitHub Pages.

const DISMISSED_KEY = "clang-format-configurator:install-dismissed";

type ManifestIcon = {
  src?: string;
  sizes?: string;
  type?: string;
  purpose?: string;
};

type WebManifest = {
  name?: string;
  short_name?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  theme_color?: string;
  background_color?: string;
  icons?: ManifestIcon[];
};

/** Absolute URL the page advertises for its web app manifest. */
async function manifestUrl(page: Page): Promise<string> {
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href, "index.html must link the web app manifest").not.toBeNull();
  return page.evaluate((value) => new URL(value, document.baseURI).href, href ?? "");
}

/**
 * Dispatch a synthetic `beforeinstallprompt` event. Chromium/Edge may or may
 * not fire a real one for a preview URL, so the tests never depend on the
 * browser's installability heuristics: they simulate the event and check the
 * app's reaction. The handler in src/pwa/install.ts only needs `prompt()`,
 * `userChoice` and `preventDefault()`, which a plain `Event` can carry.
 */
async function dispatchBeforeInstallPrompt(
  page: Page,
  outcome: "accepted" | "dismissed" = "accepted",
): Promise<void> {
  await page.evaluate((choice) => {
    const event = new Event("beforeinstallprompt") as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: string; platform: string }>;
    };
    Object.assign(event, {
      prompt: () => Promise.resolve(),
      userChoice: Promise.resolve({ outcome: choice, platform: "web" }),
    });
    window.dispatchEvent(event);
  }, outcome);
}

/** Wait until the app is interactive after a (non-`goto`) navigation. */
async function waitForAppShell(page: Page): Promise<void> {
  await expect(page.getByTestId("options-panel")).toBeAttached({ timeout: APP_READY_TIMEOUT });
}

test.describe("PWA manifest and icons", () => {
  test("serves a valid manifest whose URLs stay inside the deployed scope", async ({ page }) => {
    await openApp(page);

    const href = await manifestUrl(page);
    const manifestResponse = await page.request.get(href);
    expect(manifestResponse.ok(), href).toBe(true);
    expect(manifestResponse.headers()["content-type"] ?? "").toMatch(/manifest|json/i);

    const manifest = (await manifestResponse.json()) as WebManifest;

    expect(manifest.name?.trim().length ?? 0).toBeGreaterThan(0);
    expect(manifest.short_name?.trim().length ?? 0).toBeGreaterThan(0);
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);

    // Relative start_url/scope are what make the manifest safe under
    // `/<repo>/`; resolve them and check they stay inside the app directory.
    const appDirectory = new URL("./", page.url());
    // "." and "./" are equivalent here; the app may emit either.
    expect(manifest.start_url ?? "").toMatch(/^\.\/?$/u);
    expect(manifest.scope ?? "").toMatch(/^\.\/?$/u);
    for (const relative of [manifest.start_url, manifest.scope]) {
      const resolved = new URL(relative ?? "", href);
      expect(resolved.origin).toBe(appDirectory.origin);
      expect(resolved.pathname).toBe(appDirectory.pathname);
    }

    // 192 + 512 (+ a maskable variant) must be present, and every icon must be
    // a real PNG that is small enough to precache (plan M4: < 30 KB per file).
    const icons = manifest.icons ?? [];
    expect(icons.length).toBeGreaterThanOrEqual(3);
    const sizes = icons.map((icon) => icon.sizes ?? "");
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(icons.some((icon) => (icon.purpose ?? "").includes("maskable"))).toBe(true);

    for (const icon of icons) {
      expect(icon.src, "every manifest icon needs a src").toBeTruthy();
      const iconUrl = new URL(icon.src ?? "", href).href;
      const iconResponse = await page.request.get(iconUrl);
      expect(iconResponse.ok(), iconUrl).toBe(true);
      expect(iconResponse.headers()["content-type"] ?? "", iconUrl).toContain("image/png");
      const body = await iconResponse.body();
      expect(body.byteLength, iconUrl).toBeGreaterThan(0);
      expect(body.byteLength, iconUrl).toBeLessThan(30 * 1024);
    }

    // index.html must also advertise the iOS icon and the light/dark
    // theme-color pair (the theme script stays untouched above them).
    const appleHref = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
    expect(appleHref).not.toBeNull();
    const appleUrl = await page.evaluate((value) => new URL(value, document.baseURI).href, appleHref ?? "");
    const appleResponse = await page.request.get(appleUrl);
    expect(appleResponse.ok(), appleUrl).toBe(true);
    expect(appleResponse.headers()["content-type"] ?? "").toContain("image/png");

    const themeColors = await page.locator('meta[name="theme-color"]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("content") ?? ""),
    );
    expect(themeColors.length).toBeGreaterThanOrEqual(2);
    for (const color of themeColors) expect(color).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

test.describe("service worker precache", () => {
  test("caches the manifest, icons and favicon for offline installs", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page);

    const supported = await page.evaluate(
      () => typeof navigator.serviceWorker !== "undefined" && window.isSecureContext,
    );
    test.skip(!supported, "service workers need a secure context (https or localhost)");

    // install → activate → claim, then one controlled reload so the worker
    // serves (and re-caches) every asset.
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state ?? null), { timeout: 20_000 })
      .toBe("activated");
    await page.reload();
    await waitForAppShell(page);

    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const paths: string[] = [];
            for (const name of await caches.keys()) {
              const cache = await caches.open(name);
              for (const request of await cache.keys()) paths.push(new URL(request.url).pathname);
            }
            const has = (suffix: string): boolean => paths.some((path) => path.endsWith(suffix));
            return {
              manifest: has("/manifest.json"),
              icon192: has("/icons/icon-192.png"),
              icon512: has("/icons/icon-512.png"),
              maskable: has("/icons/icon-maskable-512.png"),
              appleTouch: has("/icons/apple-touch-icon-180.png"),
              favicon: has("/favicon.svg"),
            };
          }),
        { timeout: 20_000 },
      )
      .toEqual({
        manifest: true,
        icon192: true,
        icon512: true,
        maskable: true,
        appleTouch: true,
        favicon: true,
      });
  });
});

test.describe("install banner", () => {
  test("appears after beforeinstallprompt and hides when the install is accepted", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await openApp(page);
    const banner = page.getByTestId("install-banner");
    await dispatchBeforeInstallPrompt(page, "accepted");

    await expect(banner).toBeVisible();
    await expect(page.getByTestId("install-button")).toHaveText("Install");
    await expect(page.getByTestId("install-button")).toHaveAttribute("aria-busy", "false");

    await page.getByTestId("install-button").click();
    // An accepted install marks the app as installed, so the banner goes away.
    await expect(banner).toBeHidden();
    expect(pageErrors).toEqual([]);
  });

  test("dismissing the banner is remembered across reloads", async ({ page }) => {
    await openApp(page);
    const banner = page.getByTestId("install-banner");

    await dispatchBeforeInstallPrompt(page, "accepted");
    await expect(banner).toBeVisible();
    await page.getByTestId("install-dismiss").click();
    await expect(banner).toBeHidden();

    expect(await page.evaluate((key) => localStorage.getItem(key), DISMISSED_KEY)).toBe("1");

    await page.reload();
    await waitForAppShell(page);

    // A fresh prompt event must not bring the banner back: the dismissal is
    // persisted in localStorage.
    await dispatchBeforeInstallPrompt(page, "accepted");
    await expect(banner).toBeHidden();
    expect(await page.evaluate((key) => localStorage.getItem(key), DISMISSED_KEY)).toBe("1");
  });
});

test.describe("M4 language badge", () => {
  test("filename extensions added in M4 show the right language badge", async ({ page }) => {
    await openApp(page);
    const badge = page.getByTestId("language");
    const filename = page.getByLabel("Filename");

    const cases = [
      ["Program.cs", "C#"],
      ["service.proto", "Protobuf"],
      ["Main.kt", "Kotlin"],
      ["view.mm", "Objective-C++"],
      ["app.tsx", "TypeScript"],
      ["app.jsx", "JavaScript"],
    ] as const;

    for (const [name, label] of cases) {
      await filename.fill(name);
      await expect(badge, name).toHaveText(label);
    }
  });
});
