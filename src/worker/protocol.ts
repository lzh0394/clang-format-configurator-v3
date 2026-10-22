// Messages exchanged with the formatter worker.
//
// The worker owns exactly one wasm instance at a time. Requests are correlated
// by `id`; the main thread drops responses for superseded ids.

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

export type ErrorResponse = {
  t: "err";
  id: number;
  message: string;
  detail: string;
};

export type Response = ReadyResponse | OkResponse | ErrorResponse;
