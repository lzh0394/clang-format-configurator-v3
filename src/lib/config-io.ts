// Import / export of `.clang-format` YAML (plan §4, M1 contract §3).
//
// Export writes `BasedOnStyle` plus either the sparse `modified` map ("minimal")
// or every option with an effective value ("full"). Import validates the YAML
// against the schema, converts legacy scalar forms and reports every problem it
// can recover from as a warning. The pair is byte-idempotent: exporting, parsing
// and exporting again produces exactly the same string.
//
// Pure module on purpose: no React / DOM imports, so it runs directly in node.

import { parseAllDocuments, stringify } from "yaml";

import { effectiveValue, isPlainObject, type Modified } from "./config";
import type { Field, OptionDef, OptionType, ScalarKind, SchemaCore, StyleName } from "./schema";

export type ExportMode = "minimal" | "full";

export const CONFIG_FILENAME = ".clang-format";

export type ImportWarning = { path: string; message: string };

export type ImportResult = {
  /** `null` when the text has no `BasedOnStyle` (keep the current style). */
  style: StyleName | null;
  modified: Modified;
  warnings: ImportWarning[];
};

/** Fatal import problem (bad YAML syntax, top level not a mapping). */
export class ImportError extends Error {
  /** Full underlying message, with YAML's line/column context when available. */
  readonly detail: string;

  constructor(message: string, detail = "") {
    super(message);
    this.name = "ImportError";
    this.detail = detail;
  }
}

const MULTIPLE_DOCUMENTS_WARNING = "multiple YAML documents; only the first is imported";
const LANGUAGE_WARNING = "Language is derived from the filename; ignored";
const LEGACY_BOOLEAN_WARNING = "legacy boolean converted to nested map";
const LEGACY_ALIGN_CONSECUTIVE_WARNING = "legacy AlignConsecutive enum converted to nested map";
const INHERIT_PARENT_CONFIG_WARNING = "InheritParentConfig is not supported; the current style is kept";

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Serialize the configuration as `.clang-format` YAML (single trailing newline).
 *
 * - `minimal`: `BasedOnStyle` plus the explicitly modified options only.
 * - `full`: `BasedOnStyle` plus every option that has an effective value for the
 *   selected style (defaults materialized), i.e. a self-contained / locked file.
 *
 * Options are emitted in `schema.options` order, independently of the order in
 * which they were modified. Enum values are written in their canonical spelling
 * (the schema presets of e.g. `RawStringFormats[].BasedOnStyle` use lowercase
 * "google"), so a full export stays byte-identical across an import/export trip.
 */
export function serializeConfig(
  schema: SchemaCore,
  style: StyleName,
  modified: Modified,
  mode: ExportMode = "minimal",
): string {
  const document: Record<string, unknown> = { BasedOnStyle: style };

  for (const option of schema.options) {
    const hasExplicitValue = Object.hasOwn(modified, option.key) && modified[option.key] !== undefined;

    if (mode === "minimal") {
      if (!hasExplicitValue) continue;
      document[option.key] = canonicalizeValue(option.type, modified[option.key]);
      continue;
    }

    // Full mode: skip options that neither have a preset for this style nor an
    // explicit value; otherwise materialize the effective value.
    if (!hasExplicitValue && option.defaults[style] === undefined) continue;
    const value = effectiveValue(option, style, modified);
    if (value === undefined) continue;
    document[option.key] = canonicalizeValue(option.type, value);
  }

  return withSingleTrailingNewline(stringify(document, { lineWidth: 0 }));
}

/** Rewrite enum spellings to their canonical form; unknown values pass through. */
function canonicalizeValue(type: OptionType, value: unknown): unknown {
  switch (type.kind) {
    case "scalar":
      return value;
    case "enum":
      return canonicalizeEnum(type.values, value);
    case "map": {
      if (!isPlainObject(value)) return value;
      const result: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        const child = type.children.find((candidate) => candidate.key === childKey);
        result[childKey] = child ? canonicalizeValue(child.type, childValue) : childValue;
      }
      return result;
    }
    case "list": {
      if (!Array.isArray(value)) return value;
      if (type.item === "string") return [...value];
      return value.map((item) => {
        if (!isPlainObject(item)) return item;
        const result: Record<string, unknown> = {};
        for (const [fieldKey, fieldValue] of Object.entries(item)) {
          const field = type.fields.find((candidate) => candidate.key === fieldKey);
          result[fieldKey] = field ? canonicalizeValue(field.type, fieldValue) : fieldValue;
        }
        return result;
      });
    }
  }
}

function canonicalizeEnum(values: readonly string[], value: unknown): unknown {
  if (typeof value !== "string") return value;
  const canonical = values.find((candidate) => candidate.toLowerCase() === value.toLowerCase());
  return canonical ?? value;
}

