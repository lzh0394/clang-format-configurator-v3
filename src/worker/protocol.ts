// Messages exchanged with the formatter worker.
//
// The worker owns exactly one wasm instance at a time and serializes request
// handling. While a request is running, at most one format request is kept
// queued; a newer format request replaces the queued one (latest-wins) so fast
// typing never builds a backlog. The main thread correlates responses by `id`
// and ignores ids it has already settled.

export type InitRequest = {
  t: "init";
  id: number;
  version: string;
};

export type FormatRequest = {
  t: "format";
  id: number;
  version: string;
  code: string;
  filename: string;
  style: string;
};

export type Request = InitRequest | FormatRequest;

export type ReadyResponse = {
  t: "ready";
  id: number;
  version: string;
  build: string;
  ms: number;
};

export type OkResponse = {
  t: "ok";
  id: number;
  code: string;
  ms: number;
};

/**
 * `format`: clang-format rejected the code or style; the worker stays usable.
 * `fatal`: the worker can no longer serve requests (wasm failed to load,
 * crashed, ...); the client marks it dead and rebuilds it on the next init.
 */
export type ErrorKind = "format" | "fatal";

export type ErrorResponse = {
  t: "err";
  id: number;
  kind: ErrorKind;
  message: string;
  detail: string;
};

export type Response = ReadyResponse | OkResponse | ErrorResponse;
