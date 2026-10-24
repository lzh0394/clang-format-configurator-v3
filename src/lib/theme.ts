// Theme preference handling (plan §5 主题: follow the system, or an explicit
// light/dark choice; plan §9 M3). Everything except `applyTheme` /
// `systemPrefersDark` is pure, so the node-environment unit suite can test the
// decision logic without a DOM.
//
// The DOM contract is shared with the pre-paint script in index.html and the
// token rules in src/styles.css:
//   - explicit light/dark -> <html data-theme="light|dark"> + inline color-scheme
//   - system              -> no data-theme attribute, no inline color-scheme
// styles.css then follows `prefers-color-scheme` for the "system" case.

export type ThemePreference = "system" | "light" | "dark";

/** The two themes that can actually be painted. */
export type ResolvedTheme = "light" | "dark";

/** Stable order for the settings radio group. */
export const THEME_PREFERENCES = ["system", "light", "dark"] as const satisfies readonly ThemePreference[];

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * Map a stored preference plus the current system setting to the theme that
 * should be painted. An explicit choice always wins over the system value;
 * only `"system"` consults `prefersDark`.
 */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

/**
 * Current `prefers-color-scheme` value. Guarded against environments without
 * `matchMedia` (node unit tests, very old browsers): those report light, which
 * matches the base palette in styles.css.
 */
export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

/**
 * Reflect a preference on the document root.
 *
 * - `"light"` / `"dark"`: set `data-theme` and the inline `color-scheme`, so an
 *   explicit choice wins over the `prefers-color-scheme` media query.
 * - `"system"`: remove `data-theme` and clear the inline `color-scheme` so
 *   styles.css follows the OS again.
 *
 * `root` defaults to `document.documentElement`. A missing document (SSR, node
 * tests) or a missing root is a silent no-op; this function never throws.
 */
export function applyTheme(preference: ThemePreference, root?: HTMLElement): void {
  const target: HTMLElement | null = root ?? (typeof document === "undefined" ? null : document.documentElement);
  if (target === null || target === undefined) return;

  if (preference === "system") {
    target.removeAttribute("data-theme");
    // Assigning "" removes the inline declaration (CSSOM behaviour), which
    // uncovers the `color-scheme` declared by styles.css.
    target.style.colorScheme = "";
    return;
  }

  target.setAttribute("data-theme", preference);
  target.style.colorScheme = preference;
}
