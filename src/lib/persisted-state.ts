// Versioned localStorage persistence (plan §5 持久化, §9 M3).
//
// One JSON document under STORAGE_KEY:
//   { stateVersion, version, style, modified, code, theme, editorFontSize, uiFontScale }
//
// `loadPersistedState` is synchronous and never throws. Failure modes are
// reported through `problem` instead of exceptions:
//
//   "none"              -> `state` holds a normalized document
//   "empty"             -> nothing stored yet (first visit)
//   "corrupt"           -> unparsable JSON or wrong top-level shape
//   "version-mismatch"  -> valid document from another STATE_VERSION; the
//                          caller drops it and may tell the user
//   "unavailable"       -> no usable storage (SSR, private mode, disabled
//                          storage, getItem throwing)
//
// Within an otherwise valid document, individual fields are normalized
// defensively: an invalid field falls back to its default instead of failing
// the whole load (e.g. a theme of "blue" becomes "system"). This keeps a
// hand-edited or partially written entry from bricking the app; callers still
// learn about structural problems via `problem`.
//
// `savePersistedState` stamps the current STATE_VERSION, validates/normalizes
// the document, and never throws; quota exhaustion is reported as "quota".
// `clearPersistedState` removes the entry and never throws.

import type { Modified } from "./config";
import type { StyleName } from "./schema";
import { isThemePreference, type ThemePreference } from "./theme";

/** Storage key shared with the pre-paint theme script in index.html. */
export const STORAGE_KEY = "clang-format-configurator:v3";

/** Bump when the persisted document shape or its meaning changes. */
export const STATE_VERSION = 1;

export const DEFAULT_STYLE: StyleName = "LLVM";
export const DEFAULT_THEME: ThemePreference = "system";
export const DEFAULT_EDITOR_FONT_SIZE = 13;
export const DEFAULT_UI_FONT_SCALE = 1;

/**
 * Interface font-size tiers (plan §5 持久化/字号). `uiFontScale` is a
 * multiplier applied to the root font size by src/styles.css, so the whole UI
 * scales while the editor keeps its independent `--font-size-editor`.
 *
 * An additive field with a well-defined default does not require a
 * STATE_VERSION bump: older documents load with scale 1, and older builds
 * simply ignore the unknown key (normalize() copies only known fields).
 */
export const UI_FONT_SCALES = [0.9, 1, 1.15] as const;

/**
 * Range accepted by the persistence layer. The settings UI currently offers
 * 12–20 px; the wider 11–24 band keeps values written by other/older builds
 * usable while still rejecting nonsense.
 */
export const EDITOR_FONT_SIZE_MIN = 11;
export const EDITOR_FONT_SIZE_MAX = 24;

/** Runtime list of style names (StyleName is type-only in lib/schema.ts). */
export const STYLE_NAMES: readonly StyleName[] = [
  "LLVM",
  "Google",
  "Chromium",
  "Mozilla",
  "WebKit",
  "Microsoft",
  "GNU",
];

export type PersistedState = {
  stateVersion: number;
  version: string;
  style: StyleName;
  modified: Modified;
  code: string;
  theme: ThemePreference;
  editorFontSize: number;
  uiFontScale: number;
};

export type LoadProblem = "none" | "empty" | "corrupt" | "version-mismatch" | "unavailable";
export type LoadResult = { state: PersistedState | null; problem: LoadProblem };
export type SaveResult = "ok" | "quota" | "unavailable";

/** Minimal storage surfaces, so tests (and non-browser callers) can inject fakes. */
export type ReadStorage = Pick<Storage, "getItem">;
export type WriteStorage = Pick<Storage, "setItem">;
export type RemoveStorage = Pick<Storage, "removeItem">;

type FullStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function isStyleName(value: unknown): value is StyleName {
  return typeof value === "string" && (STYLE_NAMES as readonly string[]).includes(value);
}

export function isValidEditorFontSize(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= EDITOR_FONT_SIZE_MIN &&
    value <= EDITOR_FONT_SIZE_MAX
  );
}

