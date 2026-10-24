// Install prompt plumbing for the PWA (M4, plan §9 "PWA + 安装提示").
//
// The browser fires `beforeinstallprompt` when the app is installable; the app
// can only call `prompt()` while it holds that event, so it must be captured
// early and kept. This module owns that state:
//
//   - capture `beforeinstallprompt` → remember the event, expose `canInstall`
//   - `promptInstall()` → show the browser's install dialog, report the choice
//   - `appinstalled` / standalone display mode → `installed` (hide the banner)
//   - `dismiss()` → persist the dismissal so the banner does not nag on reload
//
// There is no React here: the environment is injectable, so the whole lifecycle
// is unit-tested in node (`install.test.ts`). `InstallBanner.tsx` is the thin
// React view; `getInstallController()` is the browser singleton it uses.

/** Storage key for the persisted "user closed the install banner" flag. */
export const INSTALL_DISMISSED_KEY = "clang-format-configurator:install-dismissed";

/** Subset of the non-standard `BeforeInstallPromptEvent` we rely on. */
export type BeforeInstallPromptEventLike = {
  prompt(): Promise<void>;
  readonly userChoice?: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  preventDefault?(): void;
};

/** Result of asking the browser to install the app. */
export type InstallOutcome = "accepted" | "dismissed" | "unavailable";

/** Snapshot used by the UI. */
export type InstallState = {
  /** A `beforeinstallprompt` event is pending, so the banner may be shown. */
  canInstall: boolean;
  /** The app is already installed (standalone display mode or `appinstalled`). */
  installed: boolean;
  /** The user dismissed the banner; persisted across visits. */
  dismissed: boolean;
};

/** Minimal event target (usually `window`) for the PWA events. */
export type InstallEventTarget = {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
};

/** Minimal storage (usually `localStorage`); `null` when unavailable. */
export type InstallStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** Everything the controller needs from the browser (injectable for tests). */
export type InstallEnvironment = {
  eventTarget: InstallEventTarget;
  /** `null` when storage is unavailable (private mode, disabled cookies). */
  storage: InstallStorage | null;
  /** Already running as an installed app (`display-mode: standalone`). */
  isStandalone: boolean;
};

export type InstallController = {
  getState(): InstallState;
  /** Notify on every state change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * Ask the browser to install the app. Returns `"unavailable"` when no
   * `beforeinstallprompt` event is pending or the prompt was already used.
   */
  promptInstall(): Promise<InstallOutcome>;
  /** Hide the banner for good (persisted) and drop the pending prompt. */
  dismiss(): void;
  /** Detach every browser listener. Does not clear the stored dismissal. */
  dispose(): void;
};

function readDismissed(storage: InstallStorage | null): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(INSTALL_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(storage: InstallStorage | null): void {
  if (storage === null) return;
  try {
    storage.setItem(INSTALL_DISMISSED_KEY, "1");
  } catch {
    // Storage full or disabled: the banner still stays closed for this visit.
  }
}

function isPromptEvent(value: unknown): value is BeforeInstallPromptEventLike {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as { prompt?: unknown }).prompt === "function";
}

/**
 * Create an install controller for an injected environment. Exported for tests
 * and for embedders; the app itself uses `getInstallController()`.
 */
