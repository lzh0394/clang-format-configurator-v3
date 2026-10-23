// Tests for `.clang-format` import / export (M1 contract §3).
//
// The focused cases use a small hand-built schema so every rule is easy to
// assert precisely; the roundtrip cases use the real committed 21.1.8 schema
// loaded from disk, which is also what the app ships.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Modified } from "./config";
import {
  CONFIG_FILENAME,
  ImportError,
  parseConfigText,
  serializeConfig,
  type ExportMode,
  type ImportResult,
  type ImportWarning,
} from "./config-io";
import type { OptionDef, SchemaCore, StyleName } from "./schema";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const testOptions: OptionDef[] = [
  {
    key: "IndentWidth",
    type: { kind: "scalar", scalar: "uint" },
    deprecated: false,
    defaults: { LLVM: 2, Google: 2 },
  },
  {
    key: "AccessModifierOffset",
    type: { kind: "scalar", scalar: "int" },
    deprecated: false,
    defaults: { LLVM: -2, Google: -1 },
  },
  {
    key: "Standard",
    type: { kind: "enum", values: ["c++03", "c++11", "Latest", "Auto"] },
    deprecated: false,
    defaults: { LLVM: "Latest", Google: "Auto" },
  },
  {
    key: "DeriveLineEnding",
    type: { kind: "scalar", scalar: "bool" },
    deprecated: false,
    defaults: {},
  },
  {
    key: "CommentPragmas",
    type: { kind: "scalar", scalar: "string" },
    deprecated: false,
    defaults: { LLVM: "^ IWYU pragma:", Google: "^ IWYU pragma:" },
  },
  {
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
      Google: { AfterClass: false, AfterControlStatement: "Never" },
    },
  },
  {
    key: "AlignConsecutiveMacros",
    type: {
      kind: "map",
      children: [
        { key: "Enabled", type: { kind: "scalar", scalar: "bool" } },
        { key: "AcrossEmptyLines", type: { kind: "scalar", scalar: "bool" } },
        { key: "AcrossComments", type: { kind: "scalar", scalar: "bool" } },
        { key: "PadOperators", type: { kind: "scalar", scalar: "bool" } },
      ],
    },
    deprecated: false,
    defaults: {
      LLVM: { Enabled: false, AcrossEmptyLines: false, AcrossComments: false, PadOperators: false },
      Google: { Enabled: false, AcrossEmptyLines: false, AcrossComments: false, PadOperators: false },
    },
  },
  {
    key: "AlignTrailingComments",
    type: {
      kind: "map",
      children: [
        { key: "Kind", type: { kind: "enum", values: ["Leave", "Always", "Never"] } },
        { key: "OverEmptyLines", type: { kind: "scalar", scalar: "uint" } },
      ],
    },
    deprecated: false,
    defaults: {
      LLVM: { Kind: "Always", OverEmptyLines: 0 },
      Google: { Kind: "Always", OverEmptyLines: 0 },
    },
  },
  {
    key: "ForEachMacros",
    type: { kind: "list", item: "string" },
    deprecated: false,
    defaults: { LLVM: ["foreach", "Q_FOREACH"], Google: ["foreach"] },
  },
  {
    key: "IncludeCategories",
    type: {
      kind: "list",
      item: "struct",
      fields: [
        { key: "Regex", type: { kind: "scalar", scalar: "string" } },
        { key: "Priority", type: { kind: "scalar", scalar: "int" } },
        { key: "SortPriority", type: { kind: "scalar", scalar: "int" } },
        { key: "CaseSensitive", type: { kind: "scalar", scalar: "bool" } },
      ],
    },
    deprecated: false,
    defaults: {
      LLVM: [{ Regex: ".*", Priority: 1, SortPriority: 0, CaseSensitive: false }],
      Google: [{ Regex: ".*", Priority: 1, SortPriority: 0, CaseSensitive: false }],
    },
  },
  {
    key: "RawStringFormats",
    type: {
      kind: "list",
      item: "struct",
      fields: [
        { key: "Language", type: { kind: "enum", values: ["Cpp", "TextProto"] } },
        { key: "Delimiters", type: { kind: "list", item: "string" } },
        { key: "EnclosingFunctions", type: { kind: "list", item: "string" } },
        { key: "CanonicalDelimiter", type: { kind: "scalar", scalar: "string" } },
        { key: "BasedOnStyle", type: { kind: "enum", values: ["LLVM", "Google"] } },
      ],
    },
    deprecated: false,
    defaults: {
      LLVM: [],
      // Mirrors the real schema: the enum preset is written in lowercase.
      Google: [{ Language: "Cpp", Delimiters: ["cc", "CPP"], CanonicalDelimiter: "", BasedOnStyle: "google" }],
    },
  },
];

const testSchema: SchemaCore = {
  version: "test-1",
  build: "test",
  tag: "test",
  styles: ["LLVM", "Google"],
  options: testOptions,
};

