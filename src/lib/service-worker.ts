// Registration + update lifecycle for the hand-written service worker in
// public/sw.js (plan §7 "Service Worker 已缓存该版本 → 完全离线可用", §9 M3 离线).
//
// Every URL is derived from `import.meta.env.BASE_URL` (never a hard-coded "/"),
// because the app is served from `/<repo>/` on GitHub Pages project sites.
//
// The public entry point is `registerServiceWorker()`; the lifecycle core takes
// an injectable environment so it can be unit-tested in node without DOM or a
// real service worker.

export type ServiceWorkerHandle = {
  /**
   * Activate a waiting update and reload the page once the new worker takes
   * control (via `controllerchange`). No-op when nothing is waiting.
   */
  applyUpdate(): void;
  /** Stop reacting to worker/browser events. Does not unregister the worker. */
  dispose(): void;
};

export type RegisterServiceWorkerOptions = {
  /** A new version finished installing and waits for the UI to activate it. */
  onUpdateReady?: () => void;
  /** Browser connectivity changed: `true` = offline, `false` = back online. */
  onOfflineChange?: (offline: boolean) => void;
};

/** Subset of `ServiceWorker` the registration logic needs (injectable). */
export type ServiceWorkerLike = {
  readonly state: string;
  postMessage(message: unknown): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

/** Subset of `ServiceWorkerRegistration` the registration logic needs. */
export type ServiceWorkerRegistrationLike = {
  readonly scope: string;
  readonly active: ServiceWorkerLike | null;
  readonly waiting: ServiceWorkerLike | null;
  readonly installing: ServiceWorkerLike | null;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

/** Subset of `ServiceWorkerContainer` the registration logic needs. */
export type ServiceWorkerContainerLike = {
  readonly controller: ServiceWorkerLike | null;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  register(scriptUrl: string, options: { scope: string }): Promise<ServiceWorkerRegistrationLike>;
};

/** Minimal event target (usually `window`) for the online/offline listeners. */
export type EventTargetLike = {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

/**
 * Everything the registration lifecycle needs from the browser. Exported so
 * tests can drive the full update/offline flow without a DOM.
 */
export type ServiceWorkerEnvironment = {
  /** Vite `BASE_URL`: "/" locally, "/<repo>/" on GitHub Pages. */
  baseUrl: string;
  /** Absolute URL of the page, used to resolve the relative scope. */
  href: string;
  /** `navigator.onLine` when registration started. */
  isOnline: boolean;
  /** Service workers require HTTPS (or localhost); checked by the caller too. */
  isSecureContext: boolean;
  container: ServiceWorkerContainerLike;
  /** Receives `online` / `offline` events; usually `window`. */
  eventTarget: EventTargetLike;
  /** Usually `window.location.reload`. */
  reload(): void;
};

let warnedOnce = false;

function warnOnce(message: string, error?: unknown): void {
  if (warnedOnce) return;
  warnedOnce = true;
  try {
    console.warn(`[service-worker] ${message}`, error);
  } catch {
    // `console` is not guaranteed in every embedding; never let logging throw.
  }
}

/** Keep the base path in the form a scope needs: "/" or "/<repo>/". */
function normalizeBase(base: string): string {
  if (base === "") return "/";
  return base.endsWith("/") ? base : `${base}/`;
}

/**
 * URL of the service worker script for a Vite base path:
 * `"/"` → `"/sw.js"`, `"/<repo>/"` → `"/<repo>/sw.js"`.
 * The file is copied verbatim from `public/`, so it is always served next to
 * the app shell. A missing trailing slash is normalized.
 */
export function serviceWorkerUrl(base: string): string {
  return `${normalizeBase(base)}sw.js`;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * True when `url` is an http(s) URL on the same origin as `scope` and inside
 * the scope path (both must be absolute; browsers report the registration scope
 * as an absolute URL). Used to sanity-check the registered scope and to test
 * the sub-path rules without a DOM.
 */
export function isSameOriginScope(url: string, scope: string): boolean {
  const target = parseUrl(url);
  const base = parseUrl(scope);
  if (target === null || base === null) return false;
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  if (target.origin !== base.origin) return false;
  const scopePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  return target.pathname.startsWith(scopePath);
}

/** True when a newly installed worker waits to replace the active one. */
export function hasWaitingUpdate(
  registration: Pick<ServiceWorkerRegistrationLike, "active" | "waiting">,
): boolean {
  return registration.active !== null && registration.waiting !== null;
}

// One adapter per live worker: `registration.installing` / `.waiting` return a
// fresh wrapper on every access, and the dedupe in `trackInstalling` relies on
// stable object identity.
const workerAdapters = new WeakMap<ServiceWorker, ServiceWorkerLike>();

function adaptWorker(worker: ServiceWorker): ServiceWorkerLike {
  const existing = workerAdapters.get(worker);
  if (existing !== undefined) return existing;
  const adapter: ServiceWorkerLike = {
    get state(): string {
      return worker.state;
    },
    postMessage: (message) => worker.postMessage(message),
    addEventListener: (type, listener) => worker.addEventListener(type, listener as EventListener),
    removeEventListener: (type, listener) =>
      worker.removeEventListener(type, listener as EventListener),
  };
  workerAdapters.set(worker, adapter);
  return adapter;
}

function adaptRegistration(registration: ServiceWorkerRegistration): ServiceWorkerRegistrationLike {
  return {
    get scope(): string {
      return registration.scope;
    },
    get active(): ServiceWorkerLike | null {
      return registration.active === null ? null : adaptWorker(registration.active);
    },
    get waiting(): ServiceWorkerLike | null {
      return registration.waiting === null ? null : adaptWorker(registration.waiting);
    },
    get installing(): ServiceWorkerLike | null {
      return registration.installing === null ? null : adaptWorker(registration.installing);
    },
    addEventListener: (type, listener) =>
      registration.addEventListener(type, listener as EventListener),
    removeEventListener: (type, listener) =>
      registration.removeEventListener(type, listener as EventListener),
  };
}

function adaptContainer(container: ServiceWorkerContainer): ServiceWorkerContainerLike {
  return {
    get controller(): ServiceWorkerLike | null {
      return container.controller === null ? null : adaptWorker(container.controller);
    },
    addEventListener: (type, listener) => container.addEventListener(type, listener as EventListener),
    removeEventListener: (type, listener) =>
      container.removeEventListener(type, listener as EventListener),
    register: async (scriptUrl, options) =>
      adaptRegistration(await container.register(scriptUrl, options)),
  };
}

function adaptEventTarget(target: Window): EventTargetLike {
  return {
    addEventListener: (type, listener) => target.addEventListener(type, listener as EventListener),
    removeEventListener: (type, listener) =>
      target.removeEventListener(type, listener as EventListener),
  };
}

/** Browser environment for registration, or null when it cannot work here. */
function detectEnvironment(): ServiceWorkerEnvironment | null {
  if (typeof window === "undefined") return null;
  if (typeof navigator === "undefined") return null;
  const container = (navigator as Partial<Navigator>).serviceWorker;
  if (!container) return null;

  return {
    baseUrl: import.meta.env.BASE_URL,
    href: window.location.href,
    isOnline: typeof navigator.onLine === "boolean" ? navigator.onLine : true,
    isSecureContext: window.isSecureContext === true || window.location.protocol === "https:",
    container: adaptContainer(container),
    eventTarget: adaptEventTarget(window),
    reload: () => window.location.reload(),
  };
}

/**
 * Register the service worker when the app runs as a production build in a
 * secure context. Resolves `null` (never rejects) when service workers are not
 * available, and also when registration fails — offline support is a bonus, not
 * a requirement for the app to work.
 */
export function registerServiceWorker(
  options: RegisterServiceWorkerOptions = {},
): Promise<ServiceWorkerHandle | null> {
  if (!import.meta.env.PROD) return Promise.resolve(null);
  const environment = detectEnvironment();
  if (environment === null) return Promise.resolve(null);
  return createServiceWorkerHandle(environment, options);
}

/**
 * Registration core with an injectable environment (exported for tests).
 * Application code should call `registerServiceWorker`.
 */
export function createServiceWorkerHandle(
  environment: ServiceWorkerEnvironment,
  options: RegisterServiceWorkerOptions = {},
): Promise<ServiceWorkerHandle | null> {
  if (!environment.isSecureContext) return Promise.resolve(null);
  return startRegistration(environment, options).catch((error: unknown) => {
    warnOnce("registration failed", error);
    return null;
  });
}

type ListenerTarget = EventTargetLike;

async function startRegistration(
  environment: ServiceWorkerEnvironment,
  options: RegisterServiceWorkerOptions,
): Promise<ServiceWorkerHandle | null> {
  let registration: ServiceWorkerRegistrationLike;
  try {
    registration = await environment.container.register(serviceWorkerUrl(environment.baseUrl), {
      scope: environment.baseUrl,
    });
  } catch (error) {
    warnOnce("registration failed", error);
    return null;
  }

  let disposed = false;
  /** onUpdateReady already fired (one banner per page load is enough). */
  let updateReady = false;
  /** applyUpdate() posted SKIP_WAITING; the next controllerchange reloads. */
  let reloadRequested = false;
  let reloaded = false;
  const cleanup: Array<() => void> = [];
  const trackedWorkers = new Set<ServiceWorkerLike>();

  const listen = (target: ListenerTarget, type: string, listener: () => void): void => {
    target.addEventListener(type, listener);
    cleanup.push(() => target.removeEventListener(type, listener));
  };

  const notifyUpdateReady = (): void => {
    if (disposed || updateReady) return;
    updateReady = true;
    try {
      options.onUpdateReady?.();
    } catch {
      // A throwing UI callback must not break registration.
    }
  };

  const notifyOffline = (offline: boolean): void => {
    if (disposed) return;
    try {
      options.onOfflineChange?.(offline);
    } catch {
      // A throwing UI callback must not break registration.
    }
  };

  /** Watch one installing worker; only an install over an active worker is an update. */
  const trackInstalling = (worker: ServiceWorkerLike | null): void => {
    if (worker === null || trackedWorkers.has(worker)) return;
    trackedWorkers.add(worker);
    const onStateChange = (): void => {
      if (disposed || worker.state !== "installed") return;
      // `active === null` means this is the first install: nothing to replace.
      if (registration.active === null) return;
      notifyUpdateReady();
    };
    listen(worker, "statechange", onStateChange);
    // The worker may already be installed when registration resolves.
    onStateChange();
  };

  const maybeReload = (): void => {
    if (disposed || !reloadRequested || reloaded) return;
    reloaded = true;
    try {
      environment.reload();
    } catch {
      // Never let a reload failure escape an event listener.
    }
  };

  listen(registration, "updatefound", () => trackInstalling(registration.installing));
  listen(environment.container, "controllerchange", maybeReload);
  listen(environment.eventTarget, "offline", () => notifyOffline(true));
  listen(environment.eventTarget, "online", () => notifyOffline(false));

  // The update may have been found before this module ran (page reloaded while
  // an update was waiting), so check the current registration too.
  trackInstalling(registration.installing);
  if (hasWaitingUpdate(registration)) notifyUpdateReady();
  notifyOffline(!environment.isOnline);

  try {
    const expectedScope = new URL(normalizeBase(environment.baseUrl), environment.href).href;
    if (!isSameOriginScope(registration.scope, expectedScope)) {
      warnOnce(`registered scope ${registration.scope} does not match ${expectedScope}`);
    }
  } catch {
    // A malformed href only costs us the sanity check.
  }

  return {
    applyUpdate(): void {
      if (disposed) return;
      const waiting = registration.waiting;
      if (waiting === null) return;
      reloadRequested = true;
      try {
        waiting.postMessage({ type: "SKIP_WAITING" });
      } catch (error) {
        reloadRequested = false;
        warnOnce("could not message the waiting worker", error);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const remove of cleanup.splice(0)) {
        try {
          remove();
        } catch {
          // Ignore teardown errors; every listener is best-effort.
        }
      }
      trackedWorkers.clear();
    },
  };
}
