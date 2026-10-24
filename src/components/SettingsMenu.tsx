// Header settings popover (plan §5 主题 / 持久化, §9 M3).
//
// A small non-modal popover anchored to a "Settings" button. It owns only the
// open/closed state and focus management; theme and font size are controlled by
// App so they can be persisted (src/lib/persisted-state.ts) and applied
// (src/lib/theme.ts applyTheme) in one place.
//
// Keyboard/pointer contract:
//   - toggle: aria-haspopup="dialog" + aria-expanded, data-testid="settings-toggle"
//   - panel: role="dialog" (non-modal), labelled by its title
//   - opening moves focus to the current theme radio (first focusable control)
//   - Escape, an outside pointer press, or the Close button close it
//   - closing returns focus to the toggle
//
// The `editor-font-size` testid predates this component (it lived in the header
// in M2); it is kept here so the e2e suite only needs to open the menu first.

import { useCallback, useEffect, useId, useRef, useState, type JSX } from "react";
import { THEME_PREFERENCES, type ThemePreference } from "../lib/theme";
import styles from "./SettingsMenu.module.css";

export type SettingsMenuProps = {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  editorFontSize: number;
  onFontSizeChange: (size: number) => void;
};

/** Same choices as the M2 header select; the persisted layer accepts 11–24. */
const EDITOR_FONT_SIZES = [12, 13, 14, 16, 18, 20] as const;

const THEME_LABELS: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

const FOCUSABLE_SELECTOR =
  "button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function SettingsMenu(props: SettingsMenuProps): JSX.Element {
  const { theme, onThemeChange, editorFontSize, onFontSizeChange } = props;

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const menuId = useId();
  const titleId = useId();
  const themeLegendId = useId();

  const close = useCallback((): void => setOpen(false), []);

  // Opening moves focus into the panel (the checked theme radio when there is
  // one); closing restores it to whatever was focused before (the toggle).
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : toggleRef.current;
    const panel = panelRef.current;
    const checked = panel?.querySelector<HTMLElement>("input[name='settings-theme']:checked") ?? null;
    const initial = checked ?? panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? toggleRef.current;
    initial?.focus();
    return () => previous?.focus();
  }, [open]);

  // Escape closes. The listener lives on the document because the popover is
  // not modal and the panel itself does not keep a focus trap.
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  // An outside pointer press closes the popover. Presses inside the root
  // (toggle + panel) are ignored, so the toggle's own onClick still controls
  // the open/close flip.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root === null) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <div ref={rootRef} className={styles.root}>
      <button
        ref={toggleRef}
        type="button"
        className={styles.toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid="settings-toggle"
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true" className={styles.gear}>
          {"⚙"}
        </span>
        <span>Settings</span>
      </button>

      {open && (
        <div
          ref={panelRef}
          id={menuId}
          className={styles.panel}
          role="dialog"
          aria-labelledby={titleId}
          data-testid="settings-menu"
        >
          <header className={styles.panelHeader}>
            <h2 id={titleId} className={styles.title}>
              Settings
            </h2>
            <button
              type="button"
              className={styles.close}
              aria-label="Close settings"
              data-testid="settings-close"
              onClick={close}
            >
              {"×"}
            </button>
          </header>

          <fieldset className={styles.group} role="radiogroup" aria-labelledby={themeLegendId}>
            <legend id={themeLegendId} className={styles.legend}>
              Theme
            </legend>
            {THEME_PREFERENCES.map((value) => (
              <label key={value} className={styles.radio}>
                <input
                  type="radio"
                  name="settings-theme"
                  value={value}
                  checked={theme === value}
                  data-testid={`theme-${value}`}
                  onChange={() => onThemeChange(value)}
                />
                <span>{THEME_LABELS[value]}</span>
              </label>
            ))}
          </fieldset>

          <label className={styles.field}>
            <span>Editor font size</span>
            <select
              className={styles.select}
              value={editorFontSize}
              data-testid="editor-font-size"
              onChange={(event) => onFontSizeChange(Number(event.target.value))}
            >
              {EDITOR_FONT_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}px
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

export default SettingsMenu;