/** True for one of the UI font-size tiers; anything else falls back to 1. */
export function isUiFontScale(value: unknown): value is number {
  return typeof value === "number" && (UI_FONT_SCALES as readonly number[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Browser localStorage when it is actually reachable. `window` is checked
 * first so the node unit suite does not touch Node's experimental
 * `globalThis.localStorage` getter.
 */
function defaultStorage(): FullStorage | null {
  try {
    if (typeof window === "undefined") return null;
    const candidate: unknown = window.localStorage;
    if (candidate === null || candidate === undefined) return null;
    return candidate as FullStorage;
  } catch {
    // Accessing localStorage can throw a SecurityError (private mode, blocked
    // third-party storage, ...).
    return null;
  }
}

/** True for the quota errors browsers raise when localStorage is full. */
function isQuotaExceededError(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const name = (cause as { name?: unknown }).name;
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return true;
  const code = (cause as { code?: unknown }).code;
  return code === 22 || code === 1014;
}

/**
 * Validate/normalize a parsed document. Returns null only when the value is not
 * an object or does not carry the version marker at all (structural corruption);
 * invalid individual fields are replaced with defaults.
 */
function normalize(value: unknown): PersistedState | null {
  if (!isRecord(value)) return null;
  if (typeof value.stateVersion !== "number") return null;

  return {
    stateVersion: STATE_VERSION,
    version: typeof value.version === "string" ? value.version : "",
    style: isStyleName(value.style) ? value.style : DEFAULT_STYLE,
    modified: isRecord(value.modified) ? value.modified : {},
    code: typeof value.code === "string" ? value.code : "",
    // `isThemePreference(props.theme)` guards the type; the cast below only
    // narrows the result of the validation.
    theme: isThemePreference(value.theme) ? value.theme : DEFAULT_THEME,
    editorFontSize: isValidEditorFontSize(value.editorFontSize)
      ? value.editorFontSize
      : DEFAULT_EDITOR_FONT_SIZE,
    // Missing (documents written before M4) and invalid values both mean 100%.
    uiFontScale: isUiFontScale(value.uiFontScale) ? value.uiFontScale : DEFAULT_UI_FONT_SCALE,
  };
}

/**
 * Read and normalize the persisted document.
 *
 * @param storage optional `getItem` provider (defaults to `window.localStorage`).
 */
export function loadPersistedState(storage?: ReadStorage): LoadResult {
  const store: ReadStorage | null = storage !== undefined ? storage : defaultStorage();
  if (store === null) return { state: null, problem: "unavailable" };

  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return { state: null, problem: "unavailable" };
  }

  if (raw === null || raw === undefined || raw === "") return { state: null, problem: "empty" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { state: null, problem: "corrupt" };
  }

  if (!isRecord(parsed) || typeof parsed.stateVersion !== "number") {
    return { state: null, problem: "corrupt" };
  }
  if (parsed.stateVersion !== STATE_VERSION) {
    return { state: null, problem: "version-mismatch" };
  }

  const state = normalize(parsed);
  if (state === null) return { state: null, problem: "corrupt" };
  return { state, problem: "none" };
}

/**
 * Persist the document, stamped with the current STATE_VERSION.
 * Never throws; returns "quota" when the browser rejects the write for size.
 *
 * @param storage optional `setItem` provider (defaults to `window.localStorage`).
 */
export function savePersistedState(state: PersistedState, storage?: WriteStorage): SaveResult {
  const store: WriteStorage | null = storage !== undefined ? storage : defaultStorage();
  if (store === null) return "unavailable";

  let payload: string;
  try {
    const normalized = normalize({ ...state, stateVersion: STATE_VERSION });
    if (normalized === null) return "unavailable";
    payload = JSON.stringify(normalized);
  } catch {
    // e.g. a circular `modified` value: not persistable.
    return "unavailable";
  }

  try {
    store.setItem(STORAGE_KEY, payload);
    return "ok";
  } catch (cause) {
    return isQuotaExceededError(cause) ? "quota" : "unavailable";
  }
}

/**
 * Remove the persisted document. Never throws; a no-op when storage is
 * unavailable.
 *
 * @param storage optional `removeItem` provider (defaults to `window.localStorage`).
 */
export function clearPersistedState(storage?: RemoveStorage): void {
  const store: RemoveStorage | null = storage !== undefined ? storage : defaultStorage();
  if (store === null) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // Clearing is best-effort; the caller has nothing to recover from.
  }
}
