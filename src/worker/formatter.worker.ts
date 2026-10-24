/// <reference lib="webworker" />

// Owns one clang-format wasm instance. Every version ships an `entry.js` shim
// that re-exports a uniform surface (default init + format/dump_config/version)
// across the two package layouts (<=21 single glue, 22+ web wrapper).
//
// Requests are serialized in arrival order. While one request runs, at most one
// format request is kept queued: a newer format request replaces it so that
// typing does not build a backlog of stale formatting work.

import { describeError, mergeDiagnostics } from "../lib/diagnostics";
import type { ErrorKind, FormatRequest, InitRequest, Request, Response } from "./protocol";

type WasmModule = {
  default: () => Promise<unknown>;
  format: (code: string, filename?: string, style?: string) => string;
  version?: () => string;
};

const scope = self as unknown as DedicatedWorkerGlobalScope;

let loaded: { version: string; mod: WasmModule } | null = null;

function post(message: Response) {
  scope.postMessage(message);
}

async function load(version: string): Promise<WasmModule> {
  if (loaded?.version === version) return loaded.mod;

  const url = new URL(`${import.meta.env.BASE_URL}wasm/${version}/entry.js`, scope.location.href);
  const mod = (await import(/* @vite-ignore */ url.href)) as WasmModule;
  await mod.default();

  loaded = { version, mod };
  return mod;
}

// LLVM writes its diagnostics to stderr, which the wasm glue forwards to
// console.error / console.warn. Capture those while formatting so the error
// response can carry the real message instead of only `Invalid argument`.

type ConsoleCapture = {
  lines: string[];
  restore: () => void;
};

function stringifyArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unprintable diagnostic]";
    }
  }
}

function captureConsole(): ConsoleCapture {
  const lines: string[] = [];
  const previousError = console.error;
  const previousWarn = console.warn;
  const record = (...args: unknown[]) => {
    const text = args.map(stringifyArg).join(" ").trim();
    if (text) lines.push(text);
  };

  console.error = record;
  console.warn = record;

  return {
    lines,
    restore() {
      console.error = previousError;
      console.warn = previousWarn;
    },
  };
}

async function handleInit(request: InitRequest): Promise<void> {
  const started = performance.now();
  try {
    const mod = await load(request.version);
    post({
      t: "ready",
      id: request.id,
      version: request.version,
      build: mod.version?.() ?? request.version,
      ms: performance.now() - started,
    });
  } catch (error) {
    const parts = describeError(error, "clang-format failed to load");
    post({ t: "err", id: request.id, kind: "fatal", message: parts.summary, detail: parts.detail });
  }
}

async function handleFormat(request: FormatRequest): Promise<void> {
  const started = performance.now();
  const capture = captureConsole();
  let kind: ErrorKind = "format";

  try {
    kind = "fatal";
    const mod = await load(request.version);
    kind = "format";
    const code = mod.format(request.code, request.filename, request.style);
    post({ t: "ok", id: request.id, code, ms: performance.now() - started });
  } catch (error) {
    const parts = mergeDiagnostics(describeError(error), capture.lines);
    post({ t: "err", id: request.id, kind, message: parts.summary, detail: parts.detail });
  } finally {
    capture.restore();
  }
}

async function handle(request: Request): Promise<void> {
  if (request.t === "init") {
    await handleInit(request);
    return;
  }
  await handleFormat(request);
}

const queue: Request[] = [];
let running = false;

function enqueue(request: Request): void {
  if (request.t === "format") {
    // Latest-wins: replace the queued format request, if any, in place.
    const index = queue.findIndex((item) => item.t === "format");
    if (index >= 0) {
      const [dropped] = queue.splice(index, 1);
      if (dropped) {
        post({
          t: "err",
          id: dropped.id,
          kind: "format",
          message: "format request superseded",
          detail: "A newer format request replaced this one before it started.",
        });
      }
    }
  }

  queue.push(request);
  void pump();
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const request = queue.shift();
      if (!request) break;

      try {
        await handle(request);
      } catch (error) {
        // Last-resort guard: a broken handler must not stall the queue.
        const parts = describeError(error, "worker request failed");
        post({ t: "err", id: request.id, kind: "fatal", message: parts.summary, detail: parts.detail });
      }
    }
  } finally {
    running = false;
  }
}

scope.onmessage = (event: MessageEvent<Request>) => {
  enqueue(event.data);
};
