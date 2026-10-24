// Controlled CodeMirror 6 editor used by the source/formatted panes and by the
// configuration drawer. The value is owned by React; the view only dispatches
// `onChange` for user edits and replaces its document when the prop changes.

import { useEffect, useMemo, useRef, type JSX } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExtension,
} from "@codemirror/view";

import { loadLanguageSupport, type EditorLanguage } from "./languages";
import { editorHighlightStyle, editorTheme } from "./theme";
import styles from "./CodeEditor.module.css";

export type CodeEditorProps = {
  /** Document text. Replaced into the view when it differs from the current doc. */
  value: string;
  /** Called for user edits only (never for programmatic prop syncs). */
  onChange?: (value: string) => void;
  language?: EditorLanguage;
  readOnly?: boolean;
  ariaLabel: string;
  /** Applied to the `.cm-content` element so tests can target the editable area. */
  testId?: string;
  className?: string;
  placeholder?: string;
  /** Ctrl/Cmd+Enter inside the editor. */
  onSubmit?: () => void;
  /** Access to the underlying view (used by the diff view / tests). */
  onViewReady?: (view: EditorView) => void;
};

function contentAttributes(ariaLabel: string, testId: string | undefined, readOnly: boolean) {
  const attributes: Record<string, string> = {
    "aria-label": ariaLabel,
    "aria-multiline": "true",
    "aria-readonly": readOnly ? "true" : "false",
    role: "textbox",
    spellcheck: "false",
  };
  if (testId !== undefined) attributes["data-testid"] = testId;
  return attributes;
}

export function CodeEditor(props: CodeEditorProps): JSX.Element {
  const {
    value,
    onChange,
    language = "plain",
    readOnly = false,
    ariaLabel,
    testId,
    className,
    placeholder,
    onSubmit,
    onViewReady,
  } = props;

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const syncingRef = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onViewReadyRef = useRef(onViewReady);
  onViewReadyRef.current = onViewReady;

  const languageCompartment = useMemo(() => new Compartment(), []);
  const readOnlyCompartment = useMemo(() => new Compartment(), []);
  const attributesCompartment = useMemo(() => new Compartment(), []);
  const submitKeymap = useMemo(
    () =>
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
    [],
  );

  // Mount once: the props that can change afterwards (value, language,
  // readonly, content attributes) are pushed through compartments below.
  useEffect(() => {
    const parent = hostRef.current;
    if (parent === null) return;

    const initialReadOnly = readOnly;
    const state = EditorState.create({
      doc: value,
      extensions: [
        submitKeymap,
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        EditorState.tabSize.of(2),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        editorTheme,
        syntaxHighlighting(editorHighlightStyle),
        languageCompartment.of([]),
        readOnlyCompartment.of(readOnlyExtensions(initialReadOnly)),
        attributesCompartment.of(EditorView.contentAttributes.of(contentAttributes(ariaLabel, testId, initialReadOnly))),
        placeholder === undefined ? [] : placeholderExtension(placeholder),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || syncingRef.current) return;
          onChangeRef.current?.(update.state.doc.toString());
        }),
      ],
    });

    const view = new EditorView({ state, parent });
    viewRef.current = view;
    onViewReadyRef.current?.(view);

    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // Mount-only on purpose: everything mutable is handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push external value changes into the document (never echo user edits).
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    syncingRef.current = true;
    try {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    } finally {
      syncingRef.current = false;
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    let cancelled = false;
    void loadLanguageSupport(language)
      .then((support) => {
        if (cancelled) return;
        view.dispatch({ effects: languageCompartment.reconfigure(support) });
      })
      .catch(() => {
        // A missing language chunk must not break editing: stay in plain text.
      });
    return () => {
      cancelled = true;
    };
  }, [language, languageCompartment]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: readOnlyCompartment.reconfigure(readOnlyExtensions(readOnly)) });
    viewRef.current?.dispatch({
      effects: attributesCompartment.reconfigure(
        EditorView.contentAttributes.of(contentAttributes(ariaLabel, testId, readOnly)),
      ),
    });
  }, [readOnly, ariaLabel, testId, readOnlyCompartment, attributesCompartment]);

  return <div ref={hostRef} className={className ?? styles.host} />;
}

function readOnlyExtensions(readOnly: boolean): Extension {
  return readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
}
