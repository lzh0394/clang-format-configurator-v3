// Slide-over configuration drawer (plan §5 配置页, M2 §9 item 6).
//
// Edits the `.clang-format` YAML directly: the text is initialized from
// `serializeConfig` every time the drawer opens, validated live (debounced)
// against the schema and applied through the same `parseConfigText` path as the
// M1 import dialog. The bottom preview shows what applying the text would do
// relative to the current configuration (added / removed / changed top-level
// keys plus a style change line).
//
// App owns the state; the drawer is controlled through `open` and hands the
// parsed `ImportResult` back via `onApply`, then closes.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
  type MouseEvent as ReactMouseEvent,
} from "react";

import type { Modified } from "../lib/config";
import { diffModified, type ModifiedDiff } from "../lib/config-diff";
import {
  CONFIG_FILENAME,
  ImportError,
  parseConfigText,
  serializeConfig,
  type ExportMode,
  type ImportResult,
  type ImportWarning,
} from "../lib/config-io";
import type { SchemaCore, StyleName } from "../lib/schema";
import { CodeEditor } from "../editor/CodeEditor";
import styles from "./ConfigDrawer.module.css";

export type ConfigDrawerProps = {
  open: boolean;
  schema: SchemaCore;
  style: StyleName;
  modified: Modified;
  onClose: () => void;
  onApply: (result: ImportResult) => void;
};

type ImportFailure = { message: string; detail: string };

type ValidationState = {
  /** The editor text this result was computed from. */
  text: string;
  /** Fatal parse problem; `null` when the YAML could be parsed. */
  error: ImportFailure | null;
  warnings: ImportWarning[];
  /** Parsed result, or `null` after a fatal error. */
  result: ImportResult | null;
};

const VALIDATION_DEBOUNCE_MS = 150;

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

const EMPTY_VALIDATION: ValidationState = {
  text: "",
  error: null,
  warnings: [],
  result: { style: null, modified: {}, warnings: [] },
};

