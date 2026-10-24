// Language support for the CodeMirror editors (plan §5).
//
// The filename decides the language (v3 removed the `Language` option, §6):
// the C-family languages, Java, C#, Kotlin, Objective-C and Protobuf use the
// stream modes from `@codemirror/legacy-modes`; JavaScript/TypeScript use the
// sibling legacy parsers (there is no JS/TS entry in the clike module), YAML
// backs the configuration drawer. Everything is loaded lazily and cached, so
// uncommon languages never sit in the entry chunk (the first-load budget in
// plan §1 is 250 KB gzip).
//
// M4 (plan §9): the extension table grew to the filenames people actually pass
// to clang-format (`.kt`, `.ts`, `.js`, `.m`, `.mm`, …). clang-format itself
// still receives the original filename; this mapping only drives highlighting
// and the language badge.

import { StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

export type EditorLanguage =
  | "cpp"
  | "java"
  | "csharp"
  | "kotlin"
  | "objectivec"
  | "objectivecpp"
  | "javascript"
  | "typescript"
  | "proto"
  | "yaml"
  | "plain";

const BY_EXTENSION: Readonly<Record<string, EditorLanguage>> = {
  // C/C++
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  cp: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  "c++": "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  "h++": "cpp",
  ipp: "cpp",
  inl: "cpp",
  // Java / C# / Kotlin
  java: "java",
  cs: "csharp",
  kt: "kotlin",
  kts: "kotlin",
  // Objective-C / Objective-C++
  m: "objectivec",
  mm: "objectivecpp",
  // JavaScript / TypeScript
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  // Protobuf (clang-format supports .proto files)
  proto: "proto",
  // YAML: the configuration drawer and any YAML passed as a filename
  yaml: "yaml",
  yml: "yaml",
};

export const LANGUAGE_LABELS: Readonly<Record<EditorLanguage, string>> = {
  cpp: "C/C++",
  java: "Java",
  csharp: "C#",
  kotlin: "Kotlin",
  objectivec: "Objective-C",
  objectivecpp: "Objective-C++",
  javascript: "JavaScript",
  typescript: "TypeScript",
  proto: "Protobuf",
  yaml: "YAML",
  plain: "Plain text",
};

/** Lower-case basename without directories, e.g. `src/Main.CC` → `main.cc`. */
function basename(filename: string): string {
  const trimmed = filename.trim().toLowerCase().replace(/\\/g, "/");
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

/** Map a filename (`main.cc`, `.clang-format`) to an editor language. */
export function languageForFilename(filename: string): EditorLanguage {
  const base = basename(filename);
  // `.clang-format` has no regular extension (and may include a directory).
  if (base === ".clang-format") return "yaml";

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
    case "csharp": {
      const { csharp } = await import("@codemirror/legacy-modes/mode/clike");
      return StreamLanguage.define(csharp);
    }
    case "kotlin": {
      const { kotlin } = await import("@codemirror/legacy-modes/mode/clike");
      return StreamLanguage.define(kotlin);
    }
    case "objectivec": {
      const { objectiveC } = await import("@codemirror/legacy-modes/mode/clike");
      return StreamLanguage.define(objectiveC);
    }
    case "objectivecpp": {
      const { objectiveCpp } = await import("@codemirror/legacy-modes/mode/clike");
      return StreamLanguage.define(objectiveCpp);
    }
    case "javascript": {
      const { javascript } = await import("@codemirror/legacy-modes/mode/javascript");
      return StreamLanguage.define(javascript);
    }
    case "typescript": {
      const { typescript } = await import("@codemirror/legacy-modes/mode/javascript");
      return StreamLanguage.define(typescript);
    }
    case "proto": {
      const { protobuf } = await import("@codemirror/legacy-modes/mode/protobuf");
      return StreamLanguage.define(protobuf);
    }
    case "yaml": {
      const { yaml } = await import("@codemirror/lang-yaml");
      return yaml();
    }
    case "plain":
      return [];
  }
}
