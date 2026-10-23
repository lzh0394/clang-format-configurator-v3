import { describe, expect, it, vi } from "vitest";
import { createSchemaStore } from "./schema-store";
import type { SchemaCore, SchemaDocs } from "./schema";

function core(version: string): SchemaCore {
  return { version, build: `build-${version}`, tag: `tag-${version}`, styles: ["LLVM"], options: [] };
}

describe("createSchemaStore", () => {
  it("loads a version once and serves the cache afterwards", async () => {
    const loadSchema = vi.fn(async (version: string) => core(version));
    const store = createSchemaStore({ loadSchema });

    const [first, second] = await Promise.all([store.schema("21.1.8"), store.schema("21.1.8")]);
    expect(first).toBe(second);
    expect(loadSchema).toHaveBeenCalledTimes(1);

    expect(await store.schema("21.1.8")).toBe(first);
    expect(loadSchema).toHaveBeenCalledTimes(1);
  });

  it("keeps the most recently used versions and evicts the LRU one", async () => {
    const loadSchema = vi.fn(async (version: string) => core(version));
    const store = createSchemaStore({ capacity: 2, loadSchema });

    await store.schema("18.1.8");
    await store.schema("20.1.7");
    await store.schema("18.1.8"); // touch: 20.1.7 is now the LRU one
    await store.schema("21.1.8");

    expect(loadSchema).toHaveBeenCalledTimes(3);
    await store.schema("18.1.8");
    expect(loadSchema).toHaveBeenCalledTimes(3);
    await store.schema("20.1.7");
    expect(loadSchema).toHaveBeenCalledTimes(4);
  });

  it("does not cache failures, so a retry can succeed", async () => {
    let attempts = 0;
    const loadSchema = vi.fn(async (version: string) => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return core(version);
    });
    const store = createSchemaStore({ loadSchema });

    await expect(store.schema("21.1.8")).rejects.toThrow("offline");
    await expect(store.schema("21.1.8")).resolves.toMatchObject({ version: "21.1.8" });
    expect(loadSchema).toHaveBeenCalledTimes(2);
  });

  it("caches docs separately from schemas", async () => {
    const loadSchema = vi.fn(async (version: string) => core(version));
    const loadDocs = vi.fn(async (): Promise<SchemaDocs> => ({ IndentWidth: "<p>indent</p>" }));
    const store = createSchemaStore({ loadSchema, loadDocs });

    await store.schema("21.1.8");
    expect(loadDocs).not.toHaveBeenCalled();
    expect(await store.docs("21.1.8")).toEqual({ IndentWidth: "<p>indent</p>" });
    expect(loadDocs).toHaveBeenCalledTimes(1);
    expect(loadSchema).toHaveBeenCalledTimes(1);

    store.clear();
    await store.schema("21.1.8");
    expect(loadSchema).toHaveBeenCalledTimes(2);
  });
});
