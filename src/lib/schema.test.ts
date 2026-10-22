import { describe, expect, it } from "vitest";
import { buildStylePayload, displayValue, type OptionDef } from "./schema";

const indentWidth: OptionDef = {
  key: "IndentWidth",
  type: { kind: "scalar", scalar: "uint" },
  deprecated: false,
  defaults: { LLVM: 2, Google: 2, Chromium: 2, Mozilla: 2, WebKit: 4, Microsoft: 4, GNU: 2 },
};

describe("buildStylePayload", () => {
  it("sends the preset plus only the modified options", () => {
    expect(buildStylePayload("Google")).toBe('{"BasedOnStyle":"Google"}');
    expect(buildStylePayload("Google", { IndentWidth: 4 })).toBe(
      '{"BasedOnStyle":"Google","IndentWidth":4}',
    );
  });

  it("lets modified keys override BasedOnStyle", () => {
    expect(buildStylePayload("LLVM", { BasedOnStyle: "GNU" })).toBe('{"BasedOnStyle":"GNU"}');
  });
});

describe("displayValue", () => {
  it("prefers an explicit change over the preset default", () => {
    expect(displayValue(indentWidth, "LLVM", {})).toBe(2);
    expect(displayValue(indentWidth, "WebKit", {})).toBe(4);
    expect(displayValue(indentWidth, "WebKit", { IndentWidth: 8 })).toBe(8);
  });

  it("returns undefined when neither source defines a value", () => {
    const deprecated: OptionDef = { ...indentWidth, defaults: {} };
    expect(displayValue(deprecated, "LLVM", {})).toBeUndefined();
  });
});
