import type { ErrorKind, FormatRequest, Request, Response } from "../worker/protocol";

export class FormatterError extends Error {
  readonly detail: string;
  /** `format`: the formatter rejected the input; `fatal`: the worker is dead. */
  readonly kind: ErrorKind;

  constructor(message: string, detail = "", kind: ErrorKind = "format") {
    super(message);
    this.name = "FormatterError";
    this.detail = detail;
    this.kind = kind;
  }
}

/**
 * Rejected when a newer `format()` replaced a request that had not started yet.
 * Callers should ignore it instead of reporting a formatting failure.
 */
export class FormatterSupersededError extends FormatterError {
  constructor(message = "format request superseded by a newer one", detail = "") {
    super(message, detail, "format");
    this.name = "FormatterSupersededError";
  }
}

type MessageHandler = (event: { data: Response }) => void;
type ErrorHandler = (event: { message?: string; error?: unknown }) => void;

/**
 * Minimal worker surface the client depends on. Injectable so unit tests can
 * run in node without the real `Worker` global.
 */
export type FormatterWorker = {
  postMessage(request: Request): void;
  terminate(): void;
  onmessage: MessageHandler | null;
  onerror: ErrorHandler | null;
  onmessageerror: ((event: unknown) => void) | null;
};

export type FormatterClientOptions = {
  /** Create the worker; defaults to the real Vite module worker. */
  createWorker?: () => FormatterWorker;
  /** Format timeout in ms; expiry tears the worker down (default 20s). */
  formatTimeoutMs?: number;
  /** Init timeout in ms; expiry tears the worker down (default 20s). */
  initTimeoutMs?: number;
  /**
   * Called once when the worker becomes unusable (crash, unreadable message,
   * timeout, fatal response). Not called for an intentional `dispose()` /
   * version switch.
   */
  onFatal?: (error: FormatterError) => void;
};

