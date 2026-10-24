import { describe, expect, it, vi } from "vitest";

import {
  INSTALL_DISMISSED_KEY,
  createBrowserInstallEnvironment,
  createInstallController,
  getInstallController,
  resetInstallControllerForTests,
  shouldShowInstallBanner,
  type BeforeInstallPromptEventLike,
  type InstallController,
  type InstallEnvironment,
  type InstallEventTarget,
  type InstallStorage,
} from "./install";

type Listener = (event: unknown) => void;

class FakeEventTarget implements InstallEventTarget {
  readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set<Listener>();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown = undefined): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeStorage implements InstallStorage {
  readonly values = new Map<string, string>();
  failRead = false;
  failWrite = false;

  getItem(key: string): string | null {
    if (this.failRead) throw new Error("storage read exploded");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrite) throw new Error("storage write exploded");
    this.values.set(key, value);
  }
}

type PromptEventOptions = {
  outcome?: "accepted" | "dismissed";
  promptError?: boolean;
  userChoiceRejects?: boolean;
};

type FakePromptEvent = BeforeInstallPromptEventLike & {
  prompt: ReturnType<typeof vi.fn>;
  preventDefault: ReturnType<typeof vi.fn>;
};

function createPromptEvent(options: PromptEventOptions = {}): FakePromptEvent {
  const { outcome = "accepted", promptError = false, userChoiceRejects = false } = options;
  const prompt = vi.fn(async () => {
    if (promptError) throw new Error("prompt unavailable");
  });
  const preventDefault = vi.fn();
  const userChoice = userChoiceRejects
    ? Promise.reject(new Error("user choice unavailable"))
    : Promise.resolve({ outcome, platform: "web" } as const);
  // Keep a handler attached so an intentionally rejected promise is not
  // reported as an unhandled rejection when a test does not consume it.
  void userChoice.catch(() => undefined);
  return { prompt, preventDefault, userChoice };
}

type TestContext = {
  environment: InstallEnvironment;
  eventTarget: FakeEventTarget;
  storage: FakeStorage;
  controller: InstallController;
  state: () => ReturnType<InstallController["getState"]>;
};

function setup(
  options: { isStandalone?: boolean; storage?: FakeStorage | null } = {},
): TestContext {
  const eventTarget = new FakeEventTarget();
  const storage = options.storage === undefined ? new FakeStorage() : options.storage;
  const environment: InstallEnvironment = {
    eventTarget,
    storage,
    isStandalone: options.isStandalone ?? false,
  };
  const controller = createInstallController(environment);
  return {
    environment,
    eventTarget,
    storage: storage ?? new FakeStorage(),
    controller,
    state: () => controller.getState(),
  };
}