function withSingleTrailingNewline(text: string): string {
  return `${text.replace(/\n+$/, "")}\n`;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

type Warn = (path: string, message: string) => void;

type ValidationResult = { ok: true; value: unknown } | { ok: false };

const valid = (value: unknown): ValidationResult => ({ ok: true, value });
const failed: ValidationResult = { ok: false };

/**
 * Parse a `.clang-format` text against the schema.
 *
 * Fatal problems (YAML syntax errors, top level not a mapping) throw
 * `ImportError`; everything else — unknown options, invalid values, legacy
 * spellings, extra YAML documents — is reported through `warnings` while the
 * valid remainder is returned. A `null` style means "no BasedOnStyle in the
 * file, keep the current style".
 */
export function parseConfigText(text: string, schema: SchemaCore): ImportResult {
  const warnings: ImportWarning[] = [];
  const warn: Warn = (path, message) => {
    warnings.push({ path, message });
  };

  const values = parseDocumentValues(text);

  // Empty / whitespace-only / null-only documents: clear all modifications.
  if (values.length === 0) return { style: null, modified: {}, warnings: [] };

  // Language-specific `.clang-format` files may hold several documents; only the
  // first one with content is imported.
  if (values.length > 1) warn("", MULTIPLE_DOCUMENTS_WARNING);

  const root = values[0];
  if (!isPlainObject(root)) {
    throw new ImportError("configuration must be a YAML mapping");
  }

  const optionsByKey = new Map(schema.options.map((option) => [option.key, option]));
  const modified: Modified = {};
  let style: StyleName | null = null;

  for (const [key, value] of Object.entries(root)) {
    if (key === "BasedOnStyle") {
      style = parseBasedOnStyle(value, schema, warn);
      continue;
    }

    if (key === "Language") {
      // plan §6: language is derived from the code/filename and is not an option.
      warn(key, LANGUAGE_WARNING);
      continue;
    }

    const option = optionsByKey.get(key);
    if (!option) {
      warn(key, `unknown option "${key}" for clang-format ${schema.version}`);
      continue;
    }

    const result = validateOption(option, value, key, warn);
    if (result.ok) modified[key] = result.value;
  }

  return { style, modified, warnings };
}

/**
 * Turn the YAML documents into the list of non-null document values, in order.
 * Throws `ImportError` for syntax errors.
 */
function parseDocumentValues(text: string): unknown[] {
  let documents: ReturnType<typeof parseAllDocuments>;
  try {
    documents = parseAllDocuments(text);
  } catch (error) {
    throw toImportError(error);
  }

  const values: unknown[] = [];
  for (const document of documents) {
    const firstError = document.errors[0];
    if (firstError) {
      // YAML errors carry line/column info and a multi-line context block; the
      // one-line summary is the user-facing message, the rest goes to `detail`.
      throw new ImportError(firstLine(firstError.message), firstError.message);
    }
    const value: unknown = document.toJS();
    if (value !== null && value !== undefined) values.push(value);
  }
  return values;
}

function parseBasedOnStyle(value: unknown, schema: SchemaCore, warn: Warn): StyleName | null {
  if (typeof value !== "string") {
    warn("BasedOnStyle", `expected a string, got ${describeValue(value)}`);
    return null;
  }
  const canonical = schema.styles.find((candidate) => candidate.toLowerCase() === value.toLowerCase());
  if (canonical) return canonical;
  if (value.toLowerCase() === "inheritparentconfig") {
    warn("BasedOnStyle", INHERIT_PARENT_CONFIG_WARNING);
    return null;
  }
  warn("BasedOnStyle", `unknown style "${value}"`);
  return null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateOption(option: OptionDef, value: unknown, path: string, warn: Warn): ValidationResult {
  return validateValue(option.type, value, path, option.key, warn);
}

function validateValue(
  type: OptionType,
  value: unknown,
  path: string,
  optionKey: string,
  warn: Warn,
): ValidationResult {
  switch (type.kind) {
    case "scalar":
      return validateScalar(type.scalar, value, path, warn);
    case "enum":
      return validateEnum(type.values, value, path, warn);
    case "map":
      return validateMap(type.children, value, path, optionKey, warn);
    case "list":
      if (type.item === "string") return validateStringList(value, path, warn);
      return validateStructList(type.fields, optionKey, value, path, warn);
  }
}

function validateScalar(kind: ScalarKind, value: unknown, path: string, warn: Warn): ValidationResult {
  switch (kind) {
    case "bool":
      return typeof value === "boolean" ? valid(value) : reject(warn, path, "a boolean", value);
    case "int":
      return typeof value === "number" && Number.isInteger(value)
        ? valid(value)
        : reject(warn, path, "an integer", value);
    case "uint":
      return typeof value === "number" && Number.isInteger(value) && value >= 0
        ? valid(value)
        : reject(warn, path, "a non-negative integer", value);
    case "string":
      return typeof value === "string" ? valid(value) : reject(warn, path, "a string", value);
  }
}

function validateEnum(values: readonly string[], value: unknown, path: string, warn: Warn): ValidationResult {
  if (typeof value !== "string") return reject(warn, path, "a string", value);
  const canonical = values.find((candidate) => candidate.toLowerCase() === value.toLowerCase());
  if (canonical !== undefined) return valid(canonical);
  warn(path, `unknown value "${value}"; expected one of ${values.join(", ")}`);
  return failed;
}

function validateMap(
  children: readonly Field[],
  value: unknown,
  path: string,
  optionKey: string,
  warn: Warn,
): ValidationResult {
  // Legacy shorthands predating the nested mappings (still accepted by wasm).
  if (typeof value === "boolean" && children.some((child) => child.key === "Enabled")) {
    warn(path, LEGACY_BOOLEAN_WARNING);
    return valid({ Enabled: value });
  }
  if (typeof value === "string" && optionKey.startsWith("AlignConsecutive")) {
    const converted = convertLegacyAlignConsecutive(value);
    if (converted !== undefined) {
      warn(path, LEGACY_ALIGN_CONSECUTIVE_WARNING);
      return valid(converted);
    }
  }
  if (typeof value === "boolean" && optionKey === "AlignTrailingComments") {
    // wasm accepts the old boolean; true behaved like `Always`, false like `Never`.
    warn(path, LEGACY_BOOLEAN_WARNING);
    return valid({ Kind: value ? "Always" : "Never" });
  }

  if (!isPlainObject(value)) return reject(warn, path, "a mapping", value);

  // Keep only known children, as a sparse patch: preset values are not copied in.
  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const child = children.find((candidate) => candidate.key === childKey);
    if (!child) {
      warn(`${path}.${childKey}`, `unknown option "${childKey}" for ${optionKey}`);
      continue;
    }
    const parsed = validateValue(child.type, childValue, `${path}.${childKey}`, optionKey, warn);
    if (parsed.ok) result[childKey] = parsed.value;
  }
  return valid(result);
}

function convertLegacyAlignConsecutive(value: string): Record<string, boolean> | undefined {
  switch (value.toLowerCase()) {
    case "none":
      return { Enabled: false };
    case "consecutive":
      return { Enabled: true };
    case "acrossemptylines":
      return { Enabled: true, AcrossEmptyLines: true };
    case "acrosscomments":
      return { Enabled: true, AcrossComments: true };
    case "acrossemptylinesandcomments":
      return { Enabled: true, AcrossEmptyLines: true, AcrossComments: true };
    default:
      return undefined;
  }
}

function validateStringList(value: unknown, path: string, warn: Warn): ValidationResult {
  if (!Array.isArray(value)) return reject(warn, path, "a list of strings", value);
  if (!value.every((item) => typeof item === "string")) {
    warn(path, "expected a list of strings");
    return failed;
  }
  return valid([...value]);
}

function validateStructList(
  fields: readonly Field[],
  optionKey: string,
  value: unknown,
  path: string,
  warn: Warn,
): ValidationResult {
  if (!Array.isArray(value)) return reject(warn, path, "a list of mappings", value);

  const items: Record<string, unknown>[] = [];
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isPlainObject(item)) {
      warn(itemPath, `expected a mapping, got ${describeValue(item)}; item ignored`);
      return;
    }
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      if (!Object.hasOwn(item, field.key)) continue;
      const parsed = validateValue(field.type, item[field.key], `${itemPath}.${field.key}`, optionKey, warn);
      if (parsed.ok) result[field.key] = parsed.value;
    }
    for (const fieldKey of Object.keys(item)) {
      if (!fields.some((field) => field.key === fieldKey)) {
        warn(`${itemPath}.${fieldKey}`, `unknown field "${fieldKey}" for ${optionKey}`);
      }
    }
    // Empty items are valid and are preserved as `{}`.
    items.push(result);
  });
  return valid(items);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function reject(warn: Warn, path: string, expected: string, value: unknown): ValidationResult {
  warn(path, `expected ${expected}, got ${describeValue(value)}`);
  return failed;
}

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "a list";
  switch (typeof value) {
    case "boolean":
      return "a boolean";
    case "number":
      return "a number";
    case "string":
      return "a string";
    case "object":
      return "a mapping";
    default:
      return typeof value;
  }
}

function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

function toImportError(error: unknown): ImportError {
  if (error instanceof ImportError) return error;
  if (error instanceof Error) return new ImportError(firstLine(error.message), error.message);
  return new ImportError("invalid YAML", String(error));
}