type FormatCall = {
  id: number;
  request: FormatRequest;
  resolve: (result: { code: string; ms: number }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

type InitCall = {
  id: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

const FORMAT_TIMEOUT_MS = 20_000;
const INIT_TIMEOUT_MS = 20_000;

function browserWorker(): FormatterWorker {
  const worker = new Worker(new URL("../worker/formatter.worker.ts", import.meta.url), {
    type: "module",
  });
  const facade: FormatterWorker = {
    postMessage: (request) => worker.postMessage(request),
    terminate: () => worker.terminate(),
    onmessage: null,
    onerror: null,
    onmessageerror: null,
  };

  worker.onmessage = (event) => facade.onmessage?.({ data: event.data as Response });
  worker.onerror = (event) => facade.onerror?.({ message: event.message, error: event.error });
  worker.onmessageerror = () => facade.onmessageerror?.({});

  return facade;
}

function clearTimer(call: { timer: ReturnType<typeof setTimeout> | null }): void {
  if (call.timer !== null) {
    clearTimeout(call.timer);
    call.timer = null;
  }
}

/**
 * Main-thread facade over the formatter worker.
 *
 * One worker == one wasm instance. Changing the version terminates the old
 * worker (the only reliable way to release its ~50 MB heap) and starts a new
 * one; callers can `await init(version)` and then `format()`.
 *
 * Formatting is latest-wins: at most one request is in flight, and calling
 * `format()` again while one is running keeps only the newest request queued.
 */
export class FormatterClient {
  /** Set (or pass in the constructor) to be notified when the worker dies. */
  onFatal?: (error: FormatterError) => void;

  #createWorker: () => FormatterWorker;
  #formatTimeoutMs: number;
  #initTimeoutMs: number;

  #worker: FormatterWorker | null = null;
  #version = "";
  #seq = 0;
  #dead = false;
  #ready: Promise<void> | null = null;
  #init: InitCall | null = null;
  #inflight: FormatCall | null = null;
  #queued: FormatCall | null = null;

  constructor(options: FormatterClientOptions = {}) {
    this.#createWorker = options.createWorker ?? browserWorker;
    this.#formatTimeoutMs = options.formatTimeoutMs ?? FORMAT_TIMEOUT_MS;
    this.#initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
    this.onFatal = options.onFatal;
  }

  /** Version of the last successful `init()`; empty after `dispose()`. */
  get version(): string {
    return this.#version;
  }

  /** True after a fatal failure; call `init()` again to rebuild the worker. */
  get dead(): boolean {
    return this.#dead;
  }

  async init(version: string): Promise<void> {
    if (!this.#dead && this.#worker && this.#version === version && this.#ready) {
      return this.#ready;
    }

    this.dispose();

    const worker = this.#createWorker();
    this.#worker = worker;
    this.#version = version;
    this.#dead = false;

    worker.onmessage = (event) => {
      if (this.#worker !== worker) return;
      this.#handle(event.data);
    };
    worker.onerror = (event) => {
      if (this.#worker !== worker) return;
      this.#fail(new FormatterError(event.message || "worker crashed", "", "fatal"));
    };
    worker.onmessageerror = () => {
      if (this.#worker !== worker) return;
      this.#fail(new FormatterError("worker sent an unreadable message", "", "fatal"));
    };

    const id = ++this.#seq;
    const ready = new Promise<void>((resolve, reject) => {
      const call: InitCall = { id, resolve, reject, timer: null };
      call.timer = setTimeout(() => {
        this.#fail(new FormatterError(`loading clang-format ${version} timed out`, "", "fatal"));
      }, this.#initTimeoutMs);
      this.#init = call;
      worker.postMessage({ t: "init", id, version } satisfies Request);
    });

    this.#ready = ready;
    return ready;
  }

  format(code: string, filename: string, style: string): Promise<{ code: string; ms: number }> {
    const worker = this.#worker;
    if (!worker || !this.#version) {
      const kind = this.#dead ? "fatal" : "format";
      return Promise.reject(new FormatterError("formatter is not ready", "", kind));
    }

    const id = ++this.#seq;
    const request: FormatRequest = { t: "format", id, version: this.#version, code, filename, style };

    return new Promise((resolve, reject) => {
      const call: FormatCall = { id, request, resolve, reject, timer: null };

      // A newer request replaces the one waiting in the queue.
      if (this.#queued) {
        const previous = this.#queued;
        this.#queued = null;
        previous.reject(new FormatterSupersededError());
      }

      if (this.#inflight) {
        this.#queued = call;
      } else {
        this.#send(call);
      }
    });
  }

  /** Tear the worker down and reject everything still pending. */
  dispose(): void {
    this.#dropWorker();
    this.#dead = false;
    this.#ready = null;
    this.#version = "";
    this.#settleAll(new FormatterError("formatter was replaced"));
  }

  #send(call: FormatCall): void {
    const worker = this.#worker;
    if (!worker) {
      call.reject(new FormatterError("formatter is not ready"));
      return;
    }

    this.#inflight = call;
    call.timer = setTimeout(() => {
      if (this.#inflight !== call) return;
      this.#fail(new FormatterError(`formatting timed out after ${this.#formatTimeoutMs} ms`, "", "fatal"));
    }, this.#formatTimeoutMs);

    worker.postMessage(call.request);
  }

  #handle(response: Response): void {
    if (this.#init && response.id === this.#init.id) {
      this.#settleInit(response);
      return;
    }

    if (response.t === "ready") return; // stale ready for an already-settled init

    if (response.t === "err" && response.kind === "fatal") {
      // Only actionable while it belongs to the live call; a stale fatal
      // response must not kill the current worker.
      if (this.#inflight && response.id === this.#inflight.id) {
        this.#fail(new FormatterError(response.message, response.detail, "fatal"));
      }
      return;
    }

    const call = this.#inflight;
    if (!call || call.id !== response.id) return; // stale id, drop it

    this.#inflight = null;
    clearTimer(call);

    if (response.t === "ok") {
      call.resolve({ code: response.code, ms: response.ms });
    } else {
      call.reject(new FormatterError(response.message, response.detail, "format"));
    }

    this.#flush();
  }

  #settleInit(response: Response): void {
    const call = this.#init;
    if (!call) return;

    if (response.t === "ready") {
      this.#init = null;
      clearTimer(call);
      call.resolve();
      return;
    }

    // Any failure while loading means the wasm instance is unusable.
    const error = new FormatterError(
      response.t === "err" ? response.message : "unexpected response to init",
      response.t === "err" ? response.detail : "",
      "fatal",
    );
    this.#fail(error);
  }

  #flush(): void {
    const next = this.#queued;
    if (!next || !this.#worker) return;
    this.#queued = null;
    this.#send(next);
  }

  #fail(error: FormatterError): void {
    this.#dropWorker();
    this.#dead = true;
    this.#ready = null;
    this.#settleAll(error);

    try {
      this.onFatal?.(error);
    } catch {
      // A throwing callback must not mask the formatter failure.
    }
  }

  #dropWorker(): FormatterWorker | null {
    const worker = this.#worker;
    this.#worker = null;
    if (!worker) return null;

    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
    return worker;
  }

  #settleAll(error: Error): void {
    const init = this.#init;
    this.#init = null;
    if (init) {
      clearTimer(init);
      init.reject(error);
    }

    const inflight = this.#inflight;
    this.#inflight = null;
    if (inflight) {
      clearTimer(inflight);
      inflight.reject(error);
    }

    const queued = this.#queued;
    this.#queued = null;
    queued?.reject(error);
  }
}
