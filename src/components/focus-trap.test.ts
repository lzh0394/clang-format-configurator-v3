import { afterEach, describe, expect, it } from "vitest";

import {
  collectTabStops,
  isTabStop,
  isTopModal,
  MODAL_PRIORITY,
  registerModal,
  resetModalStack,
  resolveTabTarget,
  topModal,
  unregisterModal,
  type TabStopCandidate,
} from "./focus-trap";

// Pure focus-trap logic: the browser DOM is exercised by the e2e suite, while
// these tests pin the rules that decide which element Tab reaches and which
// modal owns the keyboard when two are open.

describe("isTabStop", () => {
  it("accepts elements with a non-negative tabIndex", () => {
    expect(isTabStop({ tabIndex: 0 })).toBe(true);
    expect(isTabStop({ tabIndex: 3 })).toBe(true);
  });

  it("rejects programmatically-only focus targets", () => {
    expect(isTabStop({ tabIndex: -1 })).toBe(false);
  });

  it("rejects disabled and non-rendered elements", () => {
    expect(isTabStop({ tabIndex: 0, disabled: true })).toBe(false);
    expect(isTabStop({ tabIndex: 0, hidden: true })).toBe(false);
    expect(isTabStop({ tabIndex: 0, disabled: false, hidden: false })).toBe(true);
  });
});

describe("collectTabStops", () => {
  it("keeps document order and filters non-stops", () => {
    const candidates: TabStopCandidate[] = [
      { tabIndex: 0 },
      { tabIndex: -1 },
      { tabIndex: 0, disabled: true },
      { tabIndex: 0, hidden: true },
      { tabIndex: 0 },
    ];
    expect(collectTabStops(candidates)).toEqual([{ tabIndex: 0 }, { tabIndex: 0 }]);
  });

  it("returns an empty list when nothing is focusable", () => {
    expect(collectTabStops([])).toEqual([]);
    expect(collectTabStops([{ tabIndex: -1 }])).toEqual([]);
  });
});

describe("resolveTabTarget", () => {
  it("lets the browser move focus in the middle of the modal", () => {
    expect(resolveTabTarget({ index: 1, count: 3, shiftKey: false })).toBeNull();
    expect(resolveTabTarget({ index: 1, count: 3, shiftKey: true })).toBeNull();
  });

  it("wraps forwards from the last stop to the first", () => {
    expect(resolveTabTarget({ index: 2, count: 3, shiftKey: false })).toBe(0);
  });

  it("wraps backwards from the first stop to the last", () => {
    expect(resolveTabTarget({ index: 0, count: 3, shiftKey: true })).toBe(2);
  });

  it("pulls focus back into the modal when it is outside", () => {
    expect(resolveTabTarget({ index: -1, count: 3, shiftKey: false })).toBe(0);
    expect(resolveTabTarget({ index: -1, count: 3, shiftKey: true })).toBe(2);
    // A stale index (the focused control was removed) behaves like outside.
    expect(resolveTabTarget({ index: 7, count: 3, shiftKey: false })).toBe(0);
    expect(resolveTabTarget({ index: 7, count: 3, shiftKey: true })).toBe(2);
  });

  it("handles a single-stop modal by keeping focus on it", () => {
    expect(resolveTabTarget({ index: 0, count: 1, shiftKey: false })).toBe(0);
    expect(resolveTabTarget({ index: 0, count: 1, shiftKey: true })).toBe(0);
  });

  it("does nothing when the modal has no tab stops", () => {
    expect(resolveTabTarget({ index: -1, count: 0, shiftKey: false })).toBeNull();
    expect(resolveTabTarget({ index: 0, count: -4, shiftKey: true })).toBeNull();
  });
});

describe("modal stack", () => {
  afterEach(() => {
    resetModalStack();
  });

  it("tracks open/closed modals", () => {
    const dialog = registerModal("config-dialog", MODAL_PRIORITY.dialog);
    expect(isTopModal(dialog)).toBe(true);
    unregisterModal(dialog);
    expect(topModal()).toBeNull();
    expect(isTopModal(dialog)).toBe(false);
  });

  it("the later modal wins when priorities tie", () => {
    const first = registerModal("first", 0);
    const second = registerModal("second", 0);
    expect(isTopModal(first)).toBe(false);
    expect(isTopModal(second)).toBe(true);
  });

  it("a higher z-index modal wins regardless of open order (drawer over dialog)", () => {
    const dialog = registerModal("config-dialog", MODAL_PRIORITY.dialog);
    const drawer = registerModal("config-drawer", MODAL_PRIORITY.drawer);
    expect(isTopModal(drawer)).toBe(true);
    expect(isTopModal(dialog)).toBe(false);

    // Even when the dialog is opened last, the drawer paints above it.
    unregisterModal(drawer);
    const dialogAgain = registerModal("config-dialog", MODAL_PRIORITY.dialog);
    const drawerAgain = registerModal("config-drawer", MODAL_PRIORITY.drawer);
    expect(isTopModal(drawerAgain)).toBe(true);
    expect(isTopModal(dialogAgain)).toBe(false);
  });

  it("hands the keyboard back when the top modal closes", () => {
    const dialog = registerModal("config-dialog", MODAL_PRIORITY.dialog);
    const drawer = registerModal("config-drawer", MODAL_PRIORITY.drawer);
    expect(isTopModal(drawer)).toBe(true);

    unregisterModal(drawer);
    expect(topModal()).toBe(dialog);
    expect(isTopModal(dialog)).toBe(true);
  });

  it("ignores stale handles", () => {
    const dialog = registerModal("config-dialog", MODAL_PRIORITY.dialog);
    unregisterModal(dialog);
    unregisterModal(dialog);
    expect(topModal()).toBeNull();
  });
});