export default function ConfigDrawer(props: ConfigDrawerProps): JSX.Element | null {
  const { open, schema, style, modified, onClose, onApply } = props;

  const [mode, setMode] = useState<ExportMode>("minimal");
  const [text, setText] = useState("");
  const [validation, setValidation] = useState<ValidationState>(EMPTY_VALIDATION);

  const panelRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Read by the open effect without making `mode` a dependency: the YAML is
  // re-serialized in whichever mode the drawer was last used in.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Each open starts from the current configuration, resetting any unapplied edits.
  useEffect(() => {
    if (!open) return;
    const initial = safeSerialize(schema, style, modified, modeRef.current);
    setText(initial);
    setValidation(validateText(initial, schema));
    // Only re-initialize on open transitions; edits made while open are kept.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Initial focus moves into the drawer; closing returns it to the trigger.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstFocusable = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();
    return () => previous?.focus();
  }, [open]);

  // Escape closes, Tab is trapped inside the drawer (it is modal).
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (panel === null) return;
      const focusables = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (first === undefined || last === undefined) return;

      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !panel.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  // Debounced live validation. A fatal error is shown inline, warnings stay
  // recoverable and the empty document parses as "clear the configuration".
  useEffect(() => {
    if (!open) return;
    if (validation.text === text) return;
    const timer = window.setTimeout(() => {
      setValidation(validateText(text, schema));
    }, VALIDATION_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, text, schema, validation.text]);

  const changeMode = useCallback(
    (nextMode: ExportMode): void => {
      setMode(nextMode);
      const nextText = safeSerialize(schema, style, modified, nextMode);
      setText(nextText);
      setValidation(validateText(nextText, schema));
    },
    [schema, style, modified],
  );

  const download = useCallback((): void => {
    const blob = new Blob([text], { type: "text/yaml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = CONFIG_FILENAME;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [text]);

  const readFile = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      if (file === undefined) return;
      void file
        .text()
        .then((loaded) => {
          setText(loaded);
          setValidation(validateText(loaded, schema));
        })
        .catch((cause: unknown) => {
          setValidation({
            text,
            error: {
              message: "Could not read the selected file",
              detail: cause instanceof Error ? cause.message : String(cause),
            },
            warnings: [],
            result: null,
          });
        })
        .finally(() => {
          // Allow selecting the same file again after a failure.
          input.value = "";
        });
    },
    [schema, text],
  );

  const apply = useCallback((): void => {
    try {
      const result = parseConfigText(text, schema);
      setValidation({ text, error: null, warnings: result.warnings, result });
      onApply(result);
      onClose();
    } catch (cause) {
      setValidation({ text, error: toFailure(cause), warnings: [], result: null });
    }
  }, [text, schema, onApply, onClose]);

  const optionOrder = useMemo(() => schema.options.map((option) => option.key), [schema]);

  const preview = useMemo((): { diff: ModifiedDiff; nextStyle: StyleName | null } | null => {
    if (validation.result === null) return null;
    return {
      diff: diffModified(modified, validation.result.modified, optionOrder),
      nextStyle: validation.result.style,
    };
  }, [validation.result, modified, optionOrder]);

  if (!open) return null;

  const styleChanged = preview !== null && preview.nextStyle !== null && preview.nextStyle !== style;
  const hasKeyChanges =
    preview !== null &&
    (preview.diff.added.length > 0 || preview.diff.removed.length > 0 || preview.diff.changed.length > 0);

  const modeClass = (which: ExportMode): string =>
    mode === which ? `${styles.mode ?? ""} ${styles.modeActive ?? ""}` : (styles.mode ?? "");

  return (
    <div
      className={styles.overlay}
      onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="config-drawer-title"
        aria-describedby="config-drawer-subtitle"
        data-testid="config-drawer"
      >
        <header className={styles.header}>
          <div>
            <h2 className={styles.title} id="config-drawer-title">
              Configuration
            </h2>
            <p className={styles.subtitle} id="config-drawer-subtitle">
              Edit the <code>.clang-format</code> YAML directly, then apply it to the options panel.
            </p>
          </div>
          <button
            type="button"
            className={styles.close}
            aria-label="Close configuration drawer"
            data-testid="config-close"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className={styles.body}>
          <fieldset className={styles.modes}>
            <legend className={styles.modesLegend}>Export mode</legend>
            <label className={modeClass("minimal")}>
              <input
                type="radio"
                name="config-drawer-mode"
                value="minimal"
                data-testid="config-mode-minimal"
                checked={mode === "minimal"}
                onChange={() => changeMode("minimal")}
              />
              <span>Minimal</span>
              <span className={styles.modeHint}>only the options you changed</span>
            </label>
            <label className={modeClass("full")}>
              <input
                type="radio"
                name="config-drawer-mode"
                value="full"
                data-testid="config-mode-full"
                checked={mode === "full"}
                onChange={() => changeMode("full")}
              />
              <span>Full</span>
              <span className={styles.modeHint}>every option with a value</span>
            </label>
          </fieldset>

          <div className={styles.editorWrap}>
            <CodeEditor
              value={text}
              onChange={setText}
              language="yaml"
              ariaLabel="Configuration YAML"
              testId="config-yaml"
              className={styles.editor}
            />
          </div>

          <div className={styles.validation}>
            {validation.error !== null ? (
              <div className={styles.error} role="alert" data-testid="config-errors">
                <strong>{validation.error.message}</strong>
                {validation.error.detail !== "" && (
                  <pre className={styles.errorDetail} tabIndex={0}>
                    {validation.error.detail}
                  </pre>
                )}
              </div>
            ) : validation.warnings.length > 0 ? (
              <ul className={styles.warnings} data-testid="config-warnings" tabIndex={0}>
                {validation.warnings.map((warning, index) => (
                  <li className={styles.warning} key={`${warning.path}:${warning.message}:${index}`}>
                    {warning.path !== "" && <code className={styles.warningPath}>{warning.path}</code>}
                    <span>{warning.message}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.validHint} data-testid="config-valid">
                {text.trim() === ""
                  ? "Empty document — applying it clears all modified options."
                  : "Configuration is valid."}
              </p>
            )}
            {/* Warnings are announced politely; "Configuration is valid." is not,
                so a SR user is not read a status line after every typing pause. */}
            <span className={styles.srOnly} role="status" aria-atomic="true">
              {validation.error === null && validation.warnings.length > 0
                ? `${validation.warnings.length} warning${validation.warnings.length === 1 ? "" : "s"}: ${validation.warnings
                    .map((warning) => (warning.path !== "" ? `${warning.path}: ${warning.message}` : warning.message))
                    .join("; ")}`
                : ""}
            </span>
          </div>

          <section className={styles.preview} data-testid="config-preview" aria-label="Preview of changes">
            <h3 className={styles.previewTitle}>Preview</h3>
            {preview === null ? (
              <p className={styles.previewEmpty}>Preview unavailable while the YAML has errors.</p>
            ) : (
              <>
                <p className={styles.previewHint}>Relative to the current configuration.</p>
                {styleChanged && (
                  <p className={styles.styleChange} data-testid="config-style-change">
                    BasedOnStyle: <code>{style}</code> → <code>{preview.nextStyle}</code>
                  </p>
                )}
                {!styleChanged && !hasKeyChanges && (
                  <p className={styles.previewEmpty}>No changes.</p>
                )}
                {preview.diff.added.length > 0 && (
                  <div className={styles.previewGroup}>
                    <span className={styles.previewLabel}>Added</span>
                    <ul className={styles.previewKeys}>
                      {preview.diff.added.map((key) => (
                        <li key={key}>
                          <code className={styles.previewKey}>{key}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {preview.diff.removed.length > 0 && (
                  <div className={styles.previewGroup}>
                    <span className={styles.previewLabel}>Removed</span>
                    <ul className={styles.previewKeys}>
                      {preview.diff.removed.map((key) => (
                        <li key={key}>
                          <code className={styles.previewKey}>{key}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {preview.diff.changed.length > 0 && (
                  <div className={styles.previewGroup}>
                    <span className={styles.previewLabel}>Changed</span>
                    <ul className={styles.previewKeys}>
                      {preview.diff.changed.map((key) => (
                        <li key={key}>
                          <code className={styles.previewKey}>{key}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </section>
        </div>

        <footer className={styles.footer}>
          <div className={styles.fileRow}>
            <label className={styles.fileLabel} htmlFor="config-drawer-file">
              Load from file
            </label>
            <input
              ref={fileInputRef}
              id="config-drawer-file"
              type="file"
              className={styles.fileInput}
              data-testid="config-file"
              accept=".clang-format,.yaml,.yml,text/plain,text/yaml,application/x-yaml"
              onChange={readFile}
            />
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.button} data-testid="config-download" onClick={download}>
              Download
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              data-testid="config-apply"
              onClick={apply}
            >
              Apply
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Named export as well, so the drawer can be wired as a named or default import. */
export { ConfigDrawer };

function safeSerialize(schema: SchemaCore, style: StyleName, modified: Modified, mode: ExportMode): string {
  try {
    return serializeConfig(schema, style, modified, mode);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return `# failed to serialize the configuration: ${message}\n`;
  }
}

function validateText(text: string, schema: SchemaCore): ValidationState {
  try {
    const result = parseConfigText(text, schema);
    return { text, error: null, warnings: result.warnings, result };
  } catch (cause) {
    return { text, error: toFailure(cause), warnings: [], result: null };
  }
}

function toFailure(cause: unknown): ImportFailure {
  if (cause instanceof ImportError) return { message: cause.message, detail: cause.detail };
  return {
    message: "Could not parse the configuration",
    detail: cause instanceof Error ? cause.message : String(cause),
  };
}
