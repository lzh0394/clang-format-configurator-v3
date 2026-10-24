// Language support for the CodeMirror editors (plan §5).
//
// The filename decides the language (v3 removed the `Language` option, §6):
// C/C++ and Java use the official language packages, C# and Proto use the
// legacy stream modes, YAML backs the configuration drawer. Everything is
// loaded lazily and cached, so uncommon languages never sit in the entry
// chunk (the first-load budget in plan §1 is 250 KB gzip).

import { StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

export type EditorLanguage = "cpp" | "java" | "csharp" | "proto" | "yaml" | "plain";

const BY_EXTENSION: Readonly<Record<string, EditorLanguage>> = {
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  inl: "cpp",
  java: "java",
  cs: "csharp",
  proto: "proto",
  yaml: "yaml",
  yml: "yaml",
};

export const LANGUAGE_LABELS: Readonly<Record<EditorLanguage, string>> = {
  cpp: "C/C++",
  java: "Java",
  csharp: "C#",
  proto: "Protobuf",
  yaml: "YAML",
  plain: "Plain text",
};

/** Map a filename (`main.cc`, `.clang-format`) to an editor language. */
export function languageForFilename(filename: string): EditorLanguage {
  const base = filename.trim().toLowerCase();
  if (base === ".clang-format" || base.endsWith("/.clang-format")) return "yaml";

  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return "plain";
  return BY_EXTENSION[base.slice(dot + 1)] ?? "plain";
}

const cache = new Map<EditorLanguage, Promise<Extension>>();

/**
 * Resolve the CodeMirror extension for a language. The promise is cached so
 * switching a filename back and forth does not re-download the language.
 */
export function loadLanguageSupport(language: EditorLanguage): Promise<Extension> {
  if (language === "plain") return Promise.resolve([]);

  const cached = cache.get(language);
  if (cached !== undefined) return cached;

  const pending = createLanguageSupport(language);
  cache.set(language, pending);
  return pending;
}

async function createLanguageSupport(language: EditorLanguage): Promise<Extension> {
  switch (language) {
    case "cpp": {
      const { cpp } = await import("@codemirror/legacy-modes/mode/clike");
      return StreamLanguage.define(cpp);
    }
    case "java": {
      const { java } = await import("@codemirror/legacy-modes/mode/clike");
      return StreamLanguage.define(java);
    }
    case "yaml": {
      const { yaml } = await import("@codemirror/lang-yaml");
      return yaml();
    }
    case "csharp": {
      const { csharp } = await import("@codemirror/legacy-modes/mode/clike");
      return StreamLanguage.define(csharp);
    }
    case "proto": {
      const { protobuf } = await import("@codemirror/legacy-modes/mode/protobuf");
      return StreamLanguage.define(protobuf);
    }
    case "plain":
      return [];
  }
}
