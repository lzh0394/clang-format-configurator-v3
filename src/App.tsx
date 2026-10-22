import { useCallback, useEffect, useRef, useState } from "react";
import { FormatterClient, type FormatterError } from "./lib/formatter-client";
import {
  buildStylePayload,
  loadSchema,
  loadVersionIndex,
  type SchemaCore,
  type StyleName,
  type VersionInfo,
} from "./lib/schema";
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

export default function App() {
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [version, setVersion] = useState("");
  const [schema, setSchema] = useState<SchemaCore | null>(null);
  const [style, setStyle] = useState<StyleName>("LLVM");
  const [filename, setFilename] = useState("main.cc");
  const [code, setCode] = useState(SAMPLE);
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorState | null>(null);
  const [status, setStatus] = useState("loading…");
  const [timing, setTiming] = useState<number | null>(null);
  const [auto, setAuto] = useState(true);

  const clientRef = useRef<FormatterClient | null>(null);
  const readyRef = useRef(false);
  const runRef = useRef(0);
  const inputRef = useRef({ code, style, filename });
  inputRef.current = { code, style, filename };

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
    const { code: source, style: preset, filename: name } = inputRef.current;
    setBusy(true);
    try {
      const result = await client.format(source, name, buildStylePayload(preset));
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
  useEffect(() => {
    if (!version) return;
    let cancelled = false;
    const client = (clientRef.current ??= new FormatterClient());
    readyRef.current = false;
    setStatus(`loading clang-format ${version}…`);
    setError(null);
    setSchema(null);

    (async () => {
      const nextSchema = await loadSchema(version);
      await client.init(version);
      if (cancelled) return;
      setSchema(nextSchema);
      setStatus(nextSchema.build);
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
  }, [code, style, filename, auto, runFormat]);

  useEffect(() => () => clientRef.current?.dispose(), []);

  const optionCount = schema?.options.length ?? 0;

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
              value={style}
              onChange={(event) => setStyle(event.target.value as StyleName)}
              disabled={!schema}
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
            />
          </label>

          <button
            type="button"
            className={styles.primary}
            onClick={() => void runFormat()}
            disabled={!schema}
          >
            Format
          </button>

          <label className={styles.checkbox}>
            <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} />
            <span>Auto</span>
          </label>
        </div>
      </header>

      {error && (
        <div className={styles.error} role="alert">
          <strong>{error.message}</strong>
          {error.detail && <pre>{error.detail}</pre>}
        </div>
      )}

      <main className={styles.panes}>
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
      </main>

      <footer className={styles.status} data-testid="status">
        <span>{status}</span>
        <span className={styles.dot} aria-hidden="true">
          ·
        </span>
        <span>{optionCount} options</span>
        <span className={styles.dot} aria-hidden="true">
          ·
        </span>
        <span>{output.split("\n").length} lines out</span>
      </footer>
    </div>
  );
}
