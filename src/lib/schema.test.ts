import { describe, expect, it } from "vitest";
import { buildStylePayload, compareVersionsDesc, displayValue, versionLabel, type OptionDef } from "./schema";

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

describe("compareVersionsDesc", () => {
  it("sorts newest first, comparing numbers instead of strings", () => {
    const versions = ["16.0.6", "23.1.1", "9.0.0", "21.1.8", "22.1.10", "22.1.9"];
    expect([...versions].sort(compareVersionsDesc)).toEqual([
      "23.1.1",
      "22.1.10",
      "22.1.9",
      "21.1.8",
      "16.0.6",
      "9.0.0",
    ]);
  });

  it("treats missing segments as zero and equal versions as a tie", () => {
    expect(compareVersionsDesc("21", "21.0.0")).toBe(0);
    expect(compareVersionsDesc("21.1", "21.1.0")).toBe(0);
    expect(compareVersionsDesc("21.1.0", "21.1.1")).toBeGreaterThan(0);
  });
});

describe("versionLabel", () => {
  it("marks only the newest shipped version", () => {
    expect(versionLabel("23.1.1", "23.1.1")).toBe("23.1.1 (latest)");
    expect(versionLabel("21.1.8", "23.1.1")).toBe("21.1.8");
    expect(versionLabel("21.1.8", null)).toBe("21.1.8");
  });
});
