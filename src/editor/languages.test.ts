import { describe, expect, it } from "vitest";

import { LANGUAGE_LABELS, languageForFilename, loadLanguageSupport, type EditorLanguage } from "./languages";

describe("languageForFilename", () => {
  it("maps C/C++ extensions", () => {
    for (const name of [
      "main.cc",
      "main.cpp",
      "main.c",
      "main.cxx",
      "main.cp",
      "main.c++",
      "header.h",
      "header.hpp",
      "header.hh",
      "header.hxx",
      "header.h++",
      "impl.ipp",
      "impl.inl",
    ]) {
      expect(languageForFilename(name), name).toBe("cpp");
    }
  });

  it("maps Java, C# and Kotlin extensions", () => {
    expect(languageForFilename("Main.java")).toBe("java");
    expect(languageForFilename("Program.cs")).toBe("csharp");
    expect(languageForFilename("Main.kt")).toBe("kotlin");
    expect(languageForFilename("build.gradle.kts")).toBe("kotlin");
  });

  it("maps Objective-C and Objective-C++ extensions", () => {
    expect(languageForFilename("view.m")).toBe("objectivec");
    expect(languageForFilename("view.mm")).toBe("objectivecpp");
  });

  it("maps JavaScript and TypeScript extensions", () => {
    for (const name of ["app.js", "component.jsx", "module.mjs", "legacy.cjs"]) {
      expect(languageForFilename(name), name).toBe("javascript");
    }
    for (const name of ["main.ts", "component.tsx", "module.mts", "module.cts"]) {
      expect(languageForFilename(name), name).toBe("typescript");
    }
  });

  it("maps Proto extensions", () => {
    expect(languageForFilename("service.proto")).toBe("proto");
    expect(languageForFilename("nested/service.proto")).toBe("proto");
  });

  it("treats .clang-format and YAML files as yaml", () => {
    expect(languageForFilename(".clang-format")).toBe("yaml");
    expect(languageForFilename("nested/.clang-format")).toBe("yaml");
    expect(languageForFilename("C:\\repo\\.clang-format")).toBe("yaml");
    expect(languageForFilename("config.yaml")).toBe("yaml");
    expect(languageForFilename("config.yml")).toBe("yaml");
  });

  it("uses the basename so directories do not confuse the extension", () => {
    expect(languageForFilename("src/cpp/main.cc")).toBe("cpp");
    expect(languageForFilename("C:\\src\\cs\\Program.cs")).toBe("csharp");
    expect(languageForFilename("  main.kt  ")).toBe("kotlin");
  });

  it("is case-insensitive", () => {
    expect(languageForFilename("MAIN.CC")).toBe("cpp");
    expect(languageForFilename("Main.Java")).toBe("java");
    expect(languageForFilename("Program.CS")).toBe("csharp");
    expect(languageForFilename("APP.TSX")).toBe("typescript");
    expect(languageForFilename(".CLANG-FORMAT")).toBe("yaml");
  });

  it("falls back to plain text for unknown or missing extensions", () => {
    expect(languageForFilename("main.unknown")).toBe("plain");
    expect(languageForFilename("Makefile")).toBe("plain");
    expect(languageForFilename("main.")).toBe("plain");
    expect(languageForFilename("")).toBe("plain");
    expect(languageForFilename("archive.tar.gz")).toBe("plain");
  });

  it("has a display label for every language", () => {
    const languages: EditorLanguage[] = [
      "cpp",
      "java",
      "csharp",
      "kotlin",
      "objectivec",
      "objectivecpp",
      "javascript",
      "typescript",
      "proto",
      "yaml",
      "plain",
    ];
    for (const language of languages) {
      expect(LANGUAGE_LABELS[language], language).toBeTruthy();
      expect(LANGUAGE_LABELS[language].length, language).toBeGreaterThan(0);
    }
  });
});

describe("loadLanguageSupport", () => {
  it("resolves plain text to an empty extension list", async () => {
    await expect(loadLanguageSupport("plain")).resolves.toEqual([]);
  });

  it("resolves lazily-loaded C-family language extensions", async () => {
    await expect(loadLanguageSupport("cpp")).resolves.toBeTruthy();
    await expect(loadLanguageSupport("csharp")).resolves.toBeTruthy();
    await expect(loadLanguageSupport("kotlin")).resolves.toBeTruthy();
    await expect(loadLanguageSupport("objectivec")).resolves.toBeTruthy();
    await expect(loadLanguageSupport("objectivecpp")).resolves.toBeTruthy();
  });

  it("resolves lazily-loaded JavaScript/TypeScript extensions", async () => {
    await expect(loadLanguageSupport("javascript")).resolves.toBeTruthy();
    await expect(loadLanguageSupport("typescript")).resolves.toBeTruthy();
  });

  it("resolves Protobuf and YAML extensions", async () => {
    await expect(loadLanguageSupport("proto")).resolves.toBeTruthy();
    await expect(loadLanguageSupport("yaml")).resolves.toBeTruthy();
  });

  it("caches the extension per language", async () => {
    const first = await loadLanguageSupport("cpp");
    const second = await loadLanguageSupport("cpp");
    expect(second).toBe(first);
  });
});
