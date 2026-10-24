// Roving keyboard model for the virtualized options panel (M4 a11y).
//
// The list is a single Tab stop: exactly one row (the "active" row) is in the
// tab order at a time, and arrow keys move that stop across *all* options, not
// only the rows the virtualizer currently renders. Everything the component
// needs to decide "which row is next" lives here as pure data transforms so it
// can be unit-tested without React, the DOM or TanStack Virtual.

/** Keys the options list uses to move its active row. */
export type RovingNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End" | "PageDown" | "PageUp";

const ROVING_NAVIGATION_KEYS: ReadonlySet<string> = new Set<RovingNavigationKey>([
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
  "PageDown",
  "PageUp",
]);

/** True for the keys that drive the roving tab stop (`event.key` values). */
export function isRovingNavigationKey(key: string): key is RovingNavigationKey {
  return ROVING_NAVIGATION_KEYS.has(key);
}

/** The tab stop is the active row; every other row is only programmatically focusable. */
export function rovingTabIndex(isActive: boolean): 0 | -1 {
  return isActive ? 0 : -1;
}

/**
 * Clamp an index into `[0, count - 1]`.
 *
 * Returns `-1` for an empty list. Negative or non-finite input starts at the
 * top: the list always has a meaningful active row while it has any rows.
 */
export function clampIndex(index: number, count: number): number {
  if (!Number.isInteger(count) || count <= 0) return -1;
  if (!Number.isFinite(index)) return 0;
  const truncated = Math.trunc(index);
  if (truncated < 0) return 0;
  return Math.min(truncated, count - 1);
}

/**
 * How many rows PageUp/PageDown move: one viewport minus one row of context, so
 * the row that was at the top stays visible at the bottom after the jump.
 */
export function pageStep(viewportPx: number, itemPx: number): number {
  if (!Number.isFinite(viewportPx) || !Number.isFinite(itemPx) || viewportPx <= 0 || itemPx <= 0) return 1;
  const visibleRows = Math.floor(viewportPx / itemPx);
  return Math.max(1, visibleRows - 1);
}

export type RovingMove = {
  key: RovingNavigationKey;
  /** Currently active index, or `-1` when the list has no active row yet. */
  index: number;
  count: number;
  /** Rows per PageUp/PageDown; see `pageStep`. */
  pageStep: number;
};

/**
 * The index a navigation key should activate, or `null` when the list is empty
 * (nothing to focus). The result is always inside `[0, count - 1]`.
 */
export function nextRovingIndex(move: RovingMove): number | null {
  const { key, count } = move;
  if (!Number.isInteger(count) || count <= 0) return null;
  const last = count - 1;
  const current = move.index >= 0 && move.index <= last ? move.index : -1;

  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : Math.min(current + 1, last);
    case "ArrowUp":
      return current < 0 ? last : Math.max(current - 1, 0);
    case "Home":
      return 0;
    case "End":
      return last;
    case "PageDown": {
      const step = Math.max(1, Math.trunc(move.pageStep));
      return current < 0 ? 0 : Math.min(current + step, last);
    }
    case "PageUp": {
      const step = Math.max(1, Math.trunc(move.pageStep));
      return current < 0 ? 0 : Math.max(current - step, 0);
    }
    default:
      return null;
  }
}

export type ActiveIndexInput = {
  /** Keys of the currently visible (filtered) options, in display order. */
  keys: readonly string[];
  /** The option the roving stop currently points at, if any. */
  activeKey: string | null;
  /** Where that active row used to be; used to converge after filtering. */
  previousIndex: number;
};

/**
 * Index that should hold the roving tab stop after the visible option set
 * changed (search, filter chips, version switch).
 *
 * Keeping the option key when it is still visible means searching for a term
 * does not move the stop away from the row the user is on; otherwise the old
 * position is clamped into the new list, so the stop never points at a hidden
 * or out-of-range row. Returns `-1` when nothing is visible.
 */
export function resolveActiveIndex(input: ActiveIndexInput): number {
  const count = input.keys.length;
  if (count === 0) return -1;
  if (input.activeKey !== null) {
    const found = input.keys.indexOf(input.activeKey);
    if (found >= 0) return found;
  }
  return clampIndex(input.previousIndex, count);
}
