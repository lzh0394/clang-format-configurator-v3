import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import ConfigDialog from "./components/ConfigDialog";
import OptionPanel from "./components/OptionPanel";
import { configReducer, initialConfigState, reconcileModified } from "./lib/config-state";
import type { Modified } from "./lib/config";
import type { ImportResult } from "./lib/config-io";
import { FormatterClient, type FormatterError } from "./lib/formatter-client";
import {
  buildStylePayload,
  loadVersionIndex,
  type OptionDef,
  type SchemaCore,
  type StyleName,
  type VersionInfo,
} from "./lib/schema";
import { schemaStore } from "./lib/schema-store";
import styles from "./App.module.css";

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

  const clientRef = useRef<FormatterClient | null>(null);
  const readyRef = useRef(false);
  const runRef = useRef(0);
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

  const runFormat = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    const run = ++runRef.current;
    const { code: source, style: preset, filename: name, modified } = inputRef.current;
    setBusy(true);
    try {
      const result = await client.format(source, name, buildStylePayload(preset, modified));
      if (run !== runRef.current) return;
      setOutput(result.code);
      setTiming(result.ms);
      setError(null);
    } catch (cause) {
      if (run !== runRef.current) return;
      const failure = cause as FormatterError;
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
    const client = (clientRef.current ??= new FormatterClient());
    readyRef.current = false;
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
      setError({ message: failure.message, detail: failure.detail ?? "" });
    });

    return () => {
      cancelled = true;
    };
  }, [version, runFormat]);

  useEffect(() => {
    if (!auto || !readyRef.current) return;
    const timer = setTimeout(() => void runFormat(), 300);
    return () => clearTimeout(timer);
  }, [code, config.style, config.modified, config.version, filename, auto, runFormat]);

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

  const handleImport = useCallback((result: ImportResult) => {
    dispatch({ type: "applyImport", style: result.style, modified: result.modified });
    setDialog((current) => ({ ...current, open: false }));
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

  const openDialog = useCallback((tab: "import" | "export") => {
    setDialog({ open: true, tab });
  }, []);

  const closeDialog = useCallback(() => {
    setDialog((current) => ({ ...current, open: false }));
  }, []);

  const optionCount = schema?.options.length ?? 0;
  const modifiedCount = Object.keys(config.modified).length;
  const disabled = !schema;

  return (
    <div className={styles.app}>
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

          <label className={styles.checkbox}>
            <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} />
            <span>Auto</span>
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

      {error && (
        <div className={styles.error} role="alert">
          <strong>{error.message}</strong>
          {error.detail && <pre>{error.detail}</pre>}
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
          <div className={styles.panes}>
            <section className={styles.pane}>
              <div className={styles.paneHead}>
                <h2>Source</h2>
                <span className={styles.hint}>Ctrl/Cmd + Enter</span>
              </div>
              <textarea
                className={styles.editor}
                data-testid="source"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                    event.preventDefault();
                    void runFormat();
                  }
                }}
                spellCheck={false}
                aria-label="Source code"
              />
            </section>

            <section className={styles.pane}>
              <div className={styles.paneHead}>
                <h2>Formatted</h2>
                <span className={styles.hint}>
                  {busy ? "formatting…" : timing !== null ? `${timing.toFixed(1)} ms` : ""}
                </span>
              </div>
              <pre className={styles.output} data-testid="output" aria-live="polite" aria-busy={busy}>
                {output}
              </pre>
            </section>
          </div>
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
    </div>
  );
}
