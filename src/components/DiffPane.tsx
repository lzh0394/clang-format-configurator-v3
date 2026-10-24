// True split diff between the editable source and the read-only formatted
// result (plan §5 "编辑器与 diff", §6 "真实行级 diff").
//
// `@codemirror/merge`'s MergeView owns both editors: it computes changed
// chunks, aligns unchanged lines with spacers, highlights the changed lines and
// keeps the two sides scroll-synced (a single scroll container). React remains
// the single owner of the text: props are pushed into the documents, user edits
// on the left flow out through `onChange`, and programmatic dispatches are
// flagged so they are never echoed back. Unchanged stretches are collapsed to
// keep long files readable.

import { useEffect, useMemo, useRef, type JSX } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { MergeView } from "@codemirror/merge";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers } from "@codemirror/view";

import { loadLanguageSupport, type EditorLanguage } from "../editor/languages";
import { editorHighlightStyle, editorTheme } from "../editor/theme";
import styles from "./DiffPane.module.css";

export type DiffPaneProps = {
  /** Source document, shown on the left and editable. */
  code: string;
  /** Formatted result, shown on the right and read-only. */
  output: string;
  language: EditorLanguage;
  /** Called for user edits on the left side only (never for prop syncs). */
  onChange: (code: string) => void;
  /** Ctrl/Cmd+Enter inside the left editor. */
  onSubmit?: () => void;
};

// The contract test ids / a11y attributes must land on `.cm-content` of each
// side, so they are re-applied through the editor's contentAttributes facet.
const SOURCE_ATTRIBUTES: Extension = EditorView.contentAttributes.of({
  "data-testid": "source",
  "aria-label": "Source code",
  "aria-readonly": "false",
  "aria-multiline": "true",
  role: "textbox",
  spellcheck: "false",
});

const OUTPUT_ATTRIBUTES: Extension = EditorView.contentAttributes.of({
  "data-testid": "output",
  "aria-label": "Formatted output",
  "aria-readonly": "true",
  "aria-multiline": "true",
  role: "textbox",
  spellcheck: "false",
});

/** Extensions shared by the editable and the read-only side. */
function baseExtensions(): Extension[] {
  return [
    lineNumbers(),
    history(),
    drawSelection(),
    bracketMatching(),
    indentOnInput(),
    EditorState.tabSize.of(2),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    syntaxHighlighting(editorHighlightStyle),
    editorTheme,
  ];
}

/**
 * Split diff view. The parent decides when to show it; it fills a
 * `height: 100%` (or flex) container.
 */
export function DiffPane(props: DiffPaneProps): JSX.Element {
  const { code, output, language, onChange, onSubmit } = props;

  const hostRef = useRef<HTMLDivElement>(null);
  const mergeRef = useRef<MergeView | null>(null);
  /** Set while a prop-driven document replacement is dispatched. */
  const applyingRef = useRef(false);

  // Refs keep the mount-only effect from capturing the first render's values.
  const initialDocsRef = useRef({ code, output });
  initialDocsRef.current = { code, output };
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  const sourceLanguage = useMemo(() => new Compartment(), []);
  const outputLanguage = useMemo(() => new Compartment(), []);

  // `defaultKeymap` binds Mod-Enter to `insertBlankLine`, so the submit binding
  // must be given higher precedence to win (and return false when unhandled so
  // the default binding still applies).
  const submitKeymap = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              const submit = onSubmitRef.current;
              if (submit === undefined) return false;
              submit();
              return true;
            },
          },
        ]),
      ),
    [],
  );

  // MergeView owns both EditorViews; create them once and destroy on unmount
  // (including React StrictMode's mount → unmount → mount cycle).
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const sourceExtensions: Extension[] = [
      ...baseExtensions(),
      SOURCE_ATTRIBUTES,
      sourceLanguage.of([]),
      submitKeymap,
      EditorView.updateListener.of((update) => {
        // Only user edits reach onChange; programmatic doc syncs set the flag.
        if (!update.docChanged || applyingRef.current) return;
        onChangeRef.current(update.state.doc.toString());
      }),
    ];

    const outputExtensions: Extension[] = [
      ...baseExtensions(),
      OUTPUT_ATTRIBUTES,
      outputLanguage.of([]),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
    ];

    const merge = new MergeView({
      a: { doc: initialDocsRef.current.code, extensions: sourceExtensions },
      b: { doc: initialDocsRef.current.output, extensions: outputExtensions },
      parent: host,
      // Small context around each change keeps long files readable without
      // hiding everything (margin 3 / minSize 4 matches the package defaults).
      collapseUnchanged: { margin: 3, minSize: 4 },
      // No revertControls: the right side only displays the formatted result;
      // changes flow source → output through the formatter, not the diff UI.
    });
    mergeRef.current = merge;

    return () => {
      mergeRef.current = null;
      merge.destroy();
    };
  }, [sourceLanguage, outputLanguage, submitKeymap]);

  // Controlled sync: push external source changes into the left document.
  useEffect(() => {
    const merge = mergeRef.current;
    if (merge === null) return;
    const current = merge.a.state.doc.toString();
    if (current === code) return;
    applyingRef.current = true;
    try {
      merge.a.dispatch({ changes: { from: 0, to: current.length, insert: code } });
    } finally {
      applyingRef.current = false;
    }
  }, [code]);

  // Controlled sync: push new formatting results into the right document.
  useEffect(() => {
    const merge = mergeRef.current;
    if (merge === null) return;
    const current = merge.b.state.doc.toString();
    if (current === output) return;
    applyingRef.current = true;
    try {
      merge.b.dispatch({ changes: { from: 0, to: current.length, insert: output } });
    } finally {
      applyingRef.current = false;
    }
  }, [output]);

  // Language support is lazy-loaded (and cached by languages.ts) once, then
  // reconfigured on both sides so the diff keeps syntactic highlighting.
  useEffect(() => {
    const merge = mergeRef.current;
    if (merge === null) return;
    let cancelled = false;
    void loadLanguageSupport(language)
      .then((support) => {
        if (cancelled || mergeRef.current !== merge) return;
        merge.a.dispatch({ effects: sourceLanguage.reconfigure(support) });
        merge.b.dispatch({ effects: outputLanguage.reconfigure(support) });
      })
      .catch(() => {
        // A missing language chunk must not break the diff: stay plain text.
      });
    return () => {
      cancelled = true;
    };
  }, [language, sourceLanguage, outputLanguage]);

  return (
    <div
      ref={hostRef}
      className={styles.root}
      data-testid="diff-view"
      role="region"
      aria-label="Diff: source and formatted result"
    />
  );
}
