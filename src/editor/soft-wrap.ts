// Soft wrap for the CodeMirror surfaces (plan §5 编辑器与 diff, docs/todo.md §3).
//
// Wrapping is a user preference, not an editor invariant: the source and
// formatted panes, the split diff and the config drawer all follow the same
// `softWrap` setting (default on). `EditorView.lineWrapping` is a
// contentAttributes facet value that adds the `cm-lineWrapping` class to
// `.cm-content`; keeping it behind a Compartment lets the editors flip it at
// runtime without being recreated (which would drop undo history and scroll
// position).
//
// Only the facet is toggled: the `pre-wrap`/`word-break` rules live in
// CodeMirror's own stylesheet, so there is nothing else to enable or disable.

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Extensions for one `softWrap` state: wrapping on, or nothing. */
export function softWrapExtensions(enabled: boolean): Extension {
  return enabled ? EditorView.lineWrapping : [];
}
