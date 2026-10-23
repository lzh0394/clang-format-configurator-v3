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
