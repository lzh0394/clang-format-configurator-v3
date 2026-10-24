// Tests for the `modified` diff used by the configuration drawer preview.
//
// The important subtlety: map options are stored as sparse patches, so two
// structurally equal patches must compare equal even if their object keys were
// inserted in a different order.

import { describe, expect, it } from "vitest";

import type { Modified } from "./config";
import { deepEqual, diffModified } from "./config-diff";

const schemaOrder = [
  "BasedOnStyle",
  "IndentWidth",
  "ColumnLimit",
  "BraceWrapping",
  "ForEachMacros",
  "IncludeCategories",
  "SortIncludes",
];

describe("deepEqual", () => {
  it("compares primitives with Object.is", () => {
    expect(deepEqual(2, 2)).toBe(true);
    expect(deepEqual("LLVM", "LLVM")).toBe(true);
    expect(deepEqual(true, false)).toBe(false);
    expect(deepEqual(0, -0)).toBe(false);
  });

  it("compares plain objects order-insensitively", () => {
    expect(deepEqual({ a: 1, b: true }, { b: true, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 1 })).toBe(false);
  });

  it("compares arrays element-wise and order-sensitively", () => {
    expect(deepEqual(["a", "b"], ["a", "b"])).toBe(true);
    expect(deepEqual(["a", "b"], ["b", "a"])).toBe(false);
    expect(deepEqual([{ IndentWidth: 4 }], [{ IndentWidth: 4 }])).toBe(true);
  });
});

describe("diffModified", () => {
  it("reports no change for identical (including empty) maps", () => {
    expect(diffModified({}, {})).toEqual({ added: [], removed: [], changed: [] });
    expect(diffModified({ IndentWidth: 4 }, { IndentWidth: 4 })).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it("classifies added, removed and changed top-level keys", () => {
    const current: Modified = { IndentWidth: 2, ColumnLimit: 80 };
    const next: Modified = { IndentWidth: 4, ColumnLimit: 80, SortIncludes: true };

    expect(diffModified(current, next)).toEqual({
      added: ["SortIncludes"],
      removed: [],
      changed: ["IndentWidth"],
    });
  });

  it("treats an equal sparse map patch as unchanged but an extra child as changed", () => {
    const current: Modified = { BraceWrapping: { AfterClass: true } };
    const equal: Modified = { BraceWrapping: { AfterClass: true } };
    const extended: Modified = { BraceWrapping: { AfterClass: true, AfterEnum: true } };

    expect(diffModified(current, equal).changed).toEqual([]);
    expect(diffModified(current, extended).changed).toEqual(["BraceWrapping"]);
  });

  it("does not confuse inserting the same children in another order", () => {
    const current: Modified = { BraceWrapping: { AfterClass: true, AfterEnum: false } };
    const next: Modified = { BraceWrapping: { AfterEnum: false, AfterClass: true } };

    expect(diffModified(current, next)).toEqual({ added: [], removed: [], changed: [] });
  });

  it("treats list values as changed when items are added or reordered", () => {
    const current: Modified = { ForEachMacros: ["Q_FOREACH"] };
    expect(diffModified(current, { ForEachMacros: ["Q_FOREACH", "BOOST_FOREACH"] }).changed).toEqual([
      "ForEachMacros",
    ]);
    expect(diffModified({ ForEachMacros: ["a", "b"] }, { ForEachMacros: ["b", "a"] }).changed).toEqual([
      "ForEachMacros",
    ]);
  });

  it("compares struct lists structurally and ignores key order inside an item", () => {
    const current: Modified = {
      IncludeCategories: [{ Regex: "^\"", Priority: 3 }],
    };
    const reordered: Modified = {
      IncludeCategories: [{ Priority: 3, Regex: "^\"", SortPriority: 1 }],
    };
    // Same first item (fields in another order), extra second item -> changed.
    const extended: Modified = {
      IncludeCategories: [{ Priority: 3, Regex: "^\"", SortPriority: 1 }, { Regex: "^<", Priority: 1 }],
    };

    // `reordered` gains a field, so it is a change; the same fields in another
    // order are not.
    expect(diffModified(current, reordered).changed).toEqual(["IncludeCategories"]);
    expect(diffModified(reordered, { IncludeCategories: [{ SortPriority: 1, Regex: "^\"", Priority: 3 }] })).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
    expect(diffModified(current, extended).changed).toEqual(["IncludeCategories"]);
  });

  it("emits keys in the supplied schema order, then remaining keys alphabetically", () => {
    const current: Modified = {};
    const next: Modified = {
      SortIncludes: true,
      UnknownZ: 1,
      BraceWrapping: { AfterClass: true },
      UnknownA: 1,
      IndentWidth: 4,
    };

    expect(diffModified(current, next, schemaOrder).added).toEqual([
      "IndentWidth",
      "BraceWrapping",
      "SortIncludes",
      "UnknownA",
      "UnknownZ",
    ]);
  });

  it("ignores keys whose value is explicitly undefined", () => {
    const current: Modified = { IndentWidth: 4, ColumnLimit: undefined };
    const next: Modified = { IndentWidth: 4 };

    expect(diffModified(current, next, schemaOrder)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it("reports removal of a key with a sparse map value", () => {
    const current: Modified = { BraceWrapping: { AfterClass: true } };
    expect(diffModified(current, {}, schemaOrder)).toEqual({
      added: [],
      removed: ["BraceWrapping"],
      changed: [],
    });
  });
});
