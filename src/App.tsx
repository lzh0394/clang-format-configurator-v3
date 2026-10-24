import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import ConfigDialog from "./components/ConfigDialog";
import ConfigDrawer from "./components/ConfigDrawer";
import ErrorPanel from "./components/ErrorPanel";
import OptionPanel from "./components/OptionPanel";
import { configReducer, initialConfigState, reconcileModified } from "./lib/config-state";
import type { Modified } from "./lib/config";
import type { ImportResult } from "./lib/config-io";
import { FormatterClient, FormatterSupersededError, type FormatterError } from "./lib/formatter-client";
import {
  buildStylePayload,
  loadVersionIndex,
  type OptionDef,
  type SchemaCore,
  type StyleName,
  type VersionInfo,
} from "./lib/schema";
import { schemaStore } from "./lib/schema-store";
import { CodeEditor } from "./editor/CodeEditor";
import { LANGUAGE_LABELS, languageForFilename } from "./editor/languages";
import styles from "./App.module.css";

// The merge view is only needed when the user asks for a diff, so it is split
// out of the first-load chunk (plan §2.1: merge view is a lazy-load valve).
const DiffPane = lazy(() => import("./components/DiffPane").then((module) => ({ default: module.DiffPane })));

const SAMPLE = `#include <iostream>
#include <vector>

class Widget{public:
Widget(int id):id_(id){}
int id()const{return id_;}
void print()const{std::cout<<id_<<std::endl;}
private:
int id_;
};

int main(){std::vector<Widget> ws;ws.emplace_back(1);for(const auto&w:ws){w.print();}return 0;}
`;

type ErrorState = { message: string; detail: string };
type Notice = { title: string; items: string[] };
type DialogState = { open: boolean; tab: "import" | "export" };

/** Above this size the UI asks for confirmation before formatting (plan §7). */
const LARGE_INPUT_LIMIT = 2 * 1024 * 1024;
/** Input debounce (plan §6: 250 ms instead of one request per keystroke). */
const DEBOUNCE_MS = 250;
const EDITOR_FONT_SIZES = [12, 13, 14, 16, 18, 20] as const;

