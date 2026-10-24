// Focus-trap helpers shared by the two modal surfaces (ConfigDialog, and the
// ConfigDrawer which already had a trap in M3).
//
// The interesting parts are pure data transforms — "is this element a tab
// stop", "which element should receive focus when Tab wraps" — so they can be
// unit-tested in the node environment. `queryTabStops` is the only DOM-bound
// helper, and it feeds those pure functions.
//
// Two modals can technically be open at the same time (App keeps independent
// `dialog.open` / `configOpen` state, e.g. a share-link import while the drawer
// is open). The drawer's overlay paints above the dialog's (z-index 110 vs
// 100), so keyboard handling must follow the same order: the top-most modal is
// the one with the highest `priority`, with open order as the tie-breaker. Only
// that modal traps Tab and handles Escape; closing it hands both back to the
// next one in the stack.

/** Native elements that can receive keyboard focus (drawer's M3 selector plus dialog support). */
export const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export type TabStopCandidate = {
  /** The element's `tabIndex` property (`-1` means programmatically focusable only). */
  tabIndex: number;
  /** Disabled form controls and `aria-disabled` affordances are skipped. */
  disabled?: boolean;
  /** Not rendered (display:none, detached, clipped ancestor) — the browser skips it too. */
  hidden?: boolean;
};

/** True when the browser would visit this element during Tab navigation. */
export function isTabStop(candidate: TabStopCandidate): boolean {
  if (candidate.hidden === true) return false;
  if (candidate.disabled === true) return false;
  return candidate.tabIndex >= 0;
}

/** Keep only real tab stops, preserving document order. */
export function collectTabStops<T extends TabStopCandidate>(candidates: Iterable<T>): T[] {
  const stops: T[] = [];
  for (const candidate of candidates) {
    if (isTabStop(candidate)) stops.push(candidate);
  }
  return stops;
}

export type TabTargetInput = {
  /** Index of the focused element inside the tab-stop list, or `-1` when focus is outside. */
  index: number;
  count: number;
  shiftKey: boolean;
};

/**
 * Index that should receive focus when Tab is pressed inside a modal.
 *
 * Returns `null` when the browser's native tab order is already correct (focus
 * is in the middle of the modal); returns `0` / `count - 1` to wrap forwards or
 * backwards, and when focus escaped the modal entirely. Returns `null` when the
 * modal has no tab stops at all.
 */
export function resolveTabTarget(input: TabTargetInput): number | null {
  const { index, count, shiftKey } = input;
  if (!Number.isInteger(count) || count <= 0) return null;
  if (count === 1) return 0;
  if (!Number.isInteger(index) || index < 0 || index >= count) return shiftKey ? count - 1 : 0;
  if (shiftKey && index === 0) return count - 1;
  if (!shiftKey && index === count - 1) return 0;
  return null;
}

/** A rendered element can actually take focus; use `getClientRects` to reject hidden subtrees. */
function isRendered(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  if (element.closest("[hidden]") !== null) return false;
  return element.getClientRects().length > 0;
}

/** Real tab stops inside `root`, in document order. */
export function queryTabStops(root: ParentNode | null): HTMLElement[] {
  if (root === null) return [];
  const candidates: HTMLElement[] = [];
  for (const element of root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
    candidates.push(element);
  }
  return collectTabStops(
    candidates.map((element) => ({
      element,
      tabIndex: element.tabIndex,
      disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true",
      hidden: !isRendered(element),
    })),
  ).map((candidate) => candidate.element);
}

// ---------------------------------------------------------------------------
// Modal stack
// ---------------------------------------------------------------------------

export type ModalHandle = {
  /** Stable name for diagnostics/tests (`config-dialog`, `config-drawer`). */
  readonly id: string;
  /** Paint order: a higher priority modal wins while both are open (mirrors z-index). */
  readonly priority: number;
  /** Registration order, used when priorities tie. */
  readonly order: number;
};

let nextOrder = 1;
const stack: ModalHandle[] = [];

/**
 * Announce an open modal. Call once per open transition and pass the returned
 * handle to `unregisterModal` on close.
 */
export function registerModal(id: string, priority = 0): ModalHandle {
  const handle: ModalHandle = { id, priority, order: nextOrder };
  nextOrder += 1;
  stack.push(handle);
  return handle;
}

/** Stop announcing a closed modal. Unknown/stale handles are ignored. */
export function unregisterModal(handle: ModalHandle): void {
  const index = stack.indexOf(handle);
  if (index >= 0) stack.splice(index, 1);
}

/** The modal that currently owns Tab and Escape, or `null` when none is open. */
export function topModal(): ModalHandle | null {
  let best: ModalHandle | null = null;
  for (const handle of stack) {
    if (best === null || handle.priority > best.priority || (handle.priority === best.priority && handle.order > best.order)) {
      best = handle;
    }
  }
  return best;
}

/** True when this modal is the one allowed to trap focus and handle Escape. */
export function isTopModal(handle: ModalHandle | null): boolean {
  if (handle === null) return false;
  return topModal() === handle;
}

/** Test-only: clear the stack between cases. */
export function resetModalStack(): void {
  stack.length = 0;
  nextOrder = 1;
}

/** Paint priorities shared with the CSS overlays (`z-index`). */
export const MODAL_PRIORITY = { dialog: 100, drawer: 110 } as const;