/** The real committed schema the app ships, loaded from disk (node only). */
const realSchema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../public/schema/21.1.8/core.json", import.meta.url)), "utf8"),
) as SchemaCore;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function importError(text: string, schema: SchemaCore = testSchema): ImportError {
  try {
    parseConfigText(text, schema);
  } catch (error) {
    if (error instanceof ImportError) return error;
    throw error;
  }
  throw new Error("expected parseConfigText to throw ImportError");
}

function firstWarning(result: ImportResult): ImportWarning {
  const [warning] = result.warnings;
  if (!warning) throw new Error("expected at least one warning");
  return warning;
}

/**
 * Export -> parse -> export and assert byte equality. Returns both strings so
 * tests can inspect the YAML / parsed result further.
 */
function expectRoundtrip(
  schema: SchemaCore,
  style: StyleName,
  modified: Modified,
  mode: ExportMode,
): { first: string; parsed: ImportResult } {
  const first = serializeConfig(schema, style, modified, mode);
  const parsed = parseConfigText(first, schema);
  expect(parsed.style).toBe(style);
  const second = serializeConfig(schema, parsed.style ?? style, parsed.modified, mode);
  expect(second).toBe(first);
  return { first, parsed };
}

function expectSingleTrailingNewline(text: string): void {
  expect(text.endsWith("\n")).toBe(true);
  expect(text.endsWith("\n\n")).toBe(false);
  expect(text).not.toContain("\r");
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe("CONFIG_FILENAME", () => {
  it("is the conventional .clang-format name", () => {
    expect(CONFIG_FILENAME).toBe(".clang-format");
  });
});

describe("serializeConfig — minimal", () => {
  it("writes only BasedOnStyle when nothing was modified", () => {
    const yaml = serializeConfig(testSchema, "LLVM", {}, "minimal");
    expect(yaml).toBe("BasedOnStyle: LLVM\n");
    expectSingleTrailingNewline(yaml);
  });

  it("defaults to minimal mode", () => {
    expect(serializeConfig(testSchema, "Google", { IndentWidth: 4 })).toBe(
      "BasedOnStyle: Google\nIndentWidth: 4\n",
    );
  });

  it("writes modified options in schema order, not modification order", () => {
    // RawStringFormats is the last option in the fixture; IndentWidth is first.
    const yaml = serializeConfig(
      testSchema,
      "LLVM",
      { RawStringFormats: [], IndentWidth: 4 },
      "minimal",
    );
    expect(yaml).toBe("BasedOnStyle: LLVM\nIndentWidth: 4\nRawStringFormats: []\n");
    expect(yaml.indexOf("IndentWidth:")).toBeLessThan(yaml.indexOf("RawStringFormats:"));
  });

  it("writes map values as sparse patches", () => {
    const yaml = serializeConfig(testSchema, "LLVM", { BraceWrapping: { AfterClass: true } }, "minimal");
    expect(yaml).toBe("BasedOnStyle: LLVM\nBraceWrapping:\n  AfterClass: true\n");
  });

  it("writes list values as full arrays", () => {
    const yaml = serializeConfig(testSchema, "LLVM", { ForEachMacros: ["A", "B"] }, "minimal");
    expect(yaml).toBe("BasedOnStyle: LLVM\nForEachMacros:\n  - A\n  - B\n");
  });

  it("writes struct lists with the modified items as-is", () => {
    const modified: Modified = {
      IncludeCategories: [{ Regex: ".*", Priority: 1, SortPriority: 0, CaseSensitive: false }],
    };
    const yaml = serializeConfig(testSchema, "LLVM", modified, "minimal");
    expect(yaml).toContain("IncludeCategories:\n  - Regex: .*\n    Priority: 1");
  });

  it("canonicalizes enum values (case-insensitive)", () => {
    expect(serializeConfig(testSchema, "LLVM", { Standard: "latest" }, "minimal")).toBe(
      "BasedOnStyle: LLVM\nStandard: Latest\n",
    );
  });

  it("canonicalizes enums nested in map and struct-list values", () => {
    const yaml = serializeConfig(
      testSchema,
      "LLVM",
      {
        BraceWrapping: { AfterControlStatement: "always" },
        RawStringFormats: [{ Language: "cpp", BasedOnStyle: "google" }],
      },
      "minimal",
    );
    expect(yaml).toContain("AfterControlStatement: Always");
    expect(yaml).toContain("Language: Cpp");
    expect(yaml).toContain("BasedOnStyle: Google");
    expect(yaml).not.toContain("always");
    expect(yaml).not.toContain("cpp");
    expect(yaml).not.toContain("google");
  });

  it("writes unknown enum values as-is", () => {
    expect(serializeConfig(testSchema, "LLVM", { Standard: "C++2b" }, "minimal")).toBe(
      "BasedOnStyle: LLVM\nStandard: C++2b\n",
    );
  });

  it("ignores undefined values and keys that are not in the schema", () => {
    const modified = { IndentWidth: undefined, NotAnOption: 1 } as Modified;
    expect(serializeConfig(testSchema, "LLVM", modified, "minimal")).toBe("BasedOnStyle: LLVM\n");
  });

  it("never emits document markers, comments or multiple trailing newlines", () => {
    const yaml = serializeConfig(realSchema, "Google", { IndentWidth: 4 }, "minimal");
    expect(yaml).not.toMatch(/^---$/m);
    expect(yaml).not.toMatch(/^\.\.\.$/m);
    expect(yaml.startsWith("BasedOnStyle: ")).toBe(true);
    expectSingleTrailingNewline(yaml);
  });
});

describe("serializeConfig — full", () => {
  it("writes every option that has an effective value, skipping options without a preset", () => {
    const yaml = serializeConfig(testSchema, "LLVM", {}, "full");
    // Materialized defaults.
    expect(yaml).toContain("IndentWidth: 2");
    expect(yaml).toContain("AccessModifierOffset: -2");
    expect(yaml).toContain("Standard: Latest");
    expect(yaml).toContain("ForEachMacros:");
    expect(yaml).toContain("RawStringFormats: []");
    // No preset for LLVM and not modified -> skipped.
    expect(yaml).not.toContain("DeriveLineEnding");
    // Options still follow schema order.
    expect(yaml.indexOf("IndentWidth:")).toBeLessThan(yaml.indexOf("AccessModifierOffset:"));
    expectSingleTrailingNewline(yaml);
  });

  it("writes an option without a preset once it is modified", () => {
    const yaml = serializeConfig(testSchema, "LLVM", { DeriveLineEnding: true }, "full");
    expect(yaml).toContain("DeriveLineEnding: true");
  });

  it("merges a sparse map patch over the preset into a full mapping", () => {
    const yaml = serializeConfig(testSchema, "LLVM", { BraceWrapping: { AfterClass: true } }, "full");
    expect(yaml).toContain("BraceWrapping:\n  AfterClass: true\n  AfterControlStatement: Never");
  });

  it("uses the selected style for preset values", () => {
    const yaml = serializeConfig(testSchema, "Google", {}, "full");
    expect(yaml).toContain("AccessModifierOffset: -1");
    expect(yaml).toContain("Standard: Auto");
  });

  it("canonicalizes enum presets in nested values (lowercase schema defaults)", () => {
    const yaml = serializeConfig(testSchema, "Google", {}, "full");
    expect(yaml).toMatch(/^\s+BasedOnStyle: Google$/m);
    expect(yaml).not.toContain("google");
  });

  it("never emits document markers or multiple trailing newlines", () => {
    const yaml = serializeConfig(realSchema, "Google", {}, "full");
    expect(yaml.split("\n")[0]).toBe("BasedOnStyle: Google");
    expect(yaml).not.toMatch(/^---$/m);
    expect(yaml).not.toMatch(/^\.\.\.$/m);
    expectSingleTrailingNewline(yaml);
  });
});

// ---------------------------------------------------------------------------
// Roundtrips against the real schema
// ---------------------------------------------------------------------------

const representativeModified: Modified = {
  IndentWidth: 4,
  ColumnLimit: 100,
  Standard: "c++11",
  BraceWrapping: { AfterClass: true, AfterControlStatement: "always" },
  ForEachMacros: ["MY_FOREACH", "Q_FOREACH"],
  IncludeCategories: [
    { Regex: "^<ext/.*\\.h>", Priority: 1, SortPriority: 0, CaseSensitive: false },
    { Regex: ".*", Priority: 5 },
  ],
  RawStringFormats: [
    { Language: "Cpp", Delimiters: ["cc", "CPP"], CanonicalDelimiter: "", BasedOnStyle: "google" },
  ],
};

describe("roundtrip with the real 21.1.8 schema", () => {
  it("minimal export -> import -> minimal export is byte-identical", () => {
    const first = serializeConfig(realSchema, "LLVM", representativeModified, "minimal");
    const parsed = parseConfigText(first, realSchema);

    expect(parsed.warnings).toEqual([]);
    expect(parsed.style).toBe("LLVM");
    expect(parsed.modified.IndentWidth).toBe(4);
    expect(parsed.modified.ColumnLimit).toBe(100);
    expect(parsed.modified.Standard).toBe("c++11");
    // Map patches stay sparse.
    expect(parsed.modified.BraceWrapping).toEqual({ AfterClass: true, AfterControlStatement: "Always" });
    // Struct list items keep only the fields that were written.
    expect(parsed.modified.IncludeCategories).toEqual(representativeModified.IncludeCategories);
    // The lowercase enum in the hand-written input was canonicalized.
    expect(parsed.modified.RawStringFormats).toEqual([
      { Language: "Cpp", Delimiters: ["cc", "CPP"], CanonicalDelimiter: "", BasedOnStyle: "Google" },
    ]);

    const second = serializeConfig(realSchema, parsed.style ?? "LLVM", parsed.modified, "minimal");
    expect(second).toBe(first);

    // A third trip (as after another import) must be stable too.
    const thirdParsed = parseConfigText(second, realSchema);
    expect(serializeConfig(realSchema, thirdParsed.style ?? "LLVM", thirdParsed.modified, "minimal")).toBe(first);
  });

  it("full export of Google style with an empty modified map is byte-identical", () => {
    // The Google style presets contain RawStringFormats with the lowercase
    // "google" BasedOnStyle enum, plus the four IncludeCategories defaults.
    const first = serializeConfig(realSchema, "Google", {}, "full");
    expect(first.split("\n")[0]).toBe("BasedOnStyle: Google");
    expect(first).toContain("IncludeCategories:");
    expect(first).toContain("RawStringFormats:");
    expect(first).toMatch(/^\s+BasedOnStyle: Google$/m);
    expect(first).not.toContain("BasedOnStyle: google");

    const parsed = parseConfigText(first, realSchema);
    expect(parsed.style).toBe("Google");
    // Known schema quirk: SpacesInLineCommentPrefix.Maximum is declared `uint`
    // but its preset is -1, so import drops that child and warns.
    expect(parsed.warnings.map((warning) => warning.path)).toEqual(["SpacesInLineCommentPrefix.Maximum"]);

    const second = serializeConfig(realSchema, parsed.style ?? "Google", parsed.modified, "full");
    expect(second).toBe(first);
  });

  it("full export roundtrips byte-identically for every style", () => {
    for (const style of realSchema.styles) {
      const first = serializeConfig(realSchema, style, {}, "full");
      const parsed = parseConfigText(first, realSchema);
      expect(parsed.style).toBe(style);
      expect(parsed.warnings.map((warning) => warning.path)).toEqual(["SpacesInLineCommentPrefix.Maximum"]);
      expect(serializeConfig(realSchema, parsed.style ?? style, parsed.modified, "full")).toBe(first);
    }
  });

  it("full export with modified options roundtrips byte-identically", () => {
    for (const style of ["LLVM", "Google", "GNU"] as const) {
      expectRoundtrip(realSchema, style, representativeModified, "full");
    }
  });

  it("minimal exports roundtrip for every style and are stable across a third pass", () => {
    for (const style of realSchema.styles) {
      const { first } = expectRoundtrip(realSchema, style, { IndentWidth: 8 }, "minimal");
      const parsed = parseConfigText(first, realSchema);
      expect(parsed.warnings).toEqual([]);
      const second = serializeConfig(realSchema, parsed.style ?? style, parsed.modified, "minimal");
      expect(second).toBe(first);
    }
  });
});

// ---------------------------------------------------------------------------
// Import: empty input
// ---------------------------------------------------------------------------

describe("parseConfigText — empty input", () => {
  const emptyInputs = ["", "   \n\t\n", "# only a comment\n", "---\n", "null\n", "~\n"];

  for (const text of emptyInputs) {
    it(`returns an empty result for ${JSON.stringify(text)}`, () => {
      expect(parseConfigText(text, testSchema)).toEqual({ style: null, modified: {}, warnings: [] });
    });
  }

  it("treats an empty document before a real one as absent, taking the first non-empty document", () => {
    const result = parseConfigText("---\n---\nBasedOnStyle: Google\nIndentWidth: 4\n", testSchema);
    expect(result.style).toBe("Google");
    expect(result.modified).toEqual({ IndentWidth: 4 });
  });
});

// ---------------------------------------------------------------------------
// Import: fatal errors
// ---------------------------------------------------------------------------

describe("parseConfigText — fatal errors", () => {
  it("throws ImportError when the top level is not a mapping", () => {
    const cases = ["hello\n", "- one\n- two\n", "42\n", "true\n"];
    for (const text of cases) {
      const error = importError(text);
      expect(error).toBeInstanceOf(ImportError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("ImportError");
      expect(error.message).toBe("configuration must be a YAML mapping");
      expect(error.detail).toBe("");
    }
  });

  it("throws ImportError for YAML syntax errors with a one-line message and full detail", () => {
    const error = importError("Config: [1,\n  b: 2\n");
    expect(error.message).not.toContain("\n");
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.detail).toContain("\n");
    expect(error.detail).toContain("line");
  });

  it("treats a syntax error in any document as fatal", () => {
    const error = importError("BasedOnStyle: LLVM\n---\nbroken: [1,\n  x: 2\n");
    expect(error.message).not.toContain("\n");
  });
});

// ---------------------------------------------------------------------------
// Import: multiple documents
// ---------------------------------------------------------------------------

describe("parseConfigText — multiple documents", () => {
  it("imports the first document and warns once", () => {
    const text = "BasedOnStyle: Google\nIndentWidth: 4\n---\nBasedOnStyle: LLVM\nIndentWidth: 8\n";
    const result = parseConfigText(text, testSchema);
    expect(result.style).toBe("Google");
    expect(result.modified).toEqual({ IndentWidth: 4 });
    expect(result.warnings).toEqual([
      { path: "", message: "multiple YAML documents; only the first is imported" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Import: BasedOnStyle
// ---------------------------------------------------------------------------

describe("parseConfigText — BasedOnStyle", () => {
  it("accepts a style name and canonicalizes the spelling", () => {
    for (const style of realSchema.styles) {
      const result = parseConfigText(`BasedOnStyle: ${style}\n`, realSchema);
      expect(result.style).toBe(style);
      expect(result.warnings).toEqual([]);

      const lower = parseConfigText(`BasedOnStyle: ${style.toLowerCase()}\n`, realSchema);
      expect(lower.style).toBe(style);
      expect(lower.warnings).toEqual([]);
    }
  });

  it("returns a null style when BasedOnStyle is missing", () => {
    const result = parseConfigText("IndentWidth: 8\n", testSchema);
    expect(result.style).toBeNull();
    expect(result.modified).toEqual({ IndentWidth: 8 });
    expect(result.warnings).toEqual([]);
  });

  it("warns and keeps the current style for InheritParentConfig", () => {
    const result = parseConfigText("BasedOnStyle: InheritParentConfig\n", testSchema);
    expect(result.style).toBeNull();
    const warning = firstWarning(result);
    expect(warning.path).toBe("BasedOnStyle");
    expect(warning.message).toContain("InheritParentConfig");
  });

  it("warns and keeps the current style for an unknown style", () => {
    const result = parseConfigText("BasedOnStyle: Klingon\n", testSchema);
    expect(result.style).toBeNull();
    const warning = firstWarning(result);
    expect(warning.path).toBe("BasedOnStyle");
    expect(warning.message).toContain("Klingon");
  });

  it("warns and keeps the current style when BasedOnStyle is not a string", () => {
    const result = parseConfigText("BasedOnStyle: 42\n", testSchema);
    expect(result.style).toBeNull();
    expect(firstWarning(result).message).toBe("expected a string, got a number");
  });

  it("supports a config with both BasedOnStyle and options", () => {
    const result = parseConfigText("BasedOnStyle: Google\nIndentWidth: 8\n", testSchema);
    expect(result.style).toBe("Google");
    expect(result.modified).toEqual({ IndentWidth: 8 });
  });
});

// ---------------------------------------------------------------------------
// Import: Language and unknown keys
// ---------------------------------------------------------------------------

describe("parseConfigText — Language and unknown keys", () => {
  it("ignores Language with a warning", () => {
    const result = parseConfigText("Language: Cpp\nIndentWidth: 8\n", testSchema);
    expect(result.modified).toEqual({ IndentWidth: 8 });
    expect(result.warnings).toEqual([
      { path: "Language", message: "Language is derived from the filename; ignored" },
    ]);
  });

  it("warns for unknown top-level options and drops them", () => {
    const result = parseConfigText("NotARealOption: 1\nIndentWidth: 8\n", testSchema);
    expect(result.modified).toEqual({ IndentWidth: 8 });
    expect(result.warnings).toEqual([
      { path: "NotARealOption", message: 'unknown option "NotARealOption" for clang-format test-1' },
    ]);
  });

  it("collects several warnings at once", () => {
    const result = parseConfigText("Nope: 1\nLanguage: Cpp\nAlsoNope: 2\n", testSchema);
    expect(result.warnings.map((warning) => warning.path)).toEqual(["Nope", "Language", "AlsoNope"]);
  });
});

// ---------------------------------------------------------------------------
// Import: scalars
// ---------------------------------------------------------------------------

describe("parseConfigText — scalar validation", () => {
  it("accepts bool, int, uint and string scalars", () => {
    const result = parseConfigText(
      ["DeriveLineEnding: true", "AccessModifierOffset: -8", "IndentWidth: 0", 'CommentPragmas: "pragma"'].join(
        "\n",
      ),
      testSchema,
    );
    expect(result.warnings).toEqual([]);
    expect(result.modified).toEqual({
      DeriveLineEnding: true,
      AccessModifierOffset: -8,
      IndentWidth: 0,
      CommentPragmas: "pragma",
    });
  });

  it("rejects non-boolean bools", () => {
    const result = parseConfigText("DeriveLineEnding: yes\n", testSchema);
    expect(result.modified).toEqual({});
    expect(firstWarning(result).message).toBe("expected a boolean, got a string");
  });

  it("rejects non-integer ints", () => {
    const result = parseConfigText("AccessModifierOffset: 1.5\n", testSchema);
    expect(result.modified).toEqual({});
    expect(firstWarning(result)).toEqual({
      path: "AccessModifierOffset",
      message: "expected an integer, got a number",
    });
  });

  it("rejects negative uints", () => {
    const result = parseConfigText("IndentWidth: -1\n", testSchema);
    expect(result.modified).toEqual({});
    expect(firstWarning(result)).toEqual({
      path: "IndentWidth",
      message: "expected a non-negative integer, got a number",
    });
  });

  it("rejects fractional uints", () => {
    const result = parseConfigText("IndentWidth: 2.5\n", testSchema);
    expect(result.modified).toEqual({});
    expect(firstWarning(result).path).toBe("IndentWidth");
  });

  it("rejects null and non-string strings", () => {
    const nullResult = parseConfigText("IndentWidth:\n", testSchema);
    expect(firstWarning(nullResult).message).toBe("expected a non-negative integer, got null");

    const result = parseConfigText("CommentPragmas: 42\n", testSchema);
    expect(firstWarning(result).message).toBe("expected a string, got a number");
  });
});

// ---------------------------------------------------------------------------
// Import: enums
// ---------------------------------------------------------------------------

describe("parseConfigText — enum validation", () => {
  it("canonicalizes values case-insensitively", () => {
    expect(parseConfigText("Standard: latest\n", testSchema).modified).toEqual({ Standard: "Latest" });
    expect(parseConfigText("Standard: C++11\n", testSchema).modified).toEqual({ Standard: "c++11" });
  });

  it("warns and drops unknown values", () => {
    const result = parseConfigText("Standard: C++99\n", testSchema);
    expect(result.modified).toEqual({});
    const warning = firstWarning(result);
    expect(warning.path).toBe("Standard");
    expect(warning.message).toContain("C++99");
  });

  it("warns and drops non-string values", () => {
    const result = parseConfigText("Standard: 11\n", testSchema);
    expect(result.modified).toEqual({});
    expect(firstWarning(result)).toEqual({ path: "Standard", message: "expected a string, got a number" });
  });

  it("canonicalizes enum children of maps and struct-list items", () => {
    const result = parseConfigText(
      [
        "BraceWrapping:",
        "  AfterControlStatement: multiLine",
        "RawStringFormats:",
        "  - Language: cpp",
        "    BasedOnStyle: google",
      ].join("\n"),
      testSchema,
    );
    expect(result.warnings).toEqual([]);
    expect(result.modified).toEqual({
      BraceWrapping: { AfterControlStatement: "MultiLine" },
      RawStringFormats: [{ Language: "Cpp", BasedOnStyle: "Google" }],
    });
  });
});

// ---------------------------------------------------------------------------
// Import: maps
// ---------------------------------------------------------------------------

describe("parseConfigText — map validation", () => {
  it("keeps map values sparse (no preset materialization)", () => {
    const result = parseConfigText("BraceWrapping:\n  AfterClass: true\n", testSchema);
    expect(result.warnings).toEqual([]);
    expect(result.modified).toEqual({ BraceWrapping: { AfterClass: true } });
  });

  it("keeps an empty mapping", () => {
    const result = parseConfigText("BraceWrapping: {}\n", testSchema);
    expect(result.warnings).toEqual([]);
    expect(result.modified).toEqual({ BraceWrapping: {} });
  });

  it("warns for unknown children and keeps the valid ones", () => {
    const result = parseConfigText("BraceWrapping:\n  AfterClass: true\n  Nope: 1\n", testSchema);
    expect(result.modified).toEqual({ BraceWrapping: { AfterClass: true } });
    expect(result.warnings).toEqual([
      { path: "BraceWrapping.Nope", message: 'unknown option "Nope" for BraceWrapping' },
    ]);
  });

  it("warns for invalid child values and drops only that child", () => {
    const result = parseConfigText(
      "BraceWrapping:\n  AfterClass: true\n  AfterControlStatement: Sometimes\n",
      testSchema,
    );
    expect(result.modified).toEqual({ BraceWrapping: { AfterClass: true } });
    const warning = firstWarning(result);
    expect(warning.path).toBe("BraceWrapping.AfterControlStatement");
    expect(warning.message).toContain("Sometimes");
  });

  it("warns and drops maps that are neither mappings nor legacy shorthands", () => {
    for (const text of ["BraceWrapping: [true]\n", "BraceWrapping:\n"] as const) {
      const result = parseConfigText(text, testSchema);
      expect(result.modified).toEqual({});
      expect(firstWarning(result).path).toBe("BraceWrapping");
    }
  });
});

// ---------------------------------------------------------------------------
// Import: legacy conversions
// ---------------------------------------------------------------------------

describe("parseConfigText — legacy conversions", () => {
  it("converts a legacy boolean for maps with an Enabled child", () => {
    const enabled = parseConfigText("AlignConsecutiveMacros: true\n", testSchema);
    expect(enabled.modified).toEqual({ AlignConsecutiveMacros: { Enabled: true } });
    expect(firstWarning(enabled)).toEqual({
      path: "AlignConsecutiveMacros",
      message: "legacy boolean converted to nested map",
    });

    const disabled = parseConfigText("AlignConsecutiveMacros: false\n", testSchema);
    expect(disabled.modified).toEqual({ AlignConsecutiveMacros: { Enabled: false } });
  });

  it("converts every legacy AlignConsecutive string form", () => {
    const cases: Array<[string, Record<string, boolean>]> = [
      ["None", { Enabled: false }],
      ["Consecutive", { Enabled: true }],
      ["AcrossEmptyLines", { Enabled: true, AcrossEmptyLines: true }],
      ["AcrossComments", { Enabled: true, AcrossComments: true }],
      [
        "AcrossEmptyLinesAndComments",
        { Enabled: true, AcrossEmptyLines: true, AcrossComments: true },
      ],
    ];
    for (const [legacy, expected] of cases) {
      const result = parseConfigText(`AlignConsecutiveMacros: ${legacy}\n`, testSchema);
      expect(result.modified).toEqual({ AlignConsecutiveMacros: expected });
      expect(firstWarning(result)).toEqual({
        path: "AlignConsecutiveMacros",
        message: "legacy AlignConsecutive enum converted to nested map",
      });
    }
  });

  it("matches legacy AlignConsecutive strings case-insensitively", () => {
    const result = parseConfigText("AlignConsecutiveMacros: acrossemptylinesandcomments\n", testSchema);
    expect(result.modified).toEqual({
      AlignConsecutiveMacros: { Enabled: true, AcrossEmptyLines: true, AcrossComments: true },
    });
  });

  it("warns and drops AlignConsecutive strings outside the legacy enum", () => {
    const result = parseConfigText("AlignConsecutiveMacros: Sometimes\n", testSchema);
    expect(result.modified).toEqual({});
    expect(firstWarning(result).path).toBe("AlignConsecutiveMacros");
  });

  it("converts a legacy boolean AlignTrailingComments to Kind", () => {
    const always = parseConfigText("AlignTrailingComments: true\n", testSchema);
    expect(always.modified).toEqual({ AlignTrailingComments: { Kind: "Always" } });
    expect(firstWarning(always)).toEqual({
      path: "AlignTrailingComments",
      message: "legacy boolean converted to nested map",
    });

    const never = parseConfigText("AlignTrailingComments: false\n", testSchema);
    expect(never.modified).toEqual({ AlignTrailingComments: { Kind: "Never" } });
  });

  it("does not mix up legacy booleans with plain map validation", () => {
    // AlignTrailingComments has no Enabled child, so the generic bool rule must
    // not swallow it; and its mapping form still validates normally.
    const result = parseConfigText("AlignTrailingComments:\n  Kind: never\n  OverEmptyLines: 2\n", testSchema);
    expect(result.warnings).toEqual([]);
    expect(result.modified).toEqual({ AlignTrailingComments: { Kind: "Never", OverEmptyLines: 2 } });
  });
});

// ---------------------------------------------------------------------------
// Import: list<string>
// ---------------------------------------------------------------------------

describe("parseConfigText — list<string> validation", () => {
  it("accepts lists of strings, including empty lists", () => {
    expect(parseConfigText("ForEachMacros:\n  - A\n  - B\n", testSchema).modified).toEqual({
      ForEachMacros: ["A", "B"],
    });
    expect(parseConfigText("ForEachMacros: []\n", testSchema).modified).toEqual({ ForEachMacros: [] });
  });

  it("warns and drops a value that is not a list", () => {
    const result = parseConfigText("ForEachMacros: yes\n", testSchema);
    expect(result.modified).toEqual({});
    expect(firstWarning(result)).toEqual({
      path: "ForEachMacros",
      message: "expected a list of strings, got a string",
    });
  });

  it("warns and drops the whole list when an item is not a string", () => {
    const result = parseConfigText("ForEachMacros: [one, 2]\n", testSchema);
    expect(result.modified).toEqual({});
    expect(firstWarning(result)).toEqual({ path: "ForEachMacros", message: "expected a list of strings" });
  });
});

// ---------------------------------------------------------------------------
// Import: list<struct>
// ---------------------------------------------------------------------------

describe("parseConfigText — list<struct> validation", () => {
  it("accepts struct lists and keeps their fields", () => {
    const result = parseConfigText(
      [
        "IncludeCategories:",
        "  - Regex: .*",
        "    Priority: 5",
        "    SortPriority: 1",
        "    CaseSensitive: true",
      ].join("\n"),
      testSchema,
    );
    expect(result.warnings).toEqual([]);
    expect(result.modified).toEqual({
      IncludeCategories: [{ Regex: ".*", Priority: 5, SortPriority: 1, CaseSensitive: true }],
    });
  });

  it("keeps sparse struct items sparse", () => {
    const result = parseConfigText("IncludeCategories:\n  - Regex: .*\n", testSchema);
    expect(result.modified).toEqual({ IncludeCategories: [{ Regex: ".*" }] });
  });

  it("allows empty struct items", () => {
    const result = parseConfigText("IncludeCategories: [{}]\n", testSchema);
    expect(result.warnings).toEqual([]);
    expect(result.modified).toEqual({ IncludeCategories: [{}] });
  });

  it("warns for unknown struct fields and drops them", () => {
    const result = parseConfigText("IncludeCategories:\n  - Regex: x\n    Nope: 1\n", testSchema);
    expect(result.modified).toEqual({ IncludeCategories: [{ Regex: "x" }] });
    expect(result.warnings).toEqual([
      { path: "IncludeCategories[0].Nope", message: 'unknown field "Nope" for IncludeCategories' },
    ]);
  });

  it("warns for invalid fields and keeps the rest of the item", () => {
    const result = parseConfigText("IncludeCategories:\n  - Regex: x\n    Priority: high\n", testSchema);
    expect(result.modified).toEqual({ IncludeCategories: [{ Regex: "x" }] });
    const warning = firstWarning(result);
    expect(warning.path).toBe("IncludeCategories[0].Priority");
    expect(warning.message).toContain("integer");
  });

  it("warns and drops items that are not mappings", () => {
    const result = parseConfigText("IncludeCategories:\n  - 42\n  - Regex: x\n", testSchema);
    expect(result.modified).toEqual({ IncludeCategories: [{ Regex: "x" }] });
    expect(firstWarning(result)).toEqual({
      path: "IncludeCategories[0]",
      message: "expected a mapping, got a number; item ignored",
    });
  });

  it("warns and drops a struct list that is not an array", () => {
    const result = parseConfigText("IncludeCategories: {}\n", testSchema);
    expect(result.modified).toEqual({});
    expect(firstWarning(result)).toEqual({
      path: "IncludeCategories",
      message: "expected a list of mappings, got a mapping",
    });
  });

  it("validates nested list fields of struct items", () => {
    const valid = parseConfigText(
      "RawStringFormats:\n  - Language: Cpp\n    Delimiters: [cc, CPP]\n    EnclosingFunctions: [Parse]\n",
      testSchema,
    );
    expect(valid.warnings).toEqual([]);
    expect(valid.modified).toEqual({
      RawStringFormats: [{ Language: "Cpp", Delimiters: ["cc", "CPP"], EnclosingFunctions: ["Parse"] }],
    });

    const invalid = parseConfigText("RawStringFormats:\n  - Language: Cpp\n    Delimiters: cc\n", testSchema);
    expect(invalid.modified).toEqual({ RawStringFormats: [{ Language: "Cpp" }] });
    expect(firstWarning(invalid)).toEqual({
      path: "RawStringFormats[0].Delimiters",
      message: "expected a list of strings, got a string",
    });
  });

  it("warns for unknown fields in RawStringFormats items", () => {
    const result = parseConfigText(
      "RawStringFormats:\n  - Language: Cpp\n    Bogus: 1\n  - Language: TextProto\n",
      testSchema,
    );
    expect(result.modified).toEqual({
      RawStringFormats: [{ Language: "Cpp" }, { Language: "TextProto" }],
    });
    expect(firstWarning(result)).toEqual({
      path: "RawStringFormats[0].Bogus",
      message: 'unknown field "Bogus" for RawStringFormats',
    });
  });
});

// ---------------------------------------------------------------------------
// Import: realistic config (matches the e2e import scenario)
// ---------------------------------------------------------------------------

describe("parseConfigText — realistic config on the real schema", () => {
  it("imports a mixed config, converts legacy forms and reports warnings in order", () => {
    const text = [
      "BasedOnStyle: GNU",
      "IndentWidth: 8",
      "NotARealOption: 1",
      "AlignConsecutiveMacros: true",
      "",
    ].join("\n");
    const result = parseConfigText(text, realSchema);

    expect(result.style).toBe("GNU");
    expect(result.modified).toEqual({
      IndentWidth: 8,
      AlignConsecutiveMacros: { Enabled: true },
    });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toEqual({
      path: "NotARealOption",
      message: 'unknown option "NotARealOption" for clang-format 21.1.8',
    });
    expect(result.warnings[1]).toEqual({
      path: "AlignConsecutiveMacros",
      message: "legacy boolean converted to nested map",
    });
  });

  it("keeps a valid imported config free of warnings", () => {
    const result = parseConfigText(
      ["BasedOnStyle: Google", "IndentWidth: 2", "ColumnLimit: 80", "Standard: c++17"].join("\n"),
      realSchema,
    );
    expect(result.warnings).toEqual([]);
    expect(result.style).toBe("Google");
    expect(result.modified).toEqual({ IndentWidth: 2, ColumnLimit: 80, Standard: "c++17" });
  });
});
