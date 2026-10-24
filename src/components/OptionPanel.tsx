// The options panel (contract §4): a virtualized, searchable, filterable list of
// every clang-format option for the current schema version. It is a pure
// presentational component — all state lives in App's reducer, the panel only
// derives display values and reports edits upward.
//
// M4 adds a roving keyboard model on top of the virtualizer: the list is one Tab
// stop (the active row), and arrow keys move that stop across all N options even
// though only a couple of dozen rows exist in the DOM. The index arithmetic lives
// in `roving.ts`; this file only wires it to scroll + focus.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";

import { isModified, type Modified } from "../lib/config";
import type { OptionDef, SchemaCore, StyleName } from "../lib/schema";
import OptionRow from "./OptionRow";
import {
  clampIndex,
  isRovingNavigationKey,
  nextRovingIndex,
  pageStep,
  resolveActiveIndex,
} from "./roving";
import { prepareDocsHtml, useDocs } from "./useDocs";
import styles from "./OptionPanel.module.css";

export type OptionPanelProps = {
  schema: SchemaCore;
  style: StyleName;
  modified: Modified;
  /** Pass `undefined` to restore the value inherited from the style preset. */
  onOptionChange: (key: string, value: unknown) => void;
  onChildChange: (option: OptionDef, childKey: string, value: unknown) => void;
  onResetAll: () => void;
  /**
   * Optional identity that re-measures every virtual row when it changes.
   *
   * Row heights are derived from the UI font size, which the virtualizer cannot
   * observe on its own; App passes the font-scale key here (M4 UI zoom).
   */
  remeasureKey?: unknown;
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
/** Give up on a focus request if the row never renders (e.g. a filter emptied the list). */
const FOCUS_RETRY_MS = 500;

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
  remeasureKey,
}: OptionPanelProps): JSX.Element {
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [docsOpen, setDocsOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [bodyOpen, setBodyOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Refs mirror the roving state for DOM event handlers and the range extractor,
  // which must not be re-created for every keystroke.
  const activeKeyRef = useRef<string | null>(null);
  activeKeyRef.current = activeKey;
  const activeIndexRef = useRef(-1);

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
  // search is active (189 docs, ~100 KB of HTML). `prepareDocsHtml` makes the
  // index match what the row actually renders (no leaked RST directives).
  const docsText = useMemo(() => {
    if (!searchActive || docs === null) return null;
    const text = new Map<string, string>();
    for (const option of schema.options) {
      const html = docs[option.key];
      if (html !== undefined) text.set(option.key, docsToPlainText(prepareDocsHtml(html)).toLowerCase());
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

  const activeIndex = activeKey === null ? -1 : filtered.findIndex((option) => option.key === activeKey);
  if (activeIndex >= 0) activeIndexRef.current = activeIndex;

  /**
   * Force the active row into the rendered window. Without this, scrolling the
   * list far away from the active row would leave the list without a Tab stop
   * (all other rows have `tabIndex={-1}`), and keyboard users could not get back
   * in. The extractor is re-created when the active index changes so TanStack
   * Virtual's memoized index range is invalidated.
   */
  const rangeExtractor = useCallback(
    (range: Range): number[] => {
      const indexes = defaultRangeExtractor(range);
      if (activeIndex < 0 || activeIndex >= range.count) return indexes;
      if (indexes.includes(activeIndex)) return indexes;
      return [...indexes, activeIndex].sort((a, b) => a - b);
    },
    [activeIndex],
  );

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: OVERSCAN,
    getItemKey: (index) => filtered[index]?.key ?? index,
    rangeExtractor,
  });

  // Search / filter / version changes restart the list at the top and put the
  // roving stop on the first row; anything else (an edit, docs arriving) keeps
  // the active option when it is still visible and clamps the position otherwise.
  const resetKey = `${schema.version}\u0000${query}\u0000${filter}`;
  const previousResetKey = useRef(resetKey);
  useEffect(() => {
    const keys = filtered.map((option) => option.key);
    const listReset = previousResetKey.current !== resetKey;
    previousResetKey.current = resetKey;
    const nextIndex = listReset
      ? clampIndex(0, keys.length)
      : resolveActiveIndex({
          keys,
          activeKey: activeKeyRef.current,
          previousIndex: activeIndexRef.current,
        });
    activeIndexRef.current = nextIndex;
    const nextKey = nextIndex >= 0 ? (keys[nextIndex] ?? null) : null;
    setActiveKey((current) => (current === nextKey ? current : nextKey));
    if (listReset) virtualizer.scrollToOffset(0);
  }, [filtered, resetKey, virtualizer]);

  // Re-measure every row after a font-size/zoom change (M4: UI font scale).
  //
  // The scale is applied by App's own effect (it writes `--ui-scale` on <html>).
  // Child passive effects run before the parent's, so the work is deferred to an
  // animation frame: by then the effect flush is done and the new font size is
  // active, so reading row geometry forces layout with it.
  //
  // Only the already rendered rows are re-measured; `measure()` is deliberately
  // not called. `measure()` drops the whole size cache but keeps the *stale*
  // measurement records, so a following `measureElement()` computes a zero
  // delta against the old size and the virtualizer stays on its 44 px estimate —
  // exactly the state where rows overlap (ref callbacks are not re-invoked on a
  // re-render and the ResizeObserver only fires when a row's size changes).
  // Re-measuring the mounted rows keeps the cache consistent: unchanged rows are
  // a no-op, changed rows get their new height and the list reflows.
  const measuredKey = useRef(remeasureKey);
  const remeasureFrame = useRef<number | null>(null);
  useEffect(() => {
    if (measuredKey.current === remeasureKey) return;
    measuredKey.current = remeasureKey;
    if (remeasureFrame.current !== null) window.cancelAnimationFrame(remeasureFrame.current);
    remeasureFrame.current = window.requestAnimationFrame(() => {
      remeasureFrame.current = null;
      const container = scrollRef.current;
      if (container === null) return;
      for (const element of container.querySelectorAll<HTMLDivElement>("[data-index]")) {
        virtualizer.measureElement(element);
      }
      // No scrollToIndex here: `resizeItem` anchors the viewport when rows above
      // the fold change height, so re-measuring must not yank a list the user
      // scrolled away from back to the active row.
    });
  }, [remeasureKey, virtualizer]);

  useEffect(
    () => () => {
      if (remeasureFrame.current !== null) window.cancelAnimationFrame(remeasureFrame.current);
    },
    [],
  );

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

  /** Move the roving stop, scroll the row into the (virtual) window and focus it. */
  const moveActiveTo = useCallback(
    (index: number) => {
      const option = filtered[index];
      if (option === undefined) return;
      activeIndexRef.current = index;
      setActiveKey(option.key);
      virtualizer.scrollToIndex(index, { align: "auto" });
      setFocusRequest(index);
    },
    [filtered, virtualizer],
  );

  // Focus happens in a layout effect: the row may only exist after the
  // virtualizer has re-rendered the new window (a jump of 50 rows is not in the
  // DOM yet), and moving focus before the browser processes the next key press
  // keeps fast (key-repeat) navigation from getting stuck on a stale row.
  useLayoutEffect(() => {
    if (focusRequest === null) return;
    const container = scrollRef.current;
    const wrapper = container?.querySelector<HTMLElement>(`[data-index="${focusRequest}"]`);
    const row = wrapper?.firstElementChild;
    if (row instanceof HTMLElement) {
      row.focus();
      setFocusRequest(null);
      return;
    }
    const timer = window.setTimeout(() => setFocusRequest(null), FOCUS_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [focusRequest, virtualizer]);

  const handleRowNavigate = useCallback(
    (index: number, event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isRovingNavigationKey(event.key)) return;
      event.preventDefault();
      // Prefer the committed roving index over the row's captured one: with
      // several key presses in one frame the focused row can still be the
      // previous one while `activeIndexRef` already points at the target.
      const current = activeIndexRef.current >= 0 ? activeIndexRef.current : index;
      const viewport = scrollRef.current?.clientHeight ?? 0;
      const nextIndex = nextRovingIndex({
        key: event.key,
        index: current,
        count: filtered.length,
        pageStep: pageStep(viewport, ROW_ESTIMATE_PX),
      });
      if (nextIndex !== null && nextIndex !== current) moveActiveTo(nextIndex);
    },
    [filtered.length, moveActiveTo],
  );

  /** Focus entering any control of a row makes that row the roving stop. */
  const handleRowFocus = useCallback((key: string) => {
    setActiveKey((current) => (current === key ? current : key));
  }, []);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <section className={styles.panel} data-testid="options-panel" aria-label="Options">
      <div className={styles.toolbar}>
        <div className={styles.headerRow}>
          <span className={styles.count} data-testid="options-count">
            {`${filtered.length} / ${schema.options.length}`}
          </span>
          {/* The visible count is terse ("12 / 189"); this polite live region
              announces the debounced result set without changing what is drawn. */}
          <span className={styles.srOnly} role="status" aria-atomic="true">
            {`${filtered.length} of ${schema.options.length} options shown`}
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
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Retry loading documentation"
              onClick={retry}
            >
              Retry
            </button>
          </p>
        )}
      </div>

      <div ref={scrollRef} className={styles.scroll} data-testid="options-scroll">
        {filtered.length === 0 ? (
          <p className={styles.empty}>No options match.</p>
        ) : (
          <div className={styles.virtualCanvas} style={{ height: virtualizer.getTotalSize() }} role="list">
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
                  // Positioning wrapper only: presenting it keeps the list items
                  // as direct children of the `role="list"` container in the
                  // accessibility tree.
                  role="presentation"
                >
                  <OptionRow
                    schema={schema}
                    option={option}
                    style={style}
                    modified={modified}
                    active={virtualItem.index === activeIndex}
                    posInSet={virtualItem.index + 1}
                    setSize={filtered.length}
                    docsOpen={docsOpen.has(option.key)}
                    bodyOpen={bodyOpen.has(option.key)}
                    docs={docs}
                    docsStatus={docsStatus}
                    docsError={docsError}
                    onNavigate={(event) => handleRowNavigate(virtualItem.index, event)}
                    onFocusRow={handleRowFocus}
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
