// The `modified` model (plan §4): only options the user actually changed are
// stored, keyed by top-level option name. Display values are derived through
// `effectiveValue`; undefined means "inherit from the preset style".
//
// Maps (BraceWrapping, AlignConsecutive*, ...) are stored sparsely: only the
// children the user touched live under the option key. The effective value
// merges that patch over the preset default, and the sparse form is exactly
// what is sent to clang-format and what Minimal export writes.

import type { OptionDef, StyleName } from "./schema";

export type Modified = Record<string, unknown>;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the option has an explicit value (i.e. the user changed it). */
export function isModified(modified: Modified, key: string): boolean {
  return Object.hasOwn(modified, key);
}

/**
 * Display / payload value of a top-level option:
 * explicit change, else the style preset default, else undefined ("unset").
 *
 * For map options the explicit change is sparse, so the effective value is the
 * preset mapping overlaid with the patch.
 */
export function effectiveValue(option: OptionDef, style: StyleName, modified: Modified): unknown {
  const hasOverride = Object.hasOwn(modified, option.key);
  const override = modified[option.key];
  const preset = option.defaults[style];

  if (option.type.kind === "map") {
    const base = isPlainObject(preset) ? preset : {};
    const patch = isPlainObject(override) ? override : {};
    return { ...base, ...patch };
  }

  return hasOverride ? override : preset;
}

/** Effective value of one child of a map option. */
export function effectiveChildValue(
  option: OptionDef,
  childKey: string,
  style: StyleName,
  modified: Modified,
): unknown {
  const value = effectiveValue(option, style, modified);
  return isPlainObject(value) ? value[childKey] : undefined;
}

/**
 * Replace (or delete, with `undefined`) the whole explicit value of one option.
 * Used by scalar / enum / list controls and by "reset" affordances.
 */
export function setOption(modified: Modified, key: string, value: unknown): Modified {
  const next = { ...modified };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/**
 * Patch one child of a map option. The stored override stays sparse; deleting
 * the last child removes the option key entirely (back to fully inherited).
 */
export function setChildOption(
  modified: Modified,
  option: OptionDef,
  childKey: string,
  value: unknown,
): Modified {
  const existing = modified[option.key];
  const current = isPlainObject(existing) ? { ...existing } : {};
  if (value === undefined) delete current[childKey];
  else current[childKey] = value;
  return setOption(modified, option.key, Object.keys(current).length === 0 ? undefined : current);
}

/** Compact display form for inherited/mutated values in the options panel. */
export function formatValue(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return value === "" ? '""' : value;
  if (value === null) return "null";
  if (Array.isArray(value) || typeof value === "object") return JSON.stringify(value);
  return String(value);
}