describe("createInstallController", () => {
  it("starts hidden and not installable when no prompt event arrived", () => {
    const { state } = setup();
    expect(state()).toEqual({ canInstall: false, installed: false, dismissed: false });
    expect(shouldShowInstallBanner(state())).toBe(false);
  });

  it("captures beforeinstallprompt, suppresses the default UI and notifies subscribers", () => {
    const context = setup();
    const listener = vi.fn();
    context.controller.subscribe(listener);
    const event = createPromptEvent();

    context.eventTarget.emit("beforeinstallprompt", event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(context.state()).toEqual({ canInstall: true, installed: false, dismissed: false });
    expect(shouldShowInstallBanner(context.state())).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    context.controller.dispose();
  });

  it("ignores values that are not install prompt events", () => {
    const context = setup();
    context.eventTarget.emit("beforeinstallprompt", undefined);
    context.eventTarget.emit("beforeinstallprompt", { prompt: "nope" });
    context.eventTarget.emit("beforeinstallprompt", null);
    expect(context.state().canInstall).toBe(false);
    context.controller.dispose();
  });

  it("notifies only once for repeated prompt events", () => {
    const context = setup();
    const listener = vi.fn();
    context.controller.subscribe(listener);
    context.eventTarget.emit("beforeinstallprompt", createPromptEvent());
    context.eventTarget.emit("beforeinstallprompt", createPromptEvent());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(context.state().canInstall).toBe(true);
    context.controller.dispose();
  });

  it("survives a throwing subscriber", () => {
    const context = setup();
    context.controller.subscribe(() => {
      throw new Error("ui exploded");
    });
    expect(() => context.eventTarget.emit("beforeinstallprompt", createPromptEvent())).not.toThrow();
    expect(context.state().canInstall).toBe(true);
    context.controller.dispose();
  });

  it("starts installed (and hidden) when the page is already standalone", () => {
    const context = setup({ isStandalone: true });
    expect(context.state()).toEqual({ canInstall: false, installed: true, dismissed: false });

    context.eventTarget.emit("beforeinstallprompt", createPromptEvent());
    expect(context.state().canInstall).toBe(false);
    expect(shouldShowInstallBanner(context.state())).toBe(false);
    context.controller.dispose();
  });
});

describe("promptInstall", () => {
  it("is unavailable when no prompt event was captured", async () => {
    const context = setup();
    await expect(context.controller.promptInstall()).resolves.toBe("unavailable");
    expect(context.state()).toEqual({ canInstall: false, installed: false, dismissed: false });
    context.controller.dispose();
  });

  it("prompts once and reports an accepted install", async () => {
    const context = setup();
    const event = createPromptEvent({ outcome: "accepted" });
    context.eventTarget.emit("beforeinstallprompt", event);

    await expect(context.controller.promptInstall()).resolves.toBe("accepted");
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(context.state()).toEqual({ canInstall: false, installed: true, dismissed: false });

    // The event is single-use: a second call must not prompt again.
    await expect(context.controller.promptInstall()).resolves.toBe("unavailable");
    expect(event.prompt).toHaveBeenCalledTimes(1);
    context.controller.dispose();
  });

  it("hides the banner but stays uninstalled when the user declines", async () => {
    const context = setup();
    const event = createPromptEvent({ outcome: "dismissed" });
    context.eventTarget.emit("beforeinstallprompt", event);

    await expect(context.controller.promptInstall()).resolves.toBe("dismissed");
    expect(context.state()).toEqual({ canInstall: false, installed: false, dismissed: false });
    expect(context.storage.values.has(INSTALL_DISMISSED_KEY)).toBe(false);
    context.controller.dispose();
  });

  it("reports unavailable when prompt() throws", async () => {
    const context = setup();
    const event = createPromptEvent({ promptError: true });
    context.eventTarget.emit("beforeinstallprompt", event);

    await expect(context.controller.promptInstall()).resolves.toBe("unavailable");
    expect(context.state().canInstall).toBe(false);
    context.controller.dispose();
  });

  it("treats a rejected userChoice as a dismissal", async () => {
    const context = setup();
    const event = createPromptEvent({ userChoiceRejects: true });
    context.eventTarget.emit("beforeinstallprompt", event);

    await expect(context.controller.promptInstall()).resolves.toBe("dismissed");
    expect(context.state().installed).toBe(false);
    context.controller.dispose();
  });

  it("marks the app installed when appinstalled fires after the prompt", async () => {
    const context = setup();
    context.eventTarget.emit("beforeinstallprompt", createPromptEvent({ outcome: "accepted" }));
    await context.controller.promptInstall();

    // A real browser fires appinstalled too; it must be idempotent.
    context.eventTarget.emit("appinstalled");
    expect(context.state()).toEqual({ canInstall: false, installed: true, dismissed: false });
    context.controller.dispose();
  });
});

describe("dismiss persistence", () => {
  it("persists the dismissal and drops the pending prompt", () => {
    const context = setup();
    const listener = vi.fn();
    context.controller.subscribe(listener);
    context.eventTarget.emit("beforeinstallprompt", createPromptEvent());

    context.controller.dismiss();

    expect(context.state()).toEqual({ canInstall: false, installed: false, dismissed: true });
    expect(context.storage.values.get(INSTALL_DISMISSED_KEY)).toBe("1");
    expect(shouldShowInstallBanner(context.state())).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2); // canInstall on, then dismissed
    context.controller.dispose();
  });

  it("keeps the banner closed after promptInstall once dismissed", async () => {
    const context = setup();
    context.eventTarget.emit("beforeinstallprompt", createPromptEvent());
    context.controller.dismiss();

    await expect(context.controller.promptInstall()).resolves.toBe("unavailable");

    // A later event must not resurrect the prompt either: the dismissal is
    // permanent for this profile.
    context.eventTarget.emit("beforeinstallprompt", createPromptEvent());
    await expect(context.controller.promptInstall()).resolves.toBe("unavailable");
    expect(context.state()).toEqual({ canInstall: false, installed: false, dismissed: true });
    context.controller.dispose();
  });

  it("restores a stored dismissal for a new controller", () => {
    const storage = new FakeStorage();
    storage.values.set(INSTALL_DISMISSED_KEY, "1");
    const first = setup({ storage });
    first.controller.dispose();

    const second = setup({ storage });
    expect(second.state()).toEqual({ canInstall: false, installed: false, dismissed: true });

    // Even a fresh prompt event does not bring the banner back.
    second.eventTarget.emit("beforeinstallprompt", createPromptEvent());
    expect(second.state().canInstall).toBe(false);
    expect(shouldShowInstallBanner(second.state())).toBe(false);
    second.controller.dispose();
  });

  it("works when storage is unavailable or throws", () => {
    const unavailable = setup({ storage: null });
    unavailable.eventTarget.emit("beforeinstallprompt", createPromptEvent());
    expect(() => unavailable.controller.dismiss()).not.toThrow();
    expect(unavailable.state().dismissed).toBe(true);
    unavailable.controller.dispose();

    const broken = new FakeStorage();
    broken.failWrite = true;
    broken.failRead = true;
    const context = setup({ storage: broken });
    context.eventTarget.emit("beforeinstallprompt", createPromptEvent());
    expect(() => context.controller.dismiss()).not.toThrow();
    expect(context.state().dismissed).toBe(true);
    context.controller.dispose();
  });
});

describe("lifecycle", () => {
  it("detaches listeners and stops notifying after dispose", () => {
    const context = setup();
    const listener = vi.fn();
    context.controller.subscribe(listener);

    context.controller.dispose();
    context.controller.dispose(); // idempotent

    expect(context.eventTarget.count("beforeinstallprompt")).toBe(0);
    expect(context.eventTarget.count("appinstalled")).toBe(0);

    context.eventTarget.emit("beforeinstallprompt", createPromptEvent());
    context.eventTarget.emit("appinstalled");
    expect(listener).not.toHaveBeenCalled();

    // A late subscriber gets a no-op unsubscribe instead of a live listener.
    const late = vi.fn();
    const unsubscribe = context.controller.subscribe(late);
    context.eventTarget.emit("beforeinstallprompt", createPromptEvent());
    expect(late).not.toHaveBeenCalled();
    expect(() => unsubscribe()).not.toThrow();
  });

  it("unsubscribes a single listener without touching the others", () => {
    const context = setup();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = context.controller.subscribe(first);
    context.controller.subscribe(second);

    unsubscribe();
    context.eventTarget.emit("beforeinstallprompt", createPromptEvent());

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    context.controller.dispose();
  });

  it("does not create a controller outside a browser", () => {
    expect(typeof window).toBe("undefined");
    expect(createBrowserInstallEnvironment()).toBeNull();
    expect(getInstallController()).toBeNull();
    resetInstallControllerForTests();
  });
});
