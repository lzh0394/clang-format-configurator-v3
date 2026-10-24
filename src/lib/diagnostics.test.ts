import { describe, expect, it } from "vitest";
import { describeError, mergeDiagnostics, splitErrorText } from "./diagnostics";

describe("splitErrorText", () => {
  it("uses the first line as the summary and keeps the remaining lines as detail", () => {
    const parts = splitErrorText(
      "Error parsing -style: Invalid argument\n/path/main.cc:1:2: error: invalid value for IndentWidth",
    );

    expect(parts.summary).toBe("Error parsing -style: Invalid argument");
    expect(parts.detail).toBe("/path/main.cc:1:2: error: invalid value for IndentWidth");
  });

  it("skips leading blank lines and trims both parts", () => {
    const parts = splitErrorText("\n\n  boom  \n  line 2  \n");

    expect(parts.summary).toBe("boom");
    expect(parts.detail).toBe("line 2");
  });

  it("falls back to the supplied summary for blank input", () => {
    expect(splitErrorText("   \n\n")).toEqual({ summary: "format failed", detail: "" });
    expect(splitErrorText("", "clang-format failed to load").summary).toBe("clang-format failed to load");
  });

  it("normalizes CRLF line endings", () => {
    const parts = splitErrorText("first\r\nsecond\r\nthird");

    expect(parts.summary).toBe("first");
    expect(parts.detail).toBe("second\nthird");
  });
});

describe("describeError", () => {
  it("extracts a multi-line Error message", () => {
    const parts = describeError(new Error("first line\nsecond line"));

    expect(parts.summary).toBe("first line");
    expect(parts.detail).toBe("second line");
  });

  it("accepts a plain string and stringifies other thrown values", () => {
    expect(describeError("plain failure").summary).toBe("plain failure");
    expect(describeError(42).summary).toBe("42");
  });

  it("uses the fallback when an Error has an empty message", () => {
    expect(describeError(new Error(""), "format failed")).toEqual({
      summary: "format failed",
      detail: "",
    });
  });
});

describe("mergeDiagnostics", () => {
  const base = splitErrorText(
    "Error parsing -style: Invalid argument\n/path/main.cc:1:2: error: invalid value for IndentWidth",
  );

  it("appends cleaned captured lines after the exception detail", () => {
    const merged = mergeDiagnostics(base, ["/path/main.cc:1:2: error: invalid value for IndentWidth"]);

    expect(merged.detail).toBe("/path/main.cc:1:2: error: invalid value for IndentWidth");
  });

  it("strips blank lines and trims captured output", () => {
    const merged = mergeDiagnostics({ summary: "boom", detail: "" }, ["", "   ", "  line 1  ", "\t"]);

    expect(merged.detail).toBe("line 1");
  });

  it("does not duplicate the summary line", () => {
    const merged = mergeDiagnostics(base, [
      "Error parsing -style: Invalid argument",
      "note: add a diagnostic",
    ]);

    expect(merged.detail.split("\n").filter((line) => line.includes("Error parsing -style"))).toHaveLength(0);
    expect(merged.detail.endsWith("note: add a diagnostic")).toBe(true);
  });

  it("does not duplicate lines already present in the detail", () => {
    const merged = mergeDiagnostics(base, ["/path/main.cc:1:2: error: invalid value for IndentWidth"]);

    expect(merged.detail).toBe(base.detail);
  });

  it("collapses repeated captured lines and splits multi-line entries", () => {
    const merged = mergeDiagnostics({ summary: "boom", detail: "" }, ["dup", "dup", "a\nb", "b"]);

    expect(merged.detail).toBe("dup\na\nb");
  });

  it("returns only captured lines when the exception had no detail", () => {
    const merged = mergeDiagnostics({ summary: "boom", detail: "" }, ["one", "two"]);

    expect(merged.detail).toBe("one\ntwo");
    expect(merged.summary).toBe("boom");
  });

  it("normalizes a padded summary and leaves it otherwise untouched", () => {
    const merged = mergeDiagnostics({ summary: "  boom  ", detail: "" }, ["line"]);

    expect(merged.summary).toBe("boom");
    expect(merged.detail).toBe("line");
  });

  it("returns the base detail unchanged when there is nothing captured", () => {
    expect(mergeDiagnostics(base, [])).toEqual(base);
  });
});
