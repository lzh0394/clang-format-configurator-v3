/// <reference lib="webworker" />

// Owns one clang-format wasm instance. Every version ships an `entry.js` shim
// that re-exports a uniform surface (default init + format/dump_config/version)
// across the two package layouts (<=21 single glue, 22+ web wrapper).

import type { Request, Response } from "./protocol";

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

function describe(error: unknown): { message: string; detail: string } {
  const text = error instanceof Error ? error.message : String(error);
  const lines = text.split("\n");
  return {
    message: (lines[0] ?? "").trim() || "format failed",
    detail: lines.slice(1).join("\n").trim(),
  };
}

scope.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    if (request.t === "init") {
      const started = performance.now();
      const mod = await load(request.version);
      post({
        t: "ready",
        id: request.id,
        version: request.version,
        build: mod.version?.() ?? request.version,
        ms: performance.now() - started,
      });
      return;
    }

    const started = performance.now();
    const mod = await load(request.version);
    const code = mod.format(request.code, request.filename, request.style);
    post({ t: "ok", id: request.id, code, ms: performance.now() - started });
  } catch (error) {
    post({ t: "err", id: request.id, ...describe(error) });
  }
};
