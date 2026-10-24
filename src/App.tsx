import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import ConfigDialog from "./components/ConfigDialog";
import ConfigDrawer from "./components/ConfigDrawer";
import ErrorPanel from "./components/ErrorPanel";
import OptionPanel from "./components/OptionPanel";
import SettingsMenu from "./components/SettingsMenu";
import { configReducer, initialConfigState, reconcileModified } from "./lib/config-state";
import type { Modified } from "./lib/config";
import type { ImportResult } from "./lib/config-io";
import { FormatterClient, FormatterSupersededError, type FormatterError } from "./lib/formatter-client";
import {
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_THEME,
  STATE_VERSION,
  loadPersistedState,
  savePersistedState,
} from "./lib/persisted-state";
import { registerServiceWorker, type ServiceWorkerHandle } from "./lib/service-worker";
import { applyTheme, type ThemePreference } from "./lib/theme";
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
/** Persist the session a little after the last edit. */
const PERSIST_DEBOUNCE_MS = 400;

export default function App() {
  // Restore once, synchronously, so the first render already shows the saved
  // session (plan §5 持久化). Invalid/incompatible documents are reported once.
  const [restored] = useState(() => loadPersistedState());
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [version, setVersion] = useState("");
  const [schema, setSchema] = useState<SchemaCore | null>(null);
  const [config, dispatch] = useReducer(
    configReducer,
    restored.state
      ? { version: restored.state.version, style: restored.state.style, modified: restored.state.modified }
      : initialConfigState(""),
  );
  const [filename, setFilename] = useState("main.cc");
  const [code, setCode] = useState(() => restored.state?.code ?? SAMPLE);
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorState | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ open: false, tab: "export" });
  const [status, setStatus] = useState("loading…");
  const [timing, setTiming] = useState<number | null>(null);
  const [auto, setAuto] = useState(true);
  const [theme, setTheme] = useState<ThemePreference>(restored.state?.theme ?? DEFAULT_THEME);
  const [editorFontSize, setEditorFontSize] = useState<number>(
    restored.state?.editorFontSize ?? DEFAULT_EDITOR_FONT_SIZE,
  );
  const [largeInputPending, setLargeInputPending] = useState(false);
  const [diff, setDiff] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [crash, setCrash] = useState<FormatterError | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [mobilePane, setMobilePane] = useState<"options" | "code">("code");
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && navigator.onLine === false);
  const [updateReady, setUpdateReady] = useState(false);
  const [persistProblem, setPersistProblem] = useState<"quota" | "unavailable" | null>(null);

  const clientRef = useRef<FormatterClient | null>(null);
  const readyRef = useRef(false);
  const runRef = useRef(0);
  const largeAcceptedRef = useRef(false);
  const recoveryAttemptsRef = useRef(0);
  const swRef = useRef<ServiceWorkerHandle | null>(null);
  const persistProblemRef = useRef<"quota" | "unavailable" | null>(null);
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
        // Prefer the persisted version when it is still shipped (plan §5).
        const saved = restored.state?.version;
        const known = saved !== undefined && index.versions.some((entry) => entry.version === saved);
        setVersion(known && saved !== undefined ? saved : (index.default ?? first.version));
      })
      .catch((cause: Error) => {
        if (cancelled) return;
        setStatus("failed");
        setError({ message: cause.message, detail: "" });
      });
    return () => {
      cancelled = true;
    };
  }, [restored]);

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
      const { modified, dropped } = reconcileModified(configRef.current.modified, nextSchema);
      inputRef.current = { ...inputRef.current, modified };
      setSchema(nextSchema);
      dispatch({ type: "setVersion", version, schema: nextSchema });
      if (dropped.length > 0) {
        setNotice({
          title: `Dropped ${dropped.length} saved option${dropped.length === 1 ? "" : "s"}`,
          items: dropped
            .slice(0, 12)
            .map((key) => `${key} is not available in clang-format ${nextSchema.version}`),
        });
      }
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

  // plan §5: below 768 px the two columns become "Options / Code" tabs. The
  // media query state only drives which panel is mounted; CSS handles layout.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 768px)");
    const update = (): void => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // Report a discarded saved session once (plan §5: incompatible → drop + tell).
  useEffect(() => {
    if (restored.problem !== "version-mismatch" && restored.problem !== "corrupt") return;
    setNotice({
      title: "Saved session was discarded",
      items: [
        restored.problem === "version-mismatch"
          ? "The stored session was written by an incompatible build and cannot be restored."
          : "The stored session could not be read and cannot be restored.",
      ],
    });
  }, [restored]);

  // Theme: explicit light/dark wins, "system" follows the OS via CSS (plan §5).
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Offline support: the service worker is production-only and optional.
  useEffect(() => {
    let cancelled = false;
    let handle: ServiceWorkerHandle | null = null;
    void registerServiceWorker({
      onUpdateReady: () => setUpdateReady(true),
      onOfflineChange: (next) => setOffline(next),
    }).then((registered) => {
      if (cancelled) {
        registered?.dispose();
        return;
      }
      handle = registered;
      swRef.current = registered;
    });
    return () => {
      cancelled = true;
      handle?.dispose();
      swRef.current = null;
    };
  }, []);

  const applyServiceWorkerUpdate = useCallback(() => {
    swRef.current?.applyUpdate();
    setUpdateReady(false);
  }, []);

  // Persist the session shortly after the last edit; `pagehide` flushes the
  // final keystrokes so closing a tab does not lose them (plan §5 持久化).
  const persistSession = useCallback(() => {
    if (!version) return;
    const result = savePersistedState({
      stateVersion: STATE_VERSION,
      version,
      style: config.style,
      modified: config.modified,
      code,
      theme,
      editorFontSize,
    });
    if (result === "ok") {
      persistProblemRef.current = null;
      return;
    }
    // Report a storage problem once per page load; a broken storage backend
    // must not keep interrupting the user.
    if (persistProblemRef.current === null) {
      persistProblemRef.current = result;
      setPersistProblem(result);
    }
  }, [version, config.style, config.modified, code, theme, editorFontSize]);

  useEffect(() => {
    if (!version) return;
    const timer = window.setTimeout(persistSession, PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [persistSession, version]);

  // Flush on pagehide/unmount only: a ref keeps the listener stable so typing
  // does not trigger a synchronous localStorage write on every keystroke.
  const persistRef = useRef(persistSession);
  persistRef.current = persistSession;

  useEffect(() => {
    const flush = (): void => persistRef.current();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

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
      <a className={styles.skipLink} href="#main">
        Skip to content
      </a>
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

          <SettingsMenu
            theme={theme}
            onThemeChange={setTheme}
            editorFontSize={editorFontSize}
            onFontSizeChange={setEditorFontSize}
          />
        </div>
      </header>

      {isMobile && (
        <nav className={styles.mobileTabs} role="tablist" aria-label="Panels">
          <button
            type="button"
            role="tab"
            id="tab-options"
            aria-selected={mobilePane === "options"}
            aria-controls="panel-options"
            className={mobilePane === "options" ? styles.mobileTabActive : styles.mobileTab}
            data-testid="tab-options"
            onClick={() => setMobilePane("options")}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                event.preventDefault();
                setMobilePane("code");
                document.getElementById("tab-code")?.focus();
              }
            }}
          >
            Options
          </button>
          <button
            type="button"
            role="tab"
            id="tab-code"
            aria-selected={mobilePane === "code"}
            aria-controls="panel-code"
            className={mobilePane === "code" ? styles.mobileTabActive : styles.mobileTab}
            data-testid="tab-code"
            onClick={() => setMobilePane("code")}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                event.preventDefault();
                setMobilePane("options");
                document.getElementById("tab-options")?.focus();
              }
            }}
          >
            Code
          </button>
        </nav>
      )}

      {notice && (
        <div className={styles.notice} role="status" data-testid="notice">
          <div className={styles.noticeBody}>
            <strong>{notice.title}</strong>
            <ul tabIndex={0}>
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

      {updateReady && (
        <div className={styles.notice} role="status" data-testid="update-banner">
          <div className={styles.noticeBody}>
            <strong>A new version is available</strong>
            <span>Reload to load the newest build. Your configuration is saved locally.</span>
          </div>
          <button
            type="button"
            className={styles.secondary}
            data-testid="update-reload"
            onClick={applyServiceWorkerUpdate}
          >
            Reload
          </button>
        </div>
      )}

      {offline && (
        <div className={styles.offlineBanner} role="status" data-testid="offline-banner">
          You are offline — the cached app and formatter still work; new versions need a connection.
        </div>
      )}

      {persistProblem !== null && (
        <div className={styles.offlineBanner} role="status" data-testid="persist-banner">
          {persistProblem === "quota"
            ? "Your session could not be saved: local storage is full."
            : "Your session could not be saved: local storage is unavailable."}
          <button
            type="button"
            className={styles.noticeClose}
            aria-label="Dismiss warning"
            data-testid="persist-dismiss"
            onClick={() => setPersistProblem(null)}
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
          {crash.detail !== "" && <pre tabIndex={0}>{crash.detail}</pre>}
        </div>
      )}

      <main
        id="main"
        className={`${styles.main} ${isMobile ? (mobilePane === "options" ? styles.mainOptions : styles.mainCode) : ""}`}
      >
        <div
          className={styles.optionsArea}
          id="panel-options"
          aria-label="Options"
          role={isMobile ? "tabpanel" : undefined}
          aria-labelledby={isMobile ? "tab-options" : undefined}
        >
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
        </div>

        <div
          className={styles.workbench}
          id="panel-code"
          role={isMobile ? "tabpanel" : undefined}
          aria-labelledby={isMobile ? "tab-code" : undefined}
        >
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

      <div className={styles.srOnly} role="status" aria-live="polite" data-testid="live-status">
        {error
          ? `Error: ${error.message}`
          : busy
            ? "Formatting"
            : timing !== null
              ? "Formatted output updated"
              : ""}
      </div>

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
