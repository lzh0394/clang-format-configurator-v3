import { describe, expect, it } from "vitest";

import { LANGUAGE_LABELS, languageForFilename, loadLanguageSupport, type EditorLanguage } from "./languages";

describe("languageForFilename", () => {
  it("maps C/C++ extensions", () => {
    for (const name of ["main.cc", "main.cpp", "main.c", "main.cxx", "header.h", "header.hpp"]) {
      expect(languageForFilename(name)).toBe("cpp");
    }
  });

  it("maps Java, C# and Proto extensions", () => {
    expect(languageForFilename("Main.java")).toBe("java");
    expect(languageForFilename("Program.cs")).toBe("csharp");
    expect(languageForFilename("service.proto")).toBe("proto");
  });

  it("treats .clang-format and YAML files as yaml", () => {
    expect(languageForFilename(".clang-format")).toBe("yaml");
    expect(languageForFilename("nested/.clang-format")).toBe("yaml");
    expect(languageForFilename("config.yml")).toBe("yaml");
  });

  it("is case-insensitive", () => {
    expect(languageForFilename("MAIN.CC")).toBe("cpp");
    expect(languageForFilename("Main.Java")).toBe("java");
  });

  it("falls back to plain text for unknown or missing extensions", () => {
    expect(languageForFilename("main.unknown")).toBe("plain");
    expect(languageForFilename("Makefile")).toBe("plain");
    expect(languageForFilename("main.")).toBe("plain");
    expect(languageForFilename("")).toBe("plain");
  });

  it("has a display label for every language", () => {
    const languages: EditorLanguage[] = ["cpp", "java", "csharp", "proto", "yaml", "plain"];
    for (const language of languages) {
      expect(LANGUAGE_LABELS[language].length).toBeGreaterThan(0);
    }
  });
});

describe("loadLanguageSupport", () => {
  it("resolves plain text to an empty extension list", async () => {
    await expect(loadLanguageSupport("plain")).resolves.toEqual([]);
  });

  it("resolves lazily-loaded language extensions", async () => {
    await expect(loadLanguageSupport("cpp")).resolves.toBeTruthy();
    await expect(loadLanguageSupport("csharp")).resolves.toBeTruthy();
  });
});
