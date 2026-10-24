// Import / Export dialog (plan §5, contract §5.1). The dialog is controlled by
// App: `open` decides whether it renders and `tab` picks the initial tab. On a
// successful import it hands the parsed result to App, which owns applying it,
// closing the dialog and displaying warnings.

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
import {
  CONFIG_FILENAME,
  ImportError,
  parseConfigText,
  serializeConfig,
  type ExportMode,
  type ImportResult,
} from "../lib/config-io";
import type { SchemaCore, StyleName } from "../lib/schema";
import styles from "./ConfigDialog.module.css";

export type ConfigDialogProps = {
  open: boolean;
  tab: "import" | "export";
  schema: SchemaCore;
  style: StyleName;
  modified: Modified;
  onClose: () => void;
  onImport: (result: ImportResult) => void;
};

type DialogTab = "import" | "export";
type ImportFailure = { message: string; detail: string };

const FOCUSABLE_SELECTOR =
  "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

const COPIED_FEEDBACK_MS = 1600;

export default function ConfigDialog(props: ConfigDialogProps): JSX.Element | null {
  const { open, tab, schema, style, modified, onClose, onImport } = props;

  const [activeTab, setActiveTab] = useState<DialogTab>(tab);
  const [mode, setMode] = useState<ExportMode>("minimal");
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<ImportFailure | null>(null);
  const [copied, setCopied] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const yamlRef = useRef<HTMLTextAreaElement>(null);
  const copyTimerRef = useRef<number | null>(null);

  // Each open starts on the tab App asked for, with a clean import form.
  useEffect(() => {
    if (!open) return;
    setActiveTab(tab);
    setImportText("");
    setImportError(null);
  }, [open, tab]);

  // Initial focus moves into the modal; closing returns it to the trigger.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstFocusable = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();
    return () => previous?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);

  const yamlText = useMemo(() => {
    try {
      return serializeConfig(schema, style, modified, mode);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return `# failed to serialize the configuration: ${message}\n`;
    }
  }, [schema, style, modified, mode]);

  const copyYaml = useCallback(async (): Promise<void> => {
    let written = false;
    try {
      await navigator.clipboard.writeText(yamlText);
      written = true;
    } catch {
      // Fallback for browsers/contexts without the async clipboard API.
      const area = yamlRef.current;
      if (area !== null) {
        area.focus();
        area.select();
        try {
          written = document.execCommand("copy");
        } catch {
          written = false;
        }
      }
    }
    if (!written) return;
    setCopied(true);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  }, [yamlText]);

  const downloadYaml = useCallback((): void => {
    const blob = new Blob([yamlText], { type: "text/yaml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = CONFIG_FILENAME;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [yamlText]);

  const readFile = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (file === undefined) return;
    void file
      .text()
      .then((text) => {
        setImportText(text);
        setImportError(null);
      })
      .catch((cause: unknown) => {
        setImportError({
          message: "Could not read the selected file",
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      })
      .finally(() => {
        // Allow selecting the same file again after a failure.
        input.value = "";
      });
  }, []);

  const applyImport = useCallback((): void => {
    try {
      const result = parseConfigText(importText, schema);
      setImportError(null);
      onImport(result);
    } catch (cause) {
      if (cause instanceof ImportError) {
        setImportError({ message: cause.message, detail: cause.detail });
      } else {
        setImportError({
          message: "Could not parse the configuration",
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }, [importText, schema, onImport]);

  if (!open) return null;

  const tabClass = (which: DialogTab): string =>
    activeTab === which ? `${styles.tab} ${styles.tabActive}` : (styles.tab ?? "");

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
        aria-labelledby="config-dialog-title"
        data-testid="config-dialog"
      >
        <header className={styles.header}>
          <h2 className={styles.title} id="config-dialog-title">
            Configuration
          </h2>
          <button
            type="button"
            className={styles.close}
            aria-label="Close dialog"
            data-testid="dialog-close"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className={styles.tabs} role="tablist" aria-label="Import or export configuration">
          <button
            type="button"
            role="tab"
            id="config-dialog-tab-import"
            aria-selected={activeTab === "import"}
            aria-controls={activeTab === "import" ? "config-dialog-panel-import" : undefined}
            data-testid="tab-import"
            className={tabClass("import")}
            onClick={() => setActiveTab("import")}
          >
            Import
          </button>
          <button
            type="button"
            role="tab"
            id="config-dialog-tab-export"
            aria-selected={activeTab === "export"}
            aria-controls={activeTab === "export" ? "config-dialog-panel-export" : undefined}
            data-testid="tab-export"
            className={tabClass("export")}
            onClick={() => setActiveTab("export")}
          >
            Export
          </button>
        </div>

        {activeTab === "export" ? (
          <div
            className={styles.body}
            role="tabpanel"
            id="config-dialog-panel-export"
            aria-labelledby="config-dialog-tab-export"
          >
            <fieldset className={styles.modes}>
              <legend className={styles.modesLegend}>Export mode</legend>
              <label className={styles.mode}>
                <input
                  type="radio"
                  name="export-mode"
                  value="minimal"
                  data-testid="export-mode-minimal"
                  checked={mode === "minimal"}
                  onChange={() => setMode("minimal")}
                />
                <span>Minimal</span>
                <span className={styles.modeHint}>only the options you changed</span>
              </label>
              <label className={styles.mode}>
                <input
                  type="radio"
                  name="export-mode"
                  value="full"
                  data-testid="export-mode-full"
                  checked={mode === "full"}
                  onChange={() => setMode("full")}
                />
                <span>Full</span>
                <span className={styles.modeHint}>every option with a value</span>
              </label>
            </fieldset>

            <textarea
              ref={yamlRef}
              className={styles.yaml}
              data-testid="config-yaml"
              aria-label="Exported configuration YAML"
              value={yamlText}
              readOnly
              spellCheck={false}
            />

            <div className={styles.actions}>
              <span className={styles.hint} aria-live="polite">
                {copied ? "Copied to clipboard" : ""}
              </span>
              <button type="button" className={styles.button} data-testid="copy-config" onClick={() => void copyYaml()}>
                {copied ? "Copied" : "Copy"}
              </button>
              <button type="button" className={styles.button} data-testid="download-config" onClick={downloadYaml}>
                Download
              </button>
            </div>
          </div>
        ) : (
          <div
            className={styles.body}
            role="tabpanel"
            id="config-dialog-panel-import"
            aria-labelledby="config-dialog-tab-import"
          >
            <div className={styles.fileRow}>
              <label className={styles.fileLabel} htmlFor="config-dialog-file">
                Load from file
              </label>
              <input
                id="config-dialog-file"
                type="file"
                className={styles.fileInput}
                data-testid="import-file"
                accept=".clang-format,text/plain,text/yaml,application/x-yaml"
                onChange={readFile}
              />
            </div>

            <textarea
              className={styles.yaml}
              data-testid="import-text"
              aria-label="Configuration YAML"
              value={importText}
              placeholder={"BasedOnStyle: LLVM\nIndentWidth: 4"}
              spellCheck={false}
              onChange={(event) => {
                setImportText(event.target.value);
                setImportError(null);
              }}
            />

            {importError !== null && (
              <div className={styles.error} data-testid="import-error" role="alert">
                <strong>{importError.message}</strong>
                {importError.detail !== "" && (
                  <pre className={styles.errorDetail} tabIndex={0}>
                    {importError.detail}
                  </pre>
                )}
              </div>
            )}

            <div className={styles.actions}>
              <span className={styles.hint}>Paste a .clang-format file, or load one above.</span>
              <button
                type="button"
                className={`${styles.button} ${styles.primary}`}
                data-testid="import-apply"
                onClick={applyImport}
              >
                Apply
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
