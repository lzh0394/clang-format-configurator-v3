import { describe, expect, it, vi } from "vitest";
import type { FormatRequest, InitRequest, Request, Response } from "../worker/protocol";
import {
  FormatterClient,
  FormatterError,
  FormatterSupersededError,
  type FormatterClientOptions,
  type FormatterWorker,
} from "./formatter-client";

class FakeWorker implements FormatterWorker {
  onmessage: ((event: { data: Response }) => void) | null = null;
  onerror: ((event: { message?: string; error?: unknown }) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;

  readonly posted: Request[] = [];
  terminated = false;

  postMessage(request: Request): void {
    this.posted.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(response: Response): void {
    this.onmessage?.({ data: response });
  }

  get formats(): FormatRequest[] {
    return this.posted.filter((request): request is FormatRequest => request.t === "format");
  }

  lastFormat(): FormatRequest {
    const request = this.formats.at(-1);
    if (!request) throw new Error("no format request was posted");
    return request;
  }
}

function setup(options: Omit<FormatterClientOptions, "createWorker"> = {}) {
  const workers: FakeWorker[] = [];
  const client = new FormatterClient({
    ...options,
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  return { client, workers };
}

function initRequest(worker: FakeWorker): InitRequest {
  const request = worker.posted.find((entry): entry is InitRequest => entry.t === "init");
  if (!request) throw new Error("no init request was posted");
  return request;
}

/** init() and answer the ready response; returns the worker it created. */
async function start(
  client: FormatterClient,
  workers: FakeWorker[],
  version = "21.1.8",
): Promise<FakeWorker> {
  const ready = client.init(version);
  const worker = workers.at(-1);
  if (!worker) throw new Error("init() did not create a worker");
  worker.respond({ t: "ready", id: initRequest(worker).id, version, build: version, ms: 1 });
  await ready;
  return worker;
}

describe("FormatterClient", () => {
  it("rejects format before init and resolves init on the ready response", async () => {
    const { client, workers } = setup();

    await expect(client.format("int x;", "a.cc", "{}")).rejects.toMatchObject({
      message: "formatter is not ready",
    });

    const worker = await start(client, workers);
    expect(client.version).toBe("21.1.8");
    expect(client.dead).toBe(false);
    expect(worker.posted).toHaveLength(1);
  });

  it("reuses the worker for the same version and replaces it on a version change", async () => {
    const { client, workers } = setup();
    const first = await start(client, workers, "21.1.8");

    await client.init("21.1.8");
    expect(workers).toHaveLength(1);

    const second = client.init("20.1.7");
    expect(first.terminated).toBe(true);
    expect(workers).toHaveLength(2);

    const replacement = workers[1]!;
    replacement.respond({
      t: "ready",
      id: initRequest(replacement).id,
      version: "20.1.7",
      build: "b",
      ms: 1,
    });
    await second;
    expect(client.version).toBe("20.1.7");
  });

  it("posts a format request and resolves it with the ok response", async () => {
    const { client, workers } = setup();
    const worker = await start(client, workers);

    const pending = client.format("int x;", "main.cc", '{"BasedOnStyle":"LLVM"}');
    const request = worker.lastFormat();
    expect(request).toMatchObject({
      t: "format",
      version: "21.1.8",
      code: "int x;",
      filename: "main.cc",
      style: '{"BasedOnStyle":"LLVM"}',
    });

    worker.respond({ t: "ok", id: request.id, code: "int x;\n", ms: 3 });
    await expect(pending).resolves.toEqual({ code: "int x;\n", ms: 3 });
  });

  it("keeps at most one format in flight and sends the latest queued one next", async () => {
    const { client, workers } = setup();
    const worker = await start(client, workers);

    const first = client.format("a", "a.cc", "{}");
    const firstRequest = worker.lastFormat();
    const second = client.format("b", "b.cc", "{}");

    expect(worker.formats).toHaveLength(1);
    expect(worker.formats[0]?.id).toBe(firstRequest.id);

    worker.respond({ t: "ok", id: firstRequest.id, code: "A", ms: 1 });
    await expect(first).resolves.toEqual({ code: "A", ms: 1 });

    const secondRequest = worker.lastFormat();
    expect(secondRequest.code).toBe("b");
    expect(secondRequest.id).toBeGreaterThan(firstRequest.id);

    worker.respond({ t: "ok", id: secondRequest.id, code: "B", ms: 2 });
    await expect(second).resolves.toEqual({ code: "B", ms: 2 });
  });

  it("supersedes the queued request when a newer format arrives", async () => {
    const { client, workers } = setup();
    const worker = await start(client, workers);

    const first = client.format("a", "a.cc", "{}");
    const firstRequest = worker.lastFormat();
    const second = client.format("b", "b.cc", "{}");
    const third = client.format("c", "c.cc", "{}");

    await expect(second).rejects.toBeInstanceOf(FormatterSupersededError);
    expect(worker.formats).toHaveLength(1);

    worker.respond({ t: "ok", id: firstRequest.id, code: "A", ms: 1 });
    await expect(first).resolves.toEqual({ code: "A", ms: 1 });

    const thirdRequest = worker.lastFormat();
    expect(thirdRequest.code).toBe("c");
    worker.respond({ t: "ok", id: thirdRequest.id, code: "C", ms: 1 });
    await expect(third).resolves.toEqual({ code: "C", ms: 1 });
  });

  it("rejects a format error response and then starts the queued request", async () => {
    const { client, workers } = setup();
    const worker = await start(client, workers);

    const first = client.format("bad", "a.cc", "{}");
    const firstRequest = worker.lastFormat();
    const second = client.format("good", "a.cc", "{}");

    worker.respond({
      t: "err",
      id: firstRequest.id,
      kind: "format",
      message: "Error parsing -style: Invalid argument",
      detail: "/path/a.cc:1:2: error",
    });

    const error = await first.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(FormatterError);
    expect((error as FormatterError).kind).toBe("format");
    expect((error as FormatterError).message).toBe("Error parsing -style: Invalid argument");
    expect((error as FormatterError).detail).toBe("/path/a.cc:1:2: error");

    const secondRequest = worker.lastFormat();
    expect(secondRequest.code).toBe("good");
    worker.respond({ t: "ok", id: secondRequest.id, code: "GOOD", ms: 1 });
    await expect(second).resolves.toEqual({ code: "GOOD", ms: 1 });
  });

  it("rejects pending work on a worker error, notifies onFatal and rebuilds on init", async () => {
    const onFatal = vi.fn();
    const { client, workers } = setup({ onFatal });
    const worker = await start(client, workers);

    const inflight = client.format("a", "a.cc", "{}");
    const queued = client.format("b", "b.cc", "{}");

    worker.onerror?.({ message: "segfault" });

    await expect(inflight).rejects.toMatchObject({ message: "segfault", kind: "fatal" });
    await expect(queued).rejects.toMatchObject({ kind: "fatal" });
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0]?.[0]).toBeInstanceOf(FormatterError);
    expect(worker.terminated).toBe(true);
    expect(client.dead).toBe(true);
    await expect(client.format("c", "c.cc", "{}")).rejects.toMatchObject({
      message: "formatter is not ready",
      kind: "fatal",
    });

    const rebuilt = client.init("21.1.8");
    expect(workers).toHaveLength(2);
    const replacement = workers[1]!;
    replacement.respond({
      t: "ready",
      id: initRequest(replacement).id,
      version: "21.1.8",
      build: "b",
      ms: 1,
    });
    await rebuilt;

    expect(client.dead).toBe(false);
    const pending = client.format("c", "c.cc", "{}");
    const request = replacement.lastFormat();
    replacement.respond({ t: "ok", id: request.id, code: "C", ms: 1 });
    await expect(pending).resolves.toEqual({ code: "C", ms: 1 });
  });

  it("rejects pending work on an unreadable worker message", async () => {
    const onFatal = vi.fn();
    const { client, workers } = setup({ onFatal });
    const worker = await start(client, workers);

    const pending = client.format("a", "a.cc", "{}");
    worker.onmessageerror?.({});

    await expect(pending).rejects.toMatchObject({
      message: "worker sent an unreadable message",
      kind: "fatal",
    });
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(worker.terminated).toBe(true);
  });

  it("times out a format, rejects it as fatal and marks the worker dead", async () => {
    vi.useFakeTimers();
    try {
      const onFatal = vi.fn();
      const { client, workers } = setup({ formatTimeoutMs: 25, onFatal });
      const worker = await start(client, workers);

      const pending = client.format("slow", "a.cc", "{}").catch((cause: unknown) => cause);
      expect(worker.formats).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(25);
      const error = await pending;

      expect(error).toBeInstanceOf(FormatterError);
      expect((error as FormatterError).kind).toBe("fatal");
      expect((error as FormatterError).message).toContain("timed out");
      expect(onFatal).toHaveBeenCalledTimes(1);
      expect(worker.terminated).toBe(true);
      expect(client.dead).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects pending work on dispose without reporting it as fatal", async () => {
    const onFatal = vi.fn();
    const { client, workers } = setup({ onFatal });
    const worker = await start(client, workers);

    const inflight = client.format("a", "a.cc", "{}");
    const queued = client.format("b", "b.cc", "{}");

    client.dispose();

    await expect(inflight).rejects.toMatchObject({ message: "formatter was replaced" });
    await expect(queued).rejects.toMatchObject({ message: "formatter was replaced" });
    expect(onFatal).not.toHaveBeenCalled();
    expect(worker.terminated).toBe(true);
    expect(client.version).toBe("");
    expect(client.dead).toBe(false);
  });

  it("ignores stale responses that do not match the in-flight request", async () => {
    const { client, workers } = setup();
    const worker = await start(client, workers);

    const pending = client.format("a", "a.cc", "{}");
    const request = worker.lastFormat();

    worker.respond({ t: "ok", id: request.id + 1000, code: "STALE", ms: 1 });
    worker.respond({ t: "err", id: request.id + 1000, kind: "fatal", message: "stale", detail: "" });
    expect(client.dead).toBe(false);

    worker.respond({ t: "ok", id: request.id, code: "A", ms: 1 });
    await expect(pending).resolves.toEqual({ code: "A", ms: 1 });
    expect(client.dead).toBe(false);
  });
});
