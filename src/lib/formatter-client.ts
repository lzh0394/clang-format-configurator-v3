import type { FormatRequest, InitRequest, Request, Response } from "../worker/protocol";

export class FormatterError extends Error {
  readonly detail: string;

  constructor(message: string, detail = "") {
    super(message);
    this.name = "FormatterError";
    this.detail = detail;
  }
}

type Handler = (response: Response) => void;

const INIT_TIMEOUT_MS = 20_000;

/**
 * Main-thread facade over the formatter worker.
 *
 * One worker == one wasm instance. Changing the version terminates the old
 * worker (the only reliable way to release its ~50 MB heap) and starts a new
 * one; callers can `await init(version)` and then `format()`.
 */
export class FormatterClient {
  #worker: Worker | null = null;
  #version = "";
  #seq = 0;
  #pending = new Map<number, Handler>();
  #ready: Promise<void> | null = null;

  get version(): string {
    return this.#version;
  }

  async init(version: string): Promise<void> {
    if (this.#worker && this.#version === version && this.#ready) return this.#ready;

    this.dispose();

    const worker = new Worker(new URL("../worker/formatter.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<Response>) => this.#handle(event.data);
    worker.onerror = (event) => {
      this.#failAll(new FormatterError(event.message || "worker crashed"));
    };
    worker.onmessageerror = () => {
      this.#failAll(new FormatterError("worker sent an unreadable message"));
    };

    this.#worker = worker;
    this.#version = version;

    const id = ++this.#seq;
    const request: InitRequest = { t: "init", id, version };
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new FormatterError(`loading clang-format ${version} timed out`));
      }, INIT_TIMEOUT_MS);

      this.#pending.set(id, (response) => {
        clearTimeout(timer);
        if (response.t === "ready") resolve();
        else if (response.t === "err") reject(new FormatterError(response.message, response.detail));
        else reject(new FormatterError("unexpected response to init"));
      });

      worker.postMessage(request satisfies Request);
    });

    this.#ready = ready;
    return ready;
  }

  format(code: string, filename: string, style: string): Promise<{ code: string; ms: number }> {
    const worker = this.#worker;
    if (!worker || !this.#version) {
      return Promise.reject(new FormatterError("formatter is not ready"));
    }

    const id = ++this.#seq;
    const request: FormatRequest = { t: "format", id, version: this.#version, code, filename, style };

    return new Promise((resolve, reject) => {
      this.#pending.set(id, (response) => {
        if (response.t === "ok") resolve({ code: response.code, ms: response.ms });
        else if (response.t === "err") reject(new FormatterError(response.message, response.detail));
        else reject(new FormatterError("unexpected response to format"));
      });
      worker.postMessage(request satisfies Request);
    });
  }

  dispose(): void {
    this.#failAll(new FormatterError("formatter was replaced"));
    this.#worker?.terminate();
    this.#worker = null;
    this.#ready = null;
    this.#version = "";
  }

  #handle(response: Response): void {
    const handler = this.#pending.get(response.id);
    if (!handler) return;
    this.#pending.delete(response.id);
    handler(response);
  }

  #failAll(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const handler of pending) {
      handler({ t: "err", id: -1, message: error.message, detail: "" });
    }
  }
}
