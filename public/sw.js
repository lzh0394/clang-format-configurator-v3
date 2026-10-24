/*
 * Hand-written classic service worker for the clang-format configurator.
 *
 * Vite copies public/sw.js verbatim into dist/sw.js, so ES module syntax and
 * imports are NOT allowed here. The app is published under a sub-path on GitHub
 * Pages project sites (plan §8.1), so every URL is derived from
 * `self.registration.scope` (e.g. `https://host/<repo>/`) — never hard-code "/".
 *
 * Policy:
 *   install   precache the app shell (scope root) + manifest + icons + favicon;
 *             do NOT skipWaiting, updates wait until the page asks them to
 *             activate.
 *   activate  delete stale `cfc-*` caches, then claim clients.
 *   fetch     navigations: network-first, cached shell fallback, then a tiny
 *             synthetic offline page.
 *             same-origin GET assets: cache-first with background revalidation.
 *             cross-origin / non-GET / range requests are left to the browser.
 *   message   { type: "SKIP_WAITING" } activates a waiting worker.
 *
 * Bump CACHE_VERSION whenever this file or the app shell changes; the activate
 * handler removes every older cache that starts with CACHE_PREFIX.
 */
"use strict";

const CACHE_PREFIX = "cfc-";
// v2 (M4): the manifest and the PWA icons joined the precache list.
const CACHE_VERSION = "v2";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;

/**
 * Static files copied verbatim from public/ next to index.html: the web app
 * manifest and the icons it references (plus the favicon). Each is resolved
 * against the registration scope so sub-path deployments keep working.
 */
const SHELL_ASSETS = [
  "manifest.json",
  "favicon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon-180.png",
];

const OFFLINE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>Offline — clang-format configurator</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      main { max-width: 36rem; padding: 2rem; }
      h1 { font-size: 1.35rem; margin: 0 0 0.75rem; }
      p { margin: 0 0 1rem; }
      ul { margin: 0 0 1.25rem; padding-left: 1.25rem; }
      li { margin: 0.15rem 0; }
      button { font: inherit; padding: 0.5rem 1rem; border-radius: 0.375rem; cursor: pointer; }
      .hint { opacity: 0.75; font-size: 0.9rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>You are offline</h1>
      <p>
        The clang-format configurator runs entirely in your browser, so it keeps
        working without a network connection — but this device has not stored a
        copy of the app yet.
      </p>
      <p>Once the page has loaded one time, the following work offline:</p>
      <ul>
        <li>generating and importing <code>.clang-format</code> configurations,</li>
        <li>formatting code with clang-format versions that were already used,</li>
        <li>your saved session (options, code, theme), restored from this device.</li>
      </ul>
      <p class="hint">
        Reconnect to the network and reload to store the offline copy. After
        that you can also install the configurator as an app from your browser
        menu.
      </p>
      <button type="button" onclick="location.reload()">Try again</button>
    </main>
  </body>
</html>`;

/** Absolute URL of the registration scope: `https://host/<repo>/`. */
function scopeUrl() {
  return new URL(self.registration.scope);
}

/** App shell URL: the scope root (trailing slash), derived from the scope. */
function rootUrl() {
  return new URL("./", scopeUrl()).href;
}

/** Absolute URL of a static file that lives next to index.html. */
function assetUrl(path) {
  return new URL(path, scopeUrl()).href;
}

/** True when a fetch response may be stored in our cache. */
function isCacheableResponse(response) {
  if (!response || !response.ok) return false;
  // Opaque/redirect responses cannot be inspected and are useless for revalidation.
  if (response.type === "opaque" || response.type === "opaqueredirect") return false;
  if (response.status === 206) return false; // partial content
  const cacheControl = response.headers.get("cache-control") || "";
  return !cacheControl.includes("no-store");
}

/** Minimal standalone page shown when a navigation fails and nothing is cached. */
function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 200,
    statusText: "OK",
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function cachedRoot() {
  const cache = await caches.open(CACHE_NAME);
  return (await cache.match(rootUrl())) || undefined;
}

/**
 * Navigation requests: try the network first (deploys stay fresh), fall back to
 * the precached shell, and only then show the synthetic offline page.
 */
async function handleNavigation(event) {
  const request = event.request;
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      // Keep the latest app shell around so an offline reload still renders.
      const cache = await caches.open(CACHE_NAME);
      await cache.put(rootUrl(), response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cached = await cachedRoot();
    return cached || offlineResponse();
  }
}

/**
 * Same-origin assets: cache-first, then revalidate in the background
 * (stale-while-revalidate). `event.waitUntil` keeps the worker alive until the
 * refresh settles; the promise never rejects, so a failed revalidation is not
 * surfaced as an unhandled rejection.
 */
function handleAsset(event) {
  const request = event.request;
  const cached = caches.open(CACHE_NAME).then((cache) => cache.match(request));
  const refresh = fetch(request)
    .then(async (response) => {
      if (!isCacheableResponse(response)) return response;
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  event.waitUntil(refresh.then(() => undefined));

  return (async () => {
    const hit = await cached;
    if (hit) return hit;
    const response = await refresh;
    if (response) return response;
    // Cache miss while offline: let the caller fail fast instead of hanging.
    return new Response("", { status: 504, statusText: "Gateway Timeout" });
  })();
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const shell = rootUrl();
      // Precache individually: a missing icon must not fail the installation.
      // The first entry is the shell, the rest are PWA assets (manifest, icons).
      const urls = [shell, ...SHELL_ASSETS.map(assetUrl)];
      const results = await Promise.all(
        urls.map((url) =>
          cache
            .add(new Request(url, { cache: "reload" }))
            .then(() => true)
            .catch(() => false),
        ),
      );
      if (!results[0]) console.warn("[sw] could not precache the app shell", shell);
      SHELL_ASSETS.forEach((path, index) => {
        if (!results[index + 1]) console.warn("[sw] could not precache", path);
      });
      // No self.skipWaiting() here: the page decides when an update activates.
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "SKIP_WAITING") return;
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.headers.has("range")) return; // partial content stays on the network

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return; // cross-origin: browser default
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(event));
  } else {
    event.respondWith(handleAsset(event));
  }
});