export default function App() {
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [version, setVersion] = useState("");
  const [schema, setSchema] = useState<SchemaCore | null>(null);
  const [config, dispatch] = useReducer(configReducer, initialConfigState(""));
  const [filename, setFilename] = useState("main.cc");
  const [code, setCode] = useState(SAMPLE);
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorState | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ open: false, tab: "export" });
  const [status, setStatus] = useState("loading…");
  const [timing, setTiming] = useState<number | null>(null);
  const [auto, setAuto] = useState(true);
  const [editorFontSize, setEditorFontSize] = useState<number>(13);
  const [largeInputPending, setLargeInputPending] = useState(false);
  const [diff, setDiff] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [crash, setCrash] = useState<FormatterError | null>(null);

  const clientRef = useRef<FormatterClient | null>(null);
  const readyRef = useRef(false);
  const runRef = useRef(0);
  const largeAcceptedRef = useRef(false);
  const recoveryAttemptsRef = useRef(0);
  const inputRef = useRef<{ code: string; filename: string; style: StyleName; modified: Modified }>({
    code,
    filename,
    style: config.style,
    modified: config.modified,
  });
  inputRef.current = { code, filename, style: config.style, modified: config.modified };

  const configRef = useRef(config);
  configRef.current = config;

  // Version list comes from the generated schema index, so shipping a new
  // version never requires touching app code.
  useEffect(() => {
    let cancelled = false;
    loadVersionIndex()
      .then((index) => {
        if (cancelled) return;
        const first = index.versions[0];
        if (!first) throw new Error("no schema found — run `npm run prepare:assets` first");
        setVersions(index.versions);
        setVersion(index.default ?? first.version);
      })
      .catch((cause: Error) => {
        if (cancelled) return;
        setStatus("failed");
        setError({ message: cause.message, detail: "" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Lazily create the formatter facade and listen for fatal worker failures. */
  const getClient = useCallback((): FormatterClient => {
    let client = clientRef.current;
    if (client === null) {
      client = new FormatterClient();
      client.onFatal = (failure) => setCrash(failure);
      clientRef.current = client;
    }
    return client;
  }, []);

  const runFormat = useCallback(async (options?: { force?: boolean }) => {
    const client = clientRef.current;
    if (!client) return;
    const { code: source, style: preset, filename: name, modified } = inputRef.current;

    // plan §7: oversized inputs need an explicit confirmation before the
    // worker runs a potentially long synchronous format.
    if (source.length > LARGE_INPUT_LIMIT && !largeAcceptedRef.current && options?.force !== true) {
      setLargeInputPending(true);
      return;
    }
    setLargeInputPending(false);

    const run = ++runRef.current;
    setBusy(true);
    try {
      const result = await client.format(source, name, buildStylePayload(preset, modified));
      if (run !== runRef.current) return;
      setOutput(result.code);
      setTiming(result.ms);
      setError(null);
      recoveryAttemptsRef.current = 0;
      setCrash(null);
    } catch (cause) {
      if (run !== runRef.current) return;
      // A newer keystroke replaced this request: not a user-visible failure.
      if (cause instanceof FormatterSupersededError) return;
      const failure = cause as FormatterError;
      if (failure.kind === "fatal") {
        // The client reported it through onFatal; the crash banner owns it.
        setCrash(failure);
        return;
      }
      setError({ message: failure.message, detail: failure.detail ?? "" });
    } finally {
      if (run === runRef.current) setBusy(false);
    }
  }, []);

  // One wasm instance per version: switching versions replaces the worker.
  // Options that the new schema does not know are filtered before formatting,
  // so a stale `modified` value can never reach clang-format as an unknown key.
  useEffect(() => {
    if (!version) return;
    let cancelled = false;
    const client = getClient();
    readyRef.current = false;
    recoveryAttemptsRef.current = 0;
    setCrash(null);
    setStatus(`loading clang-format ${version}…`);
    setError(null);
    setSchema(null);

    (async () => {
      const nextSchema = await schemaStore.schema(version);
      await client.init(version);
      if (cancelled) return;
      const { modified } = reconcileModified(configRef.current.modified, nextSchema);
      inputRef.current = { ...inputRef.current, modified };
      setSchema(nextSchema);
      dispatch({ type: "setVersion", version, schema: nextSchema });
      setStatus(`clang-format ${version} ready`);
      readyRef.current = true;
      void runFormat();
    })().catch((cause: Error) => {
      if (cancelled) return;
      setStatus("failed");
      const failure = cause as FormatterError;
      if (failure.kind === "fatal") {
        setCrash(failure);
        return;
      }
      setError({ message: failure.message, detail: failure.detail ?? "" });
    });

    return () => {
      cancelled = true;
    };
  }, [version, runFormat, getClient]);

  /** Rebuild the worker after a fatal failure and format the current document. */
  const recoverFormatter = useCallback(async () => {
    if (!version) return;
    const client = getClient();
    try {
      setStatus(`loading clang-format ${version}…`);
      const nextSchema = await schemaStore.schema(version);
      await client.init(version);
      setSchema(nextSchema);
      setCrash(null);
      setError(null);
      setStatus(`clang-format ${version} ready`);
      readyRef.current = true;
      void runFormat();
    } catch (cause) {
      const failure = cause as FormatterError;
      setStatus("failed");
      setCrash(failure);
    }
  }, [version, getClient, runFormat]);

  // Auto-recover once per crash; repeated failures leave the banner with its
  // manual "Restart formatter" action instead of looping.
  useEffect(() => {
    if (crash === null) return;
    if (recoveryAttemptsRef.current >= 1) return;
    recoveryAttemptsRef.current += 1;
    void recoverFormatter();
  }, [crash, recoverFormatter]);

  const retryFormatter = useCallback(() => {
    recoveryAttemptsRef.current = 0;
    setCrash(null);
    void recoverFormatter();
  }, [recoverFormatter]);

  useEffect(() => {
    if (!auto || !readyRef.current) return;
    const timer = setTimeout(() => void runFormat(), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [code, config.style, config.modified, config.version, filename, auto, runFormat]);

  // Oversized-input confirmation only applies to the current document.
  useEffect(() => {
    if (code.length > LARGE_INPUT_LIMIT) return;
    largeAcceptedRef.current = false;
    setLargeInputPending(false);
  }, [code]);

  // Ctrl/Cmd+Enter from anywhere in the page (the editors also bind it, in
  // which case the CodeMirror keymap has already handled the event).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter") return;
      event.preventDefault();
      void runFormat();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [runFormat]);

  useEffect(() => () => clientRef.current?.dispose(), []);

  const handleOptionChange = useCallback((key: string, value: unknown) => {
    dispatch({ type: "setOption", key, value });
  }, []);

  const handleChildChange = useCallback((option: OptionDef, childKey: string, value: unknown) => {
    dispatch({ type: "setChild", option, childKey, value });
  }, []);

  const handleResetAll = useCallback(() => {
    dispatch({ type: "resetAll" });
  }, []);

  const applyImportResult = useCallback((result: ImportResult) => {
    dispatch({ type: "applyImport", style: result.style, modified: result.modified });
    if (result.warnings.length > 0) {
      setNotice({
        title: `Imported with ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`,
        items: result.warnings.map((warning) =>
          warning.path ? `${warning.path}: ${warning.message}` : warning.message,
        ),
      });
    } else {
      setNotice(null);
    }
  }, []);

  const handleImport = useCallback(
    (result: ImportResult) => {
      applyImportResult(result);
      setDialog((current) => ({ ...current, open: false }));
    },
    [applyImportResult],
  );

  const handleDrawerApply = useCallback(
    (result: ImportResult) => {
      applyImportResult(result);
      setConfigOpen(false);
    },
    [applyImportResult],
  );

  const openDialog = useCallback((tab: "import" | "export") => {
    setDialog({ open: true, tab });
  }, []);

  const closeDialog = useCallback(() => {
    setDialog((current) => ({ ...current, open: false }));
  }, []);

  const optionCount = schema?.options.length ?? 0;
  const modifiedCount = Object.keys(config.modified).length;
  const disabled = !schema;
  const language = languageForFilename(filename);
  const appStyle = { "--font-size-editor": `${editorFontSize}px` } as CSSProperties;

  return (
    <div className={styles.app} style={appStyle}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden="true">
            {"{}"}
          </span>
          <h1>clang-format configurator</h1>
        </div>

        <div className={styles.controls}>
          <label className={styles.field}>
            <span>Version</span>
            <select
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              disabled={versions.length === 0}
              aria-label="Version"
            >
              {versions.map((entry) => (
                <option key={entry.version} value={entry.version}>
                  {entry.version}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span>Style</span>
            <select
              value={config.style}
              onChange={(event) => dispatch({ type: "setStyle", style: event.target.value as StyleName })}
              disabled={!schema}
              aria-label="Style"
            >
              {(schema?.styles ?? []).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span>Filename</span>
            <input
              value={filename}
              onChange={(event) => setFilename(event.target.value)}
              spellCheck={false}
              size={12}
              aria-label="Filename"
            />
          </label>

          <button type="button" className={styles.primary} onClick={() => void runFormat()} disabled={disabled}>
            Format
          </button>

          <button
            type="button"
            className={styles.secondary}
            onClick={() => openDialog("import")}
            disabled={disabled}
            data-testid="open-import"
          >
            Import
          </button>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => openDialog("export")}
            disabled={disabled}
            data-testid="open-export"
          >
            Export
          </button>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => setConfigOpen(true)}
            disabled={disabled}
            data-testid="open-config"
          >
            Config
          </button>

          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={diff}
              onChange={(event) => setDiff(event.target.checked)}
              data-testid="diff-toggle"
            />
            <span>Diff</span>
          </label>

          <label className={styles.checkbox}>
            <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} />
            <span>Auto</span>
          </label>

          <label className={styles.field}>
            <span>Font</span>
            <select
              value={editorFontSize}
              onChange={(event) => setEditorFontSize(Number(event.target.value))}
              aria-label="Editor font size"
              data-testid="editor-font-size"
            >
              {EDITOR_FONT_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}px
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {notice && (
        <div className={styles.notice} role="status" data-testid="notice">
          <div className={styles.noticeBody}>
            <strong>{notice.title}</strong>
            <ul>
              {notice.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <button
            type="button"
            className={styles.noticeClose}
            onClick={() => setNotice(null)}
            aria-label="Dismiss notice"
            data-testid="notice-close"
          >
            ×
          </button>
        </div>
      )}

      {largeInputPending && (
        <div className={styles.largeInput} role="alert" data-testid="large-input">
          <span>
            Source is {(code.length / (1024 * 1024)).toFixed(1)} MB — above the 2 MB limit. Formatting runs
            synchronously in the worker and may take a while.
          </span>
          <button
            type="button"
            className={styles.secondary}
            data-testid="format-anyway"
            onClick={() => {
              largeAcceptedRef.current = true;
              setLargeInputPending(false);
              void runFormat({ force: true });
            }}
          >
            Format anyway
          </button>
        </div>
      )}

      {error && (
        <ErrorPanel message={error.message} detail={error.detail} onDismiss={() => setError(null)} />
      )}

      {crash && (
        <div className={styles.error} role="alert" data-testid="worker-banner">
          <div className={styles.crashRow}>
            <strong>Formatter crashed: {crash.message}</strong>
            <button
              type="button"
              className={styles.secondary}
              data-testid="worker-retry"
              onClick={retryFormatter}
            >
              Restart formatter
            </button>
          </div>
          {crash.detail !== "" && <pre>{crash.detail}</pre>}
        </div>
      )}

      <main className={styles.main}>
        {schema ? (
          <OptionPanel
            schema={schema}
            style={config.style}
            modified={config.modified}
            onOptionChange={handleOptionChange}
            onChildChange={handleChildChange}
            onResetAll={handleResetAll}
          />
        ) : (
          <aside className={styles.panelPlaceholder} aria-hidden="true">
            loading options…
          </aside>
        )}

        <div className={styles.workbench}>
          {diff ? (
            <Suspense fallback={<div className={styles.panelPlaceholder}>loading diff…</div>}>
              <DiffPane
                code={code}
                output={output}
                language={language}
                onChange={setCode}
                onSubmit={() => void runFormat()}
              />
            </Suspense>
          ) : (
            <div className={styles.panes}>
              <section className={styles.pane}>
                <div className={styles.paneHead}>
                  <h2>Source</h2>
                  <span className={styles.hint} data-testid="language">
                    {LANGUAGE_LABELS[language]}
                  </span>
                </div>
                <CodeEditor
                  className={styles.editorHost}
                  value={code}
                  onChange={setCode}
                  language={language}
                  ariaLabel="Source code"
                  testId="source"
                  onSubmit={() => void runFormat()}
                />
              </section>

              <section className={styles.pane}>
                <div className={styles.paneHead}>
                  <h2>Formatted</h2>
                  <span className={styles.hint}>
                    {busy ? "formatting…" : timing !== null ? `${timing.toFixed(1)} ms` : ""}
                  </span>
                </div>
                <CodeEditor
                  className={styles.editorHost}
                  value={output}
                  language={language}
                  readOnly
                  ariaLabel="Formatted output"
                  testId="output"
                  placeholder="formatted output appears here…"
                />
              </section>
            </div>
          )}
        </div>
      </main>

      <footer className={styles.status} data-testid="status">
        <span title={schema?.build}>{status}</span>
        <span className={styles.dot} aria-hidden="true">
          ·
        </span>
        <span>{optionCount} options</span>
        <span className={styles.dot} aria-hidden="true">
          ·
        </span>
        <span data-testid="modified-count">{modifiedCount} modified</span>
        <span className={styles.dot} aria-hidden="true">
          ·
        </span>
        <span>{output.split("\n").length} lines out</span>
      </footer>

      {schema && (
        <ConfigDialog
          open={dialog.open}
          tab={dialog.tab}
          schema={schema}
          style={config.style}
          modified={config.modified}
          onClose={closeDialog}
          onImport={handleImport}
        />
      )}

      {schema && (
        <ConfigDrawer
          open={configOpen}
          schema={schema}
          style={config.style}
          modified={config.modified}
          onClose={() => setConfigOpen(false)}
          onApply={handleDrawerApply}
        />
      )}
    </div>
  );
}
