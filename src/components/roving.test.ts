import { describe, expect, it } from "vitest";

import {
  clampIndex,
  isRovingNavigationKey,
  nextRovingIndex,
  pageStep,
  resolveActiveIndex,
  rovingTabIndex,
} from "./roving";

// Pure data transform tests: the options panel virtualizes 209 rows, but the
// "which row is next" rules must work for any list length without a DOM.

describe("isRovingNavigationKey", () => {
  it("accepts the six list navigation keys", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"]) {
      expect(isRovingNavigationKey(key)).toBe(true);
    }
  });

  it("ignores keys that belong to the controls inside a row", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "Enter", " ", "Tab", "Escape", "a"]) {
      expect(isRovingNavigationKey(key)).toBe(false);
    }
  });
});

describe("rovingTabIndex", () => {
  it("puts exactly the active row into the tab order", () => {
    expect(rovingTabIndex(true)).toBe(0);
    expect(rovingTabIndex(false)).toBe(-1);
  });
});

describe("clampIndex", () => {
  it("returns -1 for an empty list", () => {
    expect(clampIndex(0, 0)).toBe(-1);
    expect(clampIndex(5, -3)).toBe(-1);
    expect(clampIndex(5, Number.NaN)).toBe(-1);
  });

  it("clamps into range", () => {
    expect(clampIndex(0, 189)).toBe(0);
    expect(clampIndex(188, 189)).toBe(188);
    expect(clampIndex(400, 189)).toBe(188);
    expect(clampIndex(-7, 189)).toBe(0);
  });

  it("starts at the top for a non-finite index", () => {
    expect(clampIndex(Number.POSITIVE_INFINITY, 10)).toBe(0);
    expect(clampIndex(Number.NEGATIVE_INFINITY, 10)).toBe(0);
  });

  it("truncates fractional indexes", () => {
    expect(clampIndex(3.9, 10)).toBe(3);
  });
});

describe("pageStep", () => {
  it("moves one viewport minus a context row", () => {
    expect(pageStep(600, 50)).toBe(11);
    expect(pageStep(500, 44)).toBe(10);
  });

  it("is at least one row", () => {
    expect(pageStep(20, 44)).toBe(1);
    expect(pageStep(0, 44)).toBe(1);
    expect(pageStep(-100, 44)).toBe(1);
    expect(pageStep(600, 0)).toBe(1);
    expect(pageStep(Number.NaN, 44)).toBe(1);
  });
});

describe("nextRovingIndex", () => {
  const count = 189;

  it("returns null for an empty list so nothing gets focused", () => {
    expect(nextRovingIndex({ key: "ArrowDown", index: 0, count: 0, pageStep: 5 })).toBeNull();
    expect(nextRovingIndex({ key: "End", index: 3, count: -1, pageStep: 5 })).toBeNull();
  });

  it("ArrowDown moves one row and stops at the end", () => {
    expect(nextRovingIndex({ key: "ArrowDown", index: 0, count, pageStep: 5 })).toBe(1);
    expect(nextRovingIndex({ key: "ArrowDown", index: 187, count, pageStep: 5 })).toBe(188);
    expect(nextRovingIndex({ key: "ArrowDown", index: 188, count, pageStep: 5 })).toBe(188);
  });

  it("ArrowUp moves one row and stops at the start", () => {
    expect(nextRovingIndex({ key: "ArrowUp", index: 5, count, pageStep: 5 })).toBe(4);
    expect(nextRovingIndex({ key: "ArrowUp", index: 0, count, pageStep: 5 })).toBe(0);
  });

  it("starts at a sensible end when no row is active yet", () => {
    expect(nextRovingIndex({ key: "ArrowDown", index: -1, count, pageStep: 5 })).toBe(0);
    expect(nextRovingIndex({ key: "PageDown", index: -1, count, pageStep: 5 })).toBe(0);
    expect(nextRovingIndex({ key: "ArrowUp", index: -1, count, pageStep: 5 })).toBe(188);
  });

  it("Home and End jump to the bounds", () => {
    expect(nextRovingIndex({ key: "Home", index: 120, count, pageStep: 5 })).toBe(0);
    expect(nextRovingIndex({ key: "End", index: 2, count, pageStep: 5 })).toBe(188);
  });

  it("PageDown and PageUp clamp to the bounds", () => {
    expect(nextRovingIndex({ key: "PageDown", index: 10, count, pageStep: 10 })).toBe(20);
    expect(nextRovingIndex({ key: "PageUp", index: 10, count, pageStep: 10 })).toBe(0);
    expect(nextRovingIndex({ key: "PageDown", index: 185, count, pageStep: 10 })).toBe(188);
    expect(nextRovingIndex({ key: "PageUp", index: 3, count, pageStep: 10 })).toBe(0);
  });

  it("recovers from a stale out-of-range index", () => {
    expect(nextRovingIndex({ key: "ArrowDown", index: 500, count, pageStep: 5 })).toBe(0);
    expect(nextRovingIndex({ key: "ArrowUp", index: 500, count, pageStep: 5 })).toBe(188);
  });

  it("never escapes the list for a single-row list", () => {
    expect(nextRovingIndex({ key: "ArrowDown", index: 0, count: 1, pageStep: 10 })).toBe(0);
    expect(nextRovingIndex({ key: "ArrowUp", index: 0, count: 1, pageStep: 10 })).toBe(0);
    expect(nextRovingIndex({ key: "PageDown", index: 0, count: 1, pageStep: 10 })).toBe(0);
    expect(nextRovingIndex({ key: "PageUp", index: 0, count: 1, pageStep: 10 })).toBe(0);
  });
});

describe("resolveActiveIndex", () => {
  const keys = ["AlignAfterOpenBracket", "IndentWidth", "ColumnLimit"];

  it("returns -1 when nothing is visible", () => {
    expect(resolveActiveIndex({ keys: [], activeKey: "IndentWidth", previousIndex: 3 })).toBe(-1);
    expect(resolveActiveIndex({ keys: [], activeKey: null, previousIndex: 0 })).toBe(-1);
  });

  it("keeps the active option when it is still visible", () => {
    expect(resolveActiveIndex({ keys, activeKey: "ColumnLimit", previousIndex: 8 })).toBe(2);
  });

  it("clamps the previous position when the active option was filtered out", () => {
    // A search widened the list: the old position stays meaningful.
    expect(resolveActiveIndex({ keys, activeKey: "RemovedByFilter", previousIndex: 2 })).toBe(2);
    // A filter narrowed the list far below the old position.
    expect(resolveActiveIndex({ keys, activeKey: "NotVisible", previousIndex: 120 })).toBe(2);
  });

  it("starts the list at the top when there is no active row yet", () => {
    expect(resolveActiveIndex({ keys, activeKey: null, previousIndex: -1 })).toBe(0);
  });

  it("never returns an index that points at a hidden row", () => {
    // Simulates a version switch: the persisted key no longer exists.
    const index = resolveActiveIndex({ keys, activeKey: "Language", previousIndex: 0 });
    expect(keys[index]).toBe("AlignAfterOpenBracket");
  });
});
