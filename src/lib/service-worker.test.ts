import { describe, expect, it, vi } from "vitest";
import {
  createServiceWorkerHandle,
  hasWaitingUpdate,
  isSameOriginScope,
  registerServiceWorker,
  serviceWorkerUrl,
  type EventTargetLike,
  type RegisterServiceWorkerOptions,
  type ServiceWorkerContainerLike,
  type ServiceWorkerEnvironment,
  type ServiceWorkerHandle,
  type ServiceWorkerLike,
  type ServiceWorkerRegistrationLike,
} from "./service-worker";

type Listener = () => void;

/** Tiny event-target stand-in shared by all fakes below. */
class EventLog {
  readonly #listeners = new Map<string, Set<Listener>>();

  add(type: string, listener: Listener): void {
    let listeners = this.#listeners.get(type);
    if (listeners === undefined) {
      listeners = new Set<Listener>();
      this.#listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  remove(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener();
  }

  count(type: string): number {
    return this.#listeners.get(type)?.size ?? 0;
  }
}

class FakeWorker implements ServiceWorkerLike {
  state = "installing";
  readonly posted: unknown[] = [];
  readonly events = new EventLog();

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  addEventListener(type: string, listener: Listener): void {
    this.events.add(type, listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.events.remove(type, listener);
  }

  /** Simulate a ServiceWorker state transition, notifying statechange listeners. */
  transition(state: string): void {
    this.state = state;
    this.events.emit("statechange");
  }
}

class FakeRegistration implements ServiceWorkerRegistrationLike {
  scope = "https://example.test/repo/";
  active: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  readonly events = new EventLog();

  addEventListener(type: string, listener: Listener): void {
    this.events.add(type, listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.events.remove(type, listener);
  }
}

class FakeContainer implements ServiceWorkerContainerLike {
  controller: FakeWorker | null = null;
  readonly registered: Array<{ scriptUrl: string; scope: string }> = [];
  readonly events = new EventLog();
  registerError: Error | null = null;
  readonly #registration: ServiceWorkerRegistrationLike;

  constructor(registration: ServiceWorkerRegistrationLike) {
    this.#registration = registration;
  }