export function createInstallController(environment: InstallEnvironment): InstallController {
  const listeners = new Set<() => void>();
  let disposed = false;
  /** The captured `beforeinstallprompt` event, consumed by `promptInstall()`. */
  let deferred: BeforeInstallPromptEventLike | null = null;
  let state: InstallState = {
    canInstall: false,
    installed: environment.isStandalone,
    dismissed: readDismissed(environment.storage),
  };

  const notify = (patch: Partial<InstallState>): void => {
    if (disposed) return;
    const next: InstallState = { ...state, ...patch };
    if (
      next.canInstall === state.canInstall &&
      next.installed === state.installed &&
      next.dismissed === state.dismissed
    ) {
      return;
    }
    state = next;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A throwing subscriber must not break the browser event handlers.
      }
    }
  };

  const handleBeforeInstallPrompt = (event: unknown): void => {
    if (!isPromptEvent(event)) return;
    // Keep the event so install can be triggered from our own button, and stop
    // the browser from showing its default install UI on top of the banner.
    try {
      event.preventDefault?.();
    } catch {
      // Ignore: not every browser implements preventDefault on this event.
    }
    // A dismissal (or an existing install) suppresses the banner; drop the
    // event too so a hidden banner cannot install the app later.
    if (state.installed || state.dismissed) return;
    deferred = event;
    notify({ canInstall: true });
  };

  const handleAppInstalled = (): void => {
    deferred = null;
    notify({ canInstall: false, installed: true });
  };

  environment.eventTarget.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  environment.eventTarget.addEventListener("appinstalled", handleAppInstalled);

  return {
    getState(): InstallState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async promptInstall(): Promise<InstallOutcome> {
      const promptEvent = deferred;
      if (disposed || promptEvent === null) return "unavailable";
      // The event works once; drop it before awaiting so a double click cannot
      // call prompt() twice.
      deferred = null;
      notify({ canInstall: false });

      try {
        await promptEvent.prompt();
      } catch {
        return "unavailable";
      }

      let outcome: InstallOutcome = "dismissed";
      try {
        const choice = await promptEvent.userChoice;
        if (choice?.outcome === "accepted") outcome = "accepted";
      } catch {
        // `userChoice` rejects when the prompt is dismissed by the browser;
        // treat it as a dismissal instead of surfacing an error.
      }
      if (outcome === "accepted") notify({ installed: true });
      return outcome;
    },

    dismiss(): void {
      if (disposed) return;
      // Dropping the pending event keeps promptInstall() from installing after
      // the user explicitly said "no" to the banner.
      deferred = null;
      writeDismissed(environment.storage);
      notify({ canInstall: false, dismissed: true });
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      environment.eventTarget.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      environment.eventTarget.removeEventListener("appinstalled", handleAppInstalled);
    },
  };
}

/** True when the page is already running as an installed app. */
function detectStandalone(): boolean {
  try {
    if (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) {
      return true;
    }
  } catch {
    // matchMedia can be missing or throw in unusual embeddings; fall through.
  }
  // iOS Safari exposes `navigator.standalone` instead of display-mode.
  const navigatorLike = window.navigator as Navigator & { standalone?: boolean };
  return navigatorLike.standalone === true;
}

/** `localStorage`, or null when it is unavailable (private mode, no cookies…). */
function detectStorage(): InstallStorage | null {
  try {
    const storage = window.localStorage;
    const probeKey = `${INSTALL_DISMISSED_KEY}:probe`;
    storage.setItem(probeKey, "1");
    storage.removeItem(probeKey);
    return storage;
  } catch {
    return null;
  }
}

/** Build the browser environment, or null outside a browser. */
export function createBrowserInstallEnvironment(): InstallEnvironment | null {
  if (typeof window === "undefined") return null;
  return {
    eventTarget: {
      addEventListener: (type, listener) => window.addEventListener(type, listener as EventListener),
      removeEventListener: (type, listener) => window.removeEventListener(type, listener as EventListener),
    },
    storage: detectStorage(),
    isStandalone: detectStandalone(),
  };
}

let browserController: InstallController | null = null;

/**
 * The install controller for this page, created on first use. Returns null in
 * non-browser environments (unit tests, SSR). Call it as early as possible
 * (e.g. from `main.tsx`) so `beforeinstallprompt` is not missed.
 */
export function getInstallController(): InstallController | null {
  if (browserController !== null) return browserController;
  const environment = createBrowserInstallEnvironment();
  if (environment === null) return null;
  browserController = createInstallController(environment);
  return browserController;
}

/** Reset the lazy browser singleton (tests only). */
export function resetInstallControllerForTests(): void {
  browserController?.dispose();
  browserController = null;
}

/** True when the install banner should be rendered for this state. */
export function shouldShowInstallBanner(state: InstallState): boolean {
  return state.canInstall && !state.installed && !state.dismissed;
}
