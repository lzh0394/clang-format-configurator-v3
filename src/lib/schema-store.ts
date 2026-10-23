// Runtime schema store (plan §5): schema JSON is fetched once per version and
// cached in a small LRU (default 3 versions == the number of shipped versions),
// docs are fetched lazily the first time a row's documentation is opened or a
// search needs their text. In-flight requests are de-duplicated and failures
// are not cached, so the UI can retry.

import { loadDocs, loadSchema, type SchemaCore, type SchemaDocs } from "./schema";

export type SchemaStore = {
  schema(version: string): Promise<SchemaCore>;
  docs(version: string): Promise<SchemaDocs>;
  /** Test / troubleshooting hook: forget every cached entry. */
  clear(): void;
};

export type SchemaStoreOptions = {
  capacity?: number;
  loadSchema?: (version: string) => Promise<SchemaCore>;
  loadDocs?: (version: string) => Promise<SchemaDocs>;
};

type CacheEntry<T> = { value?: T; pending?: Promise<T> };

export function createSchemaStore(options: SchemaStoreOptions = {}): SchemaStore {
  const capacity = Math.max(1, options.capacity ?? 3);
  const loadCore = options.loadSchema ?? loadSchema;
  const loadDoc = options.loadDocs ?? loadDocs;

  const schemas = new Map<string, CacheEntry<SchemaCore>>();
  const docs = new Map<string, CacheEntry<SchemaDocs>>();

  function touch<T>(cache: Map<string, CacheEntry<T>>, key: string): CacheEntry<T> | undefined {
    const entry = cache.get(key);
    if (entry) {
      cache.delete(key);
      cache.set(key, entry);
    }
    return entry;
  }

  function remember<T>(cache: Map<string, CacheEntry<T>>, key: string, entry: CacheEntry<T>): void {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > capacity) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  async function get<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    load: (version: string) => Promise<T>,
  ): Promise<T> {
    const existing = touch(cache, key);
    if (existing?.value !== undefined) return existing.value;
    if (existing?.pending) return existing.pending;

    const pending = load(key);
    remember(cache, key, { pending });
    try {
      const value = await pending;
      // The entry may have been evicted while loading; remember it anyway so a
      // just-loaded schema activates the LRU again.
      remember(cache, key, { value });
      return value;
    } catch (error) {
      cache.delete(key);
      throw error;
    }
  }

  return {
    schema: (version) => get(schemas, version, loadCore),
    docs: (version) => get(docs, version, loadDoc),
    clear: () => {
      schemas.clear();
      docs.clear();
    },
  };
}

/** Shared store used by the app. */
export const schemaStore: SchemaStore = createSchemaStore();