  register(scriptUrl: string, options: { scope: string }): Promise<ServiceWorkerRegistrationLike> {
    this.registered.push({ scriptUrl, scope: options.scope });
    if (this.registerError !== null) return Promise.reject(this.registerError);
    return Promise.resolve(this.#registration);
  }

  addEventListener(type: string, listener: Listener): void {
    this.events.add(type, listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.events.remove(type, listener);
  }
}

class FakeWindow implements EventTargetLike {
  readonly events = new EventLog();

  addEventListener(type: string, listener: Listener): void {
    this.events.add(type, listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.events.remove(type, listener);
  }
}

type TestContext = {
  environment: ServiceWorkerEnvironment;
  registration: FakeRegistration;
  container: FakeContainer;
  eventTarget: FakeWindow;
  reloads: () => number;
};

function setup(overrides: Partial<ServiceWorkerEnvironment> = {}): TestContext {
  const registration = new FakeRegistration();
  const container = new FakeContainer(registration);
  const eventTarget = new FakeWindow();
  let reloads = 0;
  const environment: ServiceWorkerEnvironment = {
    baseUrl: "/repo/",
    href: "https://example.test/repo/",
    isOnline: true,
    isSecureContext: true,
    container,
    eventTarget,
    reload: () => {
      reloads += 1;
    },
    ...overrides,
  };
  return { environment, registration, container, eventTarget, reloads: () => reloads };
}

async function start(
  context: TestContext,
  options: RegisterServiceWorkerOptions = {},
): Promise<ServiceWorkerHandle> {
  const handle = await createServiceWorkerHandle(context.environment, options);
  if (handle === null) throw new Error("expected a service worker handle");
  return handle;
}

describe("serviceWorkerUrl", () => {
  it("serves the worker from the origin root by default", () => {
    expect(serviceWorkerUrl("/")).toBe("/sw.js");
  });

  it("follows the GitHub Pages sub-path", () => {
    expect(serviceWorkerUrl("/clang-format-configurator-v3/")).toBe(
      "/clang-format-configurator-v3/sw.js",
    );
    expect(serviceWorkerUrl("/clang-format-configurator-v3")).toBe(
      "/clang-format-configurator-v3/sw.js",
    );
  });

  it("normalizes an empty base and keeps absolute bases intact", () => {
    expect(serviceWorkerUrl("")).toBe("/sw.js");
    expect(serviceWorkerUrl("https://example.test/repo/")).toBe("https://example.test/repo/sw.js");
  });
});

describe("isSameOriginScope", () => {
  it("accepts the scope root and paths inside it", () => {
    expect(isSameOriginScope("https://example.test/repo/", "https://example.test/repo/")).toBe(true);
    expect(isSameOriginScope("https://example.test/repo/index.html", "https://example.test/repo/")).toBe(
      true,
    );
    expect(isSameOriginScope("https://example.test/", "https://example.test/")).toBe(true);
  });

  it("rejects sibling paths and other origins", () => {
    expect(isSameOriginScope("https://example.test/repo-other/", "https://example.test/repo/")).toBe(
      false,
    );
    expect(isSameOriginScope("https://other.test/repo/", "https://example.test/repo/")).toBe(false);
  });

  it("rejects invalid and non-http values", () => {
    expect(isSameOriginScope("not a url", "https://example.test/repo/")).toBe(false);
    expect(isSameOriginScope("blob:https://example.test/id", "https://example.test/repo/")).toBe(false);
    expect(isSameOriginScope("https://example.test/repo/", "nope")).toBe(false);
  });
});

describe("hasWaitingUpdate", () => {
  it("is true only when an active worker is being replaced", () => {
    const worker = new FakeWorker();
    expect(hasWaitingUpdate({ active: worker, waiting: worker })).toBe(true);
    expect(hasWaitingUpdate({ active: worker, waiting: null })).toBe(false);
    expect(hasWaitingUpdate({ active: null, waiting: worker })).toBe(false);
  });
});

describe("registerServiceWorker", () => {
  it("returns null instead of throwing outside a production browser", async () => {
    await expect(registerServiceWorker()).resolves.toBeNull();
  });
});

describe("createServiceWorkerHandle", () => {
  it("registers the scope-relative script with the base path as scope", async () => {
    const context = setup();
    const handle = await start(context);

    expect(context.container.registered).toEqual([{ scriptUrl: "/repo/sw.js", scope: "/repo/" }]);
    handle.dispose();
  });

  it("does nothing in an insecure context", async () => {
    const context = setup({ isSecureContext: false });
    await expect(createServiceWorkerHandle(context.environment)).resolves.toBeNull();
    expect(context.container.registered).toHaveLength(0);
  });

  it("resolves null and warns once when registration fails", async () => {
    const context = setup();
    context.container.registerError = new Error("registration exploded");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const handle = await createServiceWorkerHandle(context.environment);
      expect(handle).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("reports an update once it installs over an active worker", async () => {
    const context = setup();
    const onUpdateReady = vi.fn();
    const handle = await start(context, { onUpdateReady });

    context.registration.active = new FakeWorker();
    const update = new FakeWorker();
    context.registration.installing = update;
    context.registration.events.emit("updatefound");

    update.transition("installed");
    update.transition("installed"); // duplicate statechange must not notify twice
    expect(onUpdateReady).toHaveBeenCalledTimes(1);

    handle.dispose();
  });

  it("reports an update that finished installing before the handle existed", async () => {
    const context = setup();
    context.registration.active = new FakeWorker();
    const update = new FakeWorker();
    update.state = "installed";
    context.registration.installing = update;

    const onUpdateReady = vi.fn();
    const handle = await start(context, { onUpdateReady });

    expect(onUpdateReady).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it("does not mistake the first install for a pending update", async () => {
    const context = setup();
    const onUpdateReady = vi.fn();
    const handle = await start(context, { onUpdateReady });

    const first = new FakeWorker();
    context.registration.installing = first;
    context.registration.events.emit("updatefound");
    first.transition("installed");

    expect(onUpdateReady).not.toHaveBeenCalled();
    handle.dispose();
  });

  it("reports a worker that was already waiting when the page loaded", async () => {
    const context = setup();
    context.registration.active = new FakeWorker();
    context.registration.waiting = new FakeWorker();

    const onUpdateReady = vi.fn();
    const handle = await start(context, { onUpdateReady });

    expect(onUpdateReady).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it("posts SKIP_WAITING and reloads exactly once after the controller changes", async () => {
    const context = setup();
    const handle = await start(context);
    const update = new FakeWorker();
    context.registration.waiting = update;

    handle.applyUpdate();
    expect(update.posted).toEqual([{ type: "SKIP_WAITING" }]);

    context.container.events.emit("controllerchange");
    context.container.events.emit("controllerchange");
    expect(context.reloads()).toBe(1);

    handle.dispose();
  });

  it("does not reload on controllerchange unless an update was applied", async () => {
    const context = setup();
    const handle = await start(context);

    // First install: clients.claim() fires controllerchange, but no reload.
    context.container.events.emit("controllerchange");
    expect(context.reloads()).toBe(0);

    handle.applyUpdate(); // nothing waiting: no-op
    context.container.events.emit("controllerchange");
    expect(context.reloads()).toBe(0);

    handle.dispose();
  });

  it("reports the current connectivity and follows online/offline events", async () => {
    const context = setup({ isOnline: false });
    const onOfflineChange = vi.fn();
    const handle = await start(context, { onOfflineChange });

    expect(onOfflineChange.mock.calls).toEqual([[true]]);

    context.eventTarget.events.emit("online");
    context.eventTarget.events.emit("offline");
    expect(onOfflineChange.mock.calls).toEqual([[true], [false], [true]]);

    handle.dispose();
  });

  it("survives throwing callbacks", async () => {
    const context = setup({ isOnline: false });
    const handle = await createServiceWorkerHandle(context.environment, {
      onOfflineChange: () => {
        throw new Error("ui exploded");
      },
      onUpdateReady: () => {
        throw new Error("ui exploded");
      },
    });
    if (handle === null) throw new Error("expected a service worker handle");

    context.registration.active = new FakeWorker();
    context.registration.waiting = new FakeWorker();
    expect(() => handle.applyUpdate()).not.toThrow();
    handle.dispose();
  });

  it("detaches every listener and stops reporting after dispose", async () => {
    const context = setup();
    const onOfflineChange = vi.fn();
    const onUpdateReady = vi.fn();
    const handle = await start(context, { onOfflineChange, onUpdateReady });
    onOfflineChange.mockClear();

    handle.dispose();
    handle.dispose(); // idempotent

    expect(context.registration.events.count("updatefound")).toBe(0);
    expect(context.container.events.count("controllerchange")).toBe(0);
    expect(context.eventTarget.events.count("online")).toBe(0);
    expect(context.eventTarget.events.count("offline")).toBe(0);

    context.eventTarget.events.emit("offline");
    context.container.events.emit("controllerchange");
    expect(onOfflineChange).not.toHaveBeenCalled();
    expect(context.reloads()).toBe(0);
  });
});
