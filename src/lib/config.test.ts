import { describe, expect, it } from "vitest";
import {
  effectiveChildValue,
  effectiveValue,
  formatValue,
  isModified,
  setChildOption,
  setOption,
  type Modified,
} from "./config";
import type { OptionDef } from "./schema";

const indentWidth: OptionDef = {
  key: "IndentWidth",
  type: { kind: "scalar", scalar: "uint" },
  deprecated: false,
  defaults: { LLVM: 2, Google: 2, Chromium: 2, Mozilla: 2, WebKit: 4, Microsoft: 4, GNU: 2 },
};

const braceWrapping: OptionDef = {
  key: "BraceWrapping",
  type: {
    kind: "map",
    children: [
      { key: "AfterClass", type: { kind: "scalar", scalar: "bool" } },
      { key: "AfterControlStatement", type: { kind: "enum", values: ["Never", "MultiLine", "Always"] } },
    ],
  },
  deprecated: false,
  defaults: {
    LLVM: { AfterClass: false, AfterControlStatement: "Never" },
    GNU: { AfterClass: true, AfterControlStatement: "Always" },
  },
};

const includeCategories: OptionDef = {
  key: "IncludeCategories",
  type: {
    kind: "list",
    item: "struct",
    fields: [
      { key: "Regex", type: { kind: "scalar", scalar: "string" } },
      { key: "Priority", type: { kind: "scalar", scalar: "int" } },
    ],
  },
  deprecated: false,
  defaults: { LLVM: [{ Regex: ".*", Priority: 1 }] },
};

describe("effectiveValue", () => {
  it("falls back to the preset and then to undefined", () => {
    expect(effectiveValue(indentWidth, "LLVM", {})).toBe(2);
    expect(effectiveValue(indentWidth, "WebKit", {})).toBe(4);
    expect(effectiveValue(indentWidth, "LLVM", { IndentWidth: 8 })).toBe(8);
    expect(effectiveValue({ ...indentWidth, defaults: {} }, "LLVM", {})).toBeUndefined();
  });

  it("merges a sparse map override over the preset", () => {
    expect(effectiveValue(braceWrapping, "LLVM", {})).toEqual({
      AfterClass: false,
      AfterControlStatement: "Never",
    });
    expect(effectiveValue(braceWrapping, "LLVM", { BraceWrapping: { AfterClass: true } })).toEqual({
      AfterClass: true,
      AfterControlStatement: "Never",
    });
    expect(effectiveChildValue(braceWrapping, "AfterControlStatement", "GNU", {})).toBe("Always");
  });

  it("treats lists as whole values", () => {
    const list = [{ Regex: "*.h", Priority: 2 }];
    expect(effectiveValue(includeCategories, "LLVM", { IncludeCategories: list })).toBe(list);
    expect(effectiveValue(includeCategories, "LLVM", {})).toEqual([{ Regex: ".*", Priority: 1 }]);
  });
});

describe("setOption", () => {
  it("stores explicit values and deletes them on undefined", () => {
    const modified = setOption({}, "IndentWidth", 4);
    expect(modified).toEqual({ IndentWidth: 4 });
    expect(isModified(modified, "IndentWidth")).toBe(true);
    expect(setOption(modified, "IndentWidth", undefined)).toEqual({});
  });

  it("does not mutate the input", () => {
    const before: Modified = { IndentWidth: 4 };
    setOption(before, "ColumnLimit", 80);
    expect(before).toEqual({ IndentWidth: 4 });
  });
});

describe("setChildOption", () => {
  it("keeps map overrides sparse and removes the key when the last child resets", () => {
    let modified: Modified = {};
    modified = setChildOption(modified, braceWrapping, "AfterClass", true);
    expect(modified).toEqual({ BraceWrapping: { AfterClass: true } });
    modified = setChildOption(modified, braceWrapping, "AfterControlStatement", "Always");
    expect(modified).toEqual({ BraceWrapping: { AfterClass: true, AfterControlStatement: "Always" } });
    modified = setChildOption(modified, braceWrapping, "AfterClass", undefined);
    expect(modified).toEqual({ BraceWrapping: { AfterControlStatement: "Always" } });
    modified = setChildOption(modified, braceWrapping, "AfterControlStatement", undefined);
    expect(modified).toEqual({});
  });
});

describe("formatValue", () => {
  it("renders primitives, structures and unset values", () => {
    expect(formatValue(undefined)).toBe("—");
    expect(formatValue(true)).toBe("true");
    expect(formatValue(4)).toBe("4");
    expect(formatValue("")).toBe('""');
    expect(formatValue("Always")).toBe("Always");
    expect(formatValue(["a", "b"])).toBe('["a","b"]');
    expect(formatValue({ Enabled: true })).toBe('{"Enabled":true}');
  });
});
