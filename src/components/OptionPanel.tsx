// The options panel (contract §4): a virtualized, searchable, filterable list of
// every clang-format option for the current schema version. It is a pure
// presentational component — all state lives in App's reducer, the panel only
// derives display values and reports edits upward.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { isModified, type Modified } from "../lib/config";
import type { OptionDef, SchemaCore, StyleName } from "../lib/schema";
import OptionRow from "./OptionRow";
import { useDocs } from "./useDocs";
import styles from "./OptionPanel.module.css";

export type OptionPanelProps = {
  schema: SchemaCore;
  style: StyleName;
  modified: Modified;
  /** Pass `undefined` to restore the value inherited from the style preset. */
  onOptionChange: (key: string, value: unknown) => void;
  onChildChange: (option: OptionDef, childKey: string, value: unknown) => void;
  onResetAll: () => void;
};

type Filter = "all" | "modified" | "deprecated";

const FILTERS: ReadonlyArray<{ id: Filter; label: string; testId: string }> = [
  { id: "all", label: "All", testId: "filter-all" },
  { id: "modified", label: "Modified", testId: "filter-modified" },
  { id: "deprecated", label: "Deprecated", testId: "filter-deprecated" },
];

const SEARCH_DEBOUNCE_MS = 120;
const ROW_ESTIMATE_PX = 44;
const OVERSCAN = 8;

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith("#")) {
      const hex = code[1]?.toLowerCase() === "x";
      const value = hex ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      if (Number.isInteger(value) && value > 0 && value <= 0x10ffff) {
        return String.fromCodePoint(value);
      }
      return match;
    }
    return HTML_ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Docs are build-time HTML; search works on their visible text. */
export function docsToPlainText(html: string): string {
  const withoutTags = html.replace(/<[^>]*>/g, " ");
  return decodeHtmlEntities(withoutTags).replace(/\s+/g, " ").trim();
}

function toggleKey(previous: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(previous);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export default function OptionPanel({
  schema,
  style,
  modified,
  onOptionChange,
  onChildChange,
  onResetAll,
}: OptionPanelProps): JSX.Element {
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [docsOpen, setDocsOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [bodyOpen, setBodyOpen] = useState<ReadonlySet<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const { docs, status: docsStatus, error: docsError, ensureLoaded, retry } = useDocs(schema.version);

  // 120 ms debounce for the actual filtering; the docs fetch is kicked off from
  // the raw input so the first non-empty search starts loading immediately.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(searchInput.trim().toLowerCase());
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (searchInput.trim() !== "") ensureLoaded();
  }, [searchInput, ensureLoaded]);

  const searchActive = query !== "";

  // Lower-cased plain text of every docstring, built lazily and only while a
  // search is active (189 docs, ~100 KB of HTML).
  const docsText = useMemo(() => {
    if (!searchActive || docs === null) return null;
    const text = new Map<string, string>();
    for (const option of schema.options) {
      const html = docs[option.key];
      if (html !== undefined) text.set(option.key, docsToPlainText(html).toLowerCase());
    }
    return text;
  }, [docs, schema, searchActive]);

  const filtered = useMemo(() => {
    const matches: OptionDef[] = [];
    for (const option of schema.options) {
      if (filter === "modified" && !isModified(modified, option.key)) continue;
      if (filter === "deprecated" && !option.deprecated) continue;
      if (query !== "") {
        const keyMatch = option.key.toLowerCase().includes(query);
        const docsMatch = docsText?.get(option.key)?.includes(query) ?? false;
        if (!keyMatch && !docsMatch) continue;
      }
      matches.push(option);
    }
    return matches;
  }, [schema, filter, modified, query, docsText]);

  const hasModified = useMemo(() => Object.keys(modified).length > 0, [modified]);

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: OVERSCAN,
    getItemKey: (index) => filtered[index]?.key ?? index,
  });

  // Search/filter changes must start the (much shorter) list at the top.
  const resetKey = `${query}\u0000${filter}`;
  const previousResetKey = useRef(resetKey);
  useEffect(() => {
    if (previousResetKey.current === resetKey) return;
    previousResetKey.current = resetKey;
    virtualizer.scrollToOffset(0);
  }, [resetKey, virtualizer]);

  const handleToggleDocs = useCallback(
    (key: string) => {
      ensureLoaded();
      setDocsOpen((previous) => toggleKey(previous, key));
    },
    [ensureLoaded],
  );

  const handleToggleBody = useCallback((key: string) => {
    setBodyOpen((previous) => toggleKey(previous, key));
  }, []);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <section className={styles.panel} data-testid="options-panel" aria-label="Options">
      <div className={styles.toolbar}>
        <div className={styles.headerRow}>
          <span className={styles.count} data-testid="options-count">
            {`${filtered.length} / ${schema.options.length}`}
          </span>
          <button
            type="button"
            className={styles.resetAll}
            data-testid="reset-all"
            onClick={onResetAll}
            disabled={!hasModified}
          >
            Reset all
          </button>
        </div>

        <input
          className={styles.search}
          type="search"
          data-testid="options-search"
          aria-label="Search options"
          placeholder="Search options…"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          spellCheck={false}
          autoComplete="off"
        />

        <div className={styles.chips} role="group" aria-label="Filter options">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={entry.id === filter ? styles.chipActive : styles.chip}
              data-testid={entry.testId}
              aria-pressed={entry.id === filter}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {searchActive && docsStatus === "loading" && <p className={styles.hint}>Searching docs…</p>}
        {searchActive && docsStatus === "error" && (
          <p className={styles.hint}>
            Docs unavailable — searching option names only.{" "}
            <button type="button" className={styles.iconButton} onClick={retry}>
              Retry
            </button>
          </p>
        )}
      </div>

      <div ref={scrollRef} className={styles.scroll} data-testid="options-scroll">
        {filtered.length === 0 ? (
          <p className={styles.empty}>No options match.</p>
        ) : (
          <div className={styles.virtualCanvas} style={{ height: virtualizer.getTotalSize() }}>
            {virtualItems.map((virtualItem) => {
              const option = filtered[virtualItem.index];
              if (!option) return null;
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  className={styles.virtualRow}
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  <OptionRow
                    schema={schema}
                    option={option}
                    style={style}
                    modified={modified}
                    docsOpen={docsOpen.has(option.key)}
                    bodyOpen={bodyOpen.has(option.key)}
                    docs={docs}
                    docsStatus={docsStatus}
                    docsError={docsError}
                    onToggleDocs={handleToggleDocs}
                    onToggleBody={handleToggleBody}
                    onRetryDocs={retry}
                    onOptionChange={onOptionChange}
                    onChildChange={onChildChange}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
