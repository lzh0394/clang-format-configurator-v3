// Pure helpers for turning thrown values and captured stderr diagnostics into
// the structured `{ summary, detail }` pair rendered by ErrorPanel.
//
// Kept free of DOM / Worker / React imports on purpose: the formatter worker
// uses it to build `err` responses and Vitest runs it directly in node.

export type ErrorParts = {
  /** One-line headline, never empty. */
  summary: string;
  /** Remaining lines; may be empty. */
  detail: string;
};

const FALLBACK_SUMMARY = "format failed";

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return String(value);
  } catch {
    return "";
  }
}

function cleanLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Split raw error text: the first non-blank line is the summary, the rest is detail. */
export function splitErrorText(text: string, fallbackSummary = FALLBACK_SUMMARY): ErrorParts {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first < 0) return { summary: fallbackSummary, detail: "" };

  return {
    summary: (lines[first] ?? "").trim(),
    detail: lines.slice(first + 1).join("\n").trim(),
  };
}

/** Normalize an unknown thrown value into `{ summary, detail }`. */
export function describeError(error: unknown, fallbackSummary = FALLBACK_SUMMARY): ErrorParts {
  return splitErrorText(toText(error), fallbackSummary);
}

/**
 * Append diagnostics captured from `console.error` / `console.warn` to
 * `base.detail`.
 *
 * Blank lines are dropped, lines already present in the summary or detail are
 * removed (LLVM commonly repeats the exception text on stderr), and repeated
 * captured lines are collapsed. The summary is left untouched.
 */
export function mergeDiagnostics(base: ErrorParts, captured: readonly string[]): ErrorParts {
  const summary = base.summary.trim() || FALLBACK_SUMMARY;
  const seen = new Set<string>();
  for (const line of cleanLines(summary)) seen.add(line);
  for (const line of cleanLines(base.detail)) seen.add(line);

  const extra: string[] = [];
  for (const entry of captured) {
    for (const line of cleanLines(entry)) {
      if (seen.has(line)) continue;
      seen.add(line);
      extra.push(line);
    }
  }

  return {
    summary,
    detail: [...cleanLines(base.detail), ...extra].join("\n"),
  };
}
