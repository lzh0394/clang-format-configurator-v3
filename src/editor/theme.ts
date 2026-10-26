// Shared CodeMirror theme. All colours and the font size come from CSS custom
// properties (see src/styles.css), so the editors follow the app theme and the
// `--font-size-editor` setting without a second theming system (plan §5 字号).

import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

export const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "var(--font-size-editor, 13px)",
    backgroundColor: "transparent",
    color: "var(--text)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    fontFamily: "var(--mono)",
    lineHeight: "1.55",
    overflow: "auto",
  },
  ".cm-content": {
    padding: "10px 0",
    caretColor: "var(--accent)",
  },
  ".cm-line": {
    padding: "0 12px",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted)",
    borderRight: "1px solid var(--border)",
    paddingLeft: "4px",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--text)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)",
  },
  ".cm-placeholder": {
    color: "var(--muted)",
    fontStyle: "italic",
  },
});

export const editorHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syntax-keyword)" },
  { tag: tags.operator, color: "var(--syntax-operator)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--syntax-string)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--syntax-number)" },
  { tag: [tags.typeName, tags.className], color: "var(--syntax-type)" },
  { tag: tags.function(tags.variableName), color: "var(--syntax-function)" },
  { tag: tags.propertyName, color: "var(--syntax-property)" },
  { tag: [tags.definition(tags.variableName), tags.local(tags.variableName)], color: "var(--text)" },
  { tag: tags.meta, color: "var(--muted)" },
]);
