// Lazy docs loader for the options panel (plan §5): the per-version docs JSON is
// only fetched the first time a search needs its text or a row's docs are
// expanded, then it is kept in the shared schema store and in this hook.
//
// The hook never fetches by itself: `ensureLoaded()` (idempotent) is called from
// a search effect or a click handler. `retry()` bypasses the "already failed"
// state because the store does not cache failures.

import { useCallback, useEffect, useRef, useState } from "react";

import type { SchemaDocs } from "../lib/schema";
import { schemaStore } from "../lib/schema-store";

export type DocsStatus = "idle" | "loading" | "ready" | "error";

export type DocsLoader = {
  docs: SchemaDocs | null;
  status: DocsStatus;
  error: string | null;
  /**
   * Request the docs once (only acts from the "idle" state, so it is safe to
   * call on every keystroke); a previous failure is retried via `retry`.
   */
  ensureLoaded: () => void;
  /** Fetch again after a failure. */
  retry: () => void;
};

type DocsState = {
  docs: SchemaDocs | null;
  status: DocsStatus;
  error: string | null;
};

const IDLE: DocsState = { docs: null, status: "idle", error: null };

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ---------------------------------------------------------------------------
// Docs HTML rendering (M4; docs HTML is build-time output of tools/gen-schema.mjs)
// ---------------------------------------------------------------------------

/** A table cell flattened by the schema generator, cut at token boundaries. */
const TAG_SPLIT = /(<[^>]*>)/;

/** RST block directive that leaked into flattened plain text, e.g. `.. code-block:: c++`. */
const LEAKED_ADMONITION = /\.\.\s+(note|warning|attention|caution|danger|important|tip)::\s*/gi;

/** Code-block directives name a language; only a known language name is consumed. */
const CODE_LANGUAGES =
  "javascript|js|json|java|csharp|textproto|tablegen|verilog|objective-c|objc|plaintext|proto|python|py|c\\+\\+|cpp|cs|c|yaml";

const LEAKED_CODE_DIRECTIVE = new RegExp(
  `\\.\\.\\s+(?:code-block|code|sourcecode)::(?:\\s*(?:${CODE_LANGUAGES}))?\\s*`,
  "gi",
);

/** Any other RST directive the generator did not convert (rare). */
const LEAKED_OTHER_DIRECTIVE = /\.\.\s+[a-z][a-z0-9-]*::\s*/gi;

/** RST hyperlink literal, e.g. `` `POSIX extended &lt;https://…&gt;`_ ``. */
const RST_LINK = /`([^`]+?)\s*&lt;(.+?)&gt;`__?/g;

/** Admonition-style directives become an inline label instead of disappearing. */
const ADMONITION_LABELS: Readonly<Record<string, string>> = {
  note: "Note",
  warning: "Warning",
  attention: "Attention",
  caution: "Caution",
  danger: "Danger",
  important: "Important",
  tip: "Tip",
};

/**
 * Replacement for a leaked directive: a line break only when prose exists on
 * both sides, so no empty line is left at the start or end of a table cell.
 */
function directiveBreak(offset: number, match: string, whole: string): string {
  const head = whole.slice(0, offset);
  const rest = whole.slice(offset + match.length);
  return head.trim() === "" || rest.trim() === "" ? "" : "<br>";
}

/** Add `tabindex="0"` to `<pre>` so horizontally scrollable code blocks are keyboard reachable (WCAG 2.1.1). */
function makePreFocusable(tag: string): string {
  if (!/^<pre\b/i.test(tag)) return tag;
  if (/\btabindex\s*=/i.test(tag)) return tag;
  return tag.replace(/^<pre\b/i, '<pre tabindex="0"');
}

/**
 * Clean the *text* between tags. Only text nodes are touched (never attribute
 * values), so the existing escaping of the build-time HTML is preserved: the
 * function never decodes entities and never re-inserts raw text into markup.
 */
function normalizeDocsText(text: string): string {
  if (text === "") return text;

  // `label <url>`_ → `label (url)`: readable without re-creating an anchor that
  // would need the (escaped) URL decoded first.
  let next = text.replace(RST_LINK, (_match, label: string, url: string) => `${label.trim()} (${url.trim()})`);

  // Admonition directives become a labelled paragraph; code-block directives
  // (which survive the generator's table-cell flattening as prose and lost
  // their line breaks) become a line break in front of the snippet.
  next = next.replace(LEAKED_ADMONITION, (match: string, name: string, offset: number, whole: string) => {
    const label = ADMONITION_LABELS[name.toLowerCase()] ?? "";
    const head = whole.slice(0, offset);
    const prefix = head.trim() === "" ? "" : "<br>";
    return `${prefix}<strong>${label}:</strong> `;
  });
  next = next.replace(LEAKED_CODE_DIRECTIVE, (match: string, offset: number, whole: string) =>
    directiveBreak(offset, match, whole),
  );
  next = next.replace(LEAKED_OTHER_DIRECTIVE, (match: string, offset: number, whole: string) =>
    directiveBreak(offset, match, whole),
  );

  // Single-backtick RST literals are inline code (`` `Value` `` → `<code>Value</code>`).
  next = next.replace(/`([^`]+?)`/g, "<code>$1</code>");
  return next;
}

/**
 * Render-layer fix for the build-time docs HTML (M3 legacy "docs `<pre>` is not
 * focusable", plan §9 M4):
 *
 * - every `<pre>` becomes a tab stop so the horizontal scroll area is reachable
 *   with the keyboard;
 * - RST markers that the generator's table-cell renderer leaked into prose
 *   (`.. code-block:: c++`, `.. note::`, `` `label <url>`_ ``, single-backtick
 *   literals) are normalized into readable text/markup;
 * - escaping is untouched (text nodes are only concatenated with static
 *   markup), so the HTML stays as safe as the generator produced it.
 */
export function prepareDocsHtml(html: string): string {
  if (html === "") return html;
  const tokens = html.split(TAG_SPLIT);
  // split() with one capturing group alternates text (even) and tag (odd).
  return tokens.map((token, index) => (index % 2 === 1 ? makePreFocusable(token) : normalizeDocsText(token))).join("");
}

export function useDocs(version: string): DocsLoader {
  const [state, setState] = useState<DocsState>(IDLE);
  const requestedRef = useRef(false);
  const generationRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const load = useCallback(() => {
    const generation = ++generationRef.current;
    setState({ docs: null, status: "loading", error: null });
    schemaStore.docs(version).then(
      (docs) => {
        if (generationRef.current !== generation) return;
        setState({ docs, status: "ready", error: null });
      },
      (cause: unknown) => {
        if (generationRef.current !== generation) return;
        setState({ docs: null, status: "error", error: errorMessage(cause) });
      },
    );
  }, [version]);

  const ensureLoaded = useCallback(() => {
    requestedRef.current = true;
    // Only start the very first request here; a failed request is retried from
    // the explicit "Retry" affordance (the store does not cache failures, so a
    // retry is a real refetch and does not happen automatically on each key).
    if (stateRef.current.status === "idle") load();
  }, [load]);

  const retry = useCallback(() => {
    requestedRef.current = true;
    load();
  }, [load]);

  // A new schema version invalidates anything we already had; if docs were
  // requested once (search or an expanded row), fetch them for the new version
  // right away so the current filter can be re-evaluated.
  useEffect(() => {
    generationRef.current += 1; // drop an in-flight result for the old version
    if (requestedRef.current) load();
    else setState(IDLE);
  }, [version, load]);

  return { docs: state.docs, status: state.status, error: state.error, ensureLoaded, retry };
}
