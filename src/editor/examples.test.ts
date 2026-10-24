import { describe, expect, it } from "vitest";

import {
  CPP_SAMPLE,
  CSHARP_SAMPLE,
  DEFAULT_SAMPLE,
  DEFAULT_SAMPLE_FILENAME,
  JAVASCRIPT_SAMPLE,
  JAVA_SAMPLE,
  KOTLIN_SAMPLE,
  PROTO_SAMPLE,
  TYPESCRIPT_SAMPLE,
  getSampleCode,
  getSampleForLanguage,
  isKnownSample,
} from "./examples";

const ALL_SAMPLES = {
  cpp: CPP_SAMPLE,
  csharp: CSHARP_SAMPLE,
  proto: PROTO_SAMPLE,
  java: JAVA_SAMPLE,
  kotlin: KOTLIN_SAMPLE,
  javascript: JAVASCRIPT_SAMPLE,
  typescript: TYPESCRIPT_SAMPLE,
} as const;

const SAMPLE_FILENAMES = {
  cpp: ["main.cc", "main.cpp", "header.hpp"],
  csharp: ["Program.cs"],
  proto: ["service.proto", "nested/widget.proto"],
  java: ["Main.java"],
  kotlin: ["Main.kt", "build.gradle.kts"],
  javascript: ["app.js", "component.jsx"],
  typescript: ["main.ts", "component.tsx"],
} as const;

describe("samples", () => {
  it("has a non-empty sample for every supported language", () => {
    for (const [language, sample] of Object.entries(ALL_SAMPLES)) {
      expect(sample.trim().length, language).toBeGreaterThan(20);
      expect(sample.endsWith("\n"), language).toBe(true);
      expect(sample, language).not.toContain("\r");
    }
  });

  it("keeps the default C++ sample and filename in sync with the app default", () => {
    expect(DEFAULT_SAMPLE).toBe(CPP_SAMPLE);
    expect(DEFAULT_SAMPLE_FILENAME).toBe("main.cc");
    expect(CPP_SAMPLE).toContain("class Widget{public:");
    expect(CPP_SAMPLE).toContain("int main(){");
  });

  it("ships distinct C# and Protobuf examples", () => {
    expect(CSHARP_SAMPLE).toContain("namespace Demo{");
    expect(CSHARP_SAMPLE).toContain("public static void Main()");
    expect(PROTO_SAMPLE).toContain('syntax = "proto3";');
    expect(PROTO_SAMPLE).toContain("service WidgetService{");
    // They must not be copies of the C++ default (that is the whole point).
    for (const [language, sample] of Object.entries(ALL_SAMPLES)) {
      if (language === "cpp") continue;
      expect(sample, language).not.toBe(CPP_SAMPLE);
    }
  });

  it("exposes every sample through isKnownSample", () => {
    for (const sample of Object.values(ALL_SAMPLES)) {
      expect(isKnownSample(sample)).toBe(true);
    }
    expect(isKnownSample(DEFAULT_SAMPLE)).toBe(true);
    expect(isKnownSample("")).toBe(false);
    expect(isKnownSample("int main(){return 0;}")).toBe(false);
    // Trailing whitespace is a different document.
    expect(isKnownSample(`${CPP_SAMPLE} `)).toBe(false);
  });
});

describe("getSampleCode", () => {
  it("maps filenames to the matching sample", () => {
    for (const [language, filenames] of Object.entries(SAMPLE_FILENAMES)) {
      const expected = ALL_SAMPLES[language as keyof typeof ALL_SAMPLES];
      for (const filename of filenames) {
        expect(getSampleCode(filename), filename).toBe(expected);
      }
    }
  });

  it("is case-insensitive and understands Win32 paths", () => {
    expect(getSampleCode("PROGRAM.CS")).toBe(CSHARP_SAMPLE);
    expect(getSampleCode("C:\\src\\service.proto")).toBe(PROTO_SAMPLE);
    expect(getSampleCode("src/main.cc")).toBe(CPP_SAMPLE);
  });

  it("returns null for filenames without a sample", () => {
    expect(getSampleCode("README")).toBeNull();
    expect(getSampleCode("Makefile")).toBeNull();
    expect(getSampleCode("")).toBeNull();
    expect(getSampleCode(".clang-format")).toBeNull();
    expect(getSampleCode("config.yml")).toBeNull();
    expect(getSampleCode("view.m")).toBeNull();
    expect(getSampleCode("view.mm")).toBeNull();
  });
});

describe("getSampleForLanguage", () => {
  it("returns the sample for languages that have one", () => {
    expect(getSampleForLanguage("cpp")).toBe(CPP_SAMPLE);
    expect(getSampleForLanguage("proto")).toBe(PROTO_SAMPLE);
    expect(getSampleForLanguage("csharp")).toBe(CSHARP_SAMPLE);
  });

  it("returns null for languages that keep the current document", () => {
    for (const language of ["objectivec", "objectivecpp", "yaml", "plain", "unknown"]) {
      expect(getSampleForLanguage(language), language).toBeNull();
    }
  });
});
