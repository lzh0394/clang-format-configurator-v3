// Tests for the versioned localStorage persistence layer.
//
// The module is deliberately synchronous and exception-free, so every failure
// mode is asserted through the `problem` / return value instead of `.toThrow`.
// A minimal in-memory fake stands in for Storage: Vitest runs in the node
// environment here, and the real browser path is exercised by the e2e suite.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_SOFT_WRAP,
  DEFAULT_STYLE,
  DEFAULT_THEME,
  DEFAULT_UI_FONT_SCALE,
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  STATE_VERSION,
  STORAGE_KEY,
  UI_FONT_SCALES,
  isUiFontScale,
  loadPersistedState,
  savePersistedState,
  clearPersistedState,
  type PersistedState,
} from "./persisted-state";

type FakeStorage = ReturnType<typeof makeStorage>;

function makeStorage(initial: Record<string, string> = {}): {
  data: Map<string, string>;
  counts: { writes: number; removes: number };
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
} {
  const data = new Map<string, string>(Object.entries(initial));
  const counts = { writes: 0, removes: 0 };
  return {
    data,
    counts,
    getItem(key: string): string | null {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      counts.writes += 1;
      data.set(key, value);
    },
    removeItem(key: string): void {
      counts.removes += 1;
      data.delete(key);
    },
  };
}

const validState: PersistedState = {
  stateVersion: STATE_VERSION,
  version: "21.1.8",
  style: "Google",
  modified: { IndentWidth: 4, BraceWrapping: { AfterClass: true } },
  code: "class Widget{};\n",
  theme: "dark",
  editorFontSize: 18,
  uiFontScale: 1.15,
  softWrap: false,
};

const stored = (value: unknown): FakeStorage =>
  makeStorage({ [STORAGE_KEY]: typeof value === "string" ? value : JSON.stringify(value) });

describe("loadPersistedState", () => {
  it("reports empty on a first visit", () => {
    expect(loadPersistedState(makeStorage())).toEqual({ state: null, problem: "empty" });
    expect(loadPersistedState(makeStorage({ [STORAGE_KEY]: "" }))).toEqual({ state: null, problem: "empty" });
  });

  it("reports corrupt for unparsable JSON", () => {
    const result = loadPersistedState(makeStorage({ [STORAGE_KEY]: "{ not json" }));
    expect(result).toEqual({ state: null, problem: "corrupt" });
  });

  it("reports corrupt for wrong top-level shapes", () => {
    for (const raw of ["null", "42", '"a string"', "[]", "{}", '{"stateVersion":"1","version":"21.1.8"}']) {
      expect(loadPersistedState(makeStorage({ [STORAGE_KEY]: raw })).problem).toBe("corrupt");
    }
    // A valid object without the version marker is structural corruption, not
    // a version mismatch.
    expect(loadPersistedState(stored({ version: "21.1.8", style: "LLVM" }))).toEqual({
      state: null,
      problem: "corrupt",
    });
  });

  it("reports version-mismatch and drops the document", () => {
    for (const stateVersion of [0, STATE_VERSION + 1, 99]) {
      expect(loadPersistedState(stored({ ...validState, stateVersion }))).toEqual({
        state: null,
        problem: "version-mismatch",
      });
    }
  });

  it("returns a fully normalized document for the current version", () => {
    const result = loadPersistedState(stored(validState));
    expect(result.problem).toBe("none");
    expect(result.state).toEqual(validState);
    // Unknown extra fields are not carried into the app state.
    expect(loadPersistedState(stored({ ...validState, arbitrary: true })).state).toEqual(validState);
  });

  it("falls back to defaults for individually invalid fields instead of failing", () => {
    const result = loadPersistedState(
      stored({
        ...validState,
        version: 42,
        style: "Clang",
        modified: ["not", "a", "map"],
        code: null,
        theme: "blue",
        editorFontSize: "18",
        uiFontScale: 1.5,
        softWrap: "on",
      }),
    );

    expect(result.problem).toBe("none");
    expect(result.state).toEqual({
      stateVersion: STATE_VERSION,
      version: "",
      style: DEFAULT_STYLE,
      modified: {},
      code: "",
      theme: DEFAULT_THEME,
      editorFontSize: DEFAULT_EDITOR_FONT_SIZE,
      uiFontScale: DEFAULT_UI_FONT_SCALE,
      softWrap: DEFAULT_SOFT_WRAP,
    });
  });

  it("keeps the valid fields next to an invalid one", () => {
    const result = loadPersistedState(
      stored({
        ...validState,
        version: 21.1,
        style: "Mozilla",
        theme: "light",
        editorFontSize: 20,
      }),
    );

    expect(result.problem).toBe("none");
    expect(result.state).toMatchObject({
      version: "",
      style: "Mozilla",
      modified: validState.modified,
      code: validState.code,
      theme: "light",
      editorFontSize: 20,
    });
  });

  it("accepts the whole documented font-size range and rejects non-integers/edges", () => {
    const loadSize = (editorFontSize: unknown): number | undefined =>
      loadPersistedState(stored({ ...validState, editorFontSize })).state?.editorFontSize;

    expect(loadSize(EDITOR_FONT_SIZE_MIN)).toBe(EDITOR_FONT_SIZE_MIN);
    expect(loadSize(EDITOR_FONT_SIZE_MAX)).toBe(EDITOR_FONT_SIZE_MAX);
    expect(loadSize(13.5)).toBe(DEFAULT_EDITOR_FONT_SIZE);
    expect(loadSize(EDITOR_FONT_SIZE_MIN - 1)).toBe(DEFAULT_EDITOR_FONT_SIZE);
    expect(loadSize(EDITOR_FONT_SIZE_MAX + 1)).toBe(DEFAULT_EDITOR_FONT_SIZE);
    expect(loadSize(Number.NaN)).toBe(DEFAULT_EDITOR_FONT_SIZE);
  });

  it("treats a document written before M4 (no uiFontScale) as 100%", () => {
    const { uiFontScale: _omitted, ...beforeM4 } = validState;
    const result = loadPersistedState(stored(beforeM4));
    expect(result.problem).toBe("none");
    expect(result.state?.uiFontScale).toBe(DEFAULT_UI_FONT_SCALE);
  });

  it("accepts every documented UI scale and rejects everything else", () => {
    for (const scale of UI_FONT_SCALES) {
      expect(isUiFontScale(scale)).toBe(true);
      expect(loadPersistedState(stored({ ...validState, uiFontScale: scale })).state?.uiFontScale).toBe(scale);
    }
    for (const invalid of [0, 0.5, 1.5, 2, "1.15", null, Number.NaN]) {
      expect(isUiFontScale(invalid)).toBe(false);
      expect(loadPersistedState(stored({ ...validState, uiFontScale: invalid })).state?.uiFontScale).toBe(
        DEFAULT_UI_FONT_SCALE,
      );
    }
  });

  it("treats a document written before soft wrap (no softWrap) as enabled", () => {
    const { softWrap: _omitted, ...beforeSoftWrap } = validState;
    const result = loadPersistedState(stored(beforeSoftWrap));
    expect(result.problem).toBe("none");
    // The shipped default is on, so an old session starts wrapping.
    expect(result.state?.softWrap).toBe(DEFAULT_SOFT_WRAP);
    expect(DEFAULT_SOFT_WRAP).toBe(true);
  });

  it("accepts only booleans for softWrap and falls back to the default otherwise", () => {
    expect(loadPersistedState(stored({ ...validState, softWrap: true })).state?.softWrap).toBe(true);
    expect(loadPersistedState(stored({ ...validState, softWrap: false })).state?.softWrap).toBe(false);
    for (const invalid of [0, 1, "false", "true", null, undefined, {}]) {
      expect(loadPersistedState(stored({ ...validState, softWrap: invalid })).state?.softWrap).toBe(
        DEFAULT_SOFT_WRAP,
      );
    }
  });

  it("reports unavailable when getItem throws", () => {
    const storage = makeStorage();
    storage.getItem = () => {
      throw new Error("SecurityError: storage is blocked");
    };
    expect(loadPersistedState(storage)).toEqual({ state: null, problem: "unavailable" });
  });

  it("reports unavailable when there is no storage at all", () => {
    // This suite runs in the node environment: window is absent, so the
    // default provider is unavailable and an explicit null is treated the same.
    expect(loadPersistedState()).toEqual({ state: null, problem: "unavailable" });
    expect(loadPersistedState(null as unknown as FakeStorage)).toEqual({
      state: null,
      problem: "unavailable",
    });
  });

  it("never throws, whatever is stored", () => {
    const throwing: FakeStorage = makeStorage();
    throwing.getItem = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    expect(() => loadPersistedState(throwing)).not.toThrow();
    expect(() => loadPersistedState(makeStorage({ [STORAGE_KEY]: "\u0000\u0001" }))).not.toThrow();
  });
});

describe("savePersistedState", () => {
  it("round-trips a document under STORAGE_KEY", () => {
    const storage = makeStorage();
    expect(savePersistedState(validState, storage)).toBe("ok");
    expect(storage.counts.writes).toBe(1);
    expect(storage.data.has(STORAGE_KEY)).toBe(true);
    expect(loadPersistedState(storage)).toEqual({ state: validState, problem: "none" });
  });

  it("stamps the current STATE_VERSION instead of trusting the input", () => {
    const storage = makeStorage();
    expect(savePersistedState({ ...validState, stateVersion: 0 }, storage)).toBe("ok");
    const raw = storage.data.get(STORAGE_KEY) ?? "";
    expect(JSON.parse(raw).stateVersion).toBe(STATE_VERSION);
    expect(loadPersistedState(storage).problem).toBe("none");
  });

  it("normalizes invalid fields before writing", () => {
    const storage = makeStorage();
    const dirty = {
      ...validState,
      theme: "purple",
      editorFontSize: 999,
      uiFontScale: 1.5,
      softWrap: "definitely",
    } as unknown as PersistedState;
    expect(savePersistedState(dirty, storage)).toBe("ok");
    const written = JSON.parse(storage.data.get(STORAGE_KEY) ?? "null") as PersistedState;
    expect(written.theme).toBe(DEFAULT_THEME);
    expect(written.editorFontSize).toBe(DEFAULT_EDITOR_FONT_SIZE);
    expect(written.uiFontScale).toBe(DEFAULT_UI_FONT_SCALE);
    expect(written.softWrap).toBe(DEFAULT_SOFT_WRAP);
  });

  it("reports quota when the browser storage is full (by name or legacy code)", () => {
    const byName = makeStorage();
    byName.setItem = () => {
      throw new DOMException("exceeded", "QuotaExceededError");
    };
    expect(savePersistedState(validState, byName)).toBe("quota");

    const byCode = makeStorage();
    byCode.setItem = () => {
      const error = new Error("Quota exceeded");
      (error as Error & { code: number }).code = 22;
      throw error;
    };
    expect(savePersistedState(validState, byCode)).toBe("quota");

    const firefoxCode = makeStorage();
    firefoxCode.setItem = () => {
      const error = new Error("Quota exceeded");
      (error as Error & { code: number }).code = 1014;
      throw error;
    };
    expect(savePersistedState(validState, firefoxCode)).toBe("quota");
  });

  it("reports unavailable for other write failures and absent storage", () => {
    const blocked = makeStorage();
    blocked.setItem = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    expect(savePersistedState(validState, blocked)).toBe("unavailable");
    expect(savePersistedState(validState)).toBe("unavailable");
    expect(savePersistedState(validState, null as unknown as FakeStorage)).toBe("unavailable");
  });

  it("never throws on a non-serializable document", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const storage = makeStorage();
    expect(() =>
      savePersistedState({ ...validState, modified: { Circular: circular } }, storage),
    ).not.toThrow();
    expect(savePersistedState({ ...validState, modified: { Circular: circular } }, storage)).toBe(
      "unavailable",
    );
    expect(storage.counts.writes).toBe(0);
  });
});

describe("clearPersistedState", () => {
  it("removes the stored entry", () => {
    const storage = makeStorage();
    savePersistedState(validState, storage);
    expect(storage.data.has(STORAGE_KEY)).toBe(true);

    clearPersistedState(storage);
    expect(storage.data.has(STORAGE_KEY)).toBe(false);
    expect(storage.counts.removes).toBe(1);
    expect(loadPersistedState(storage).problem).toBe("empty");
  });

  it("never throws when storage is missing or removeItem fails", () => {
    expect(() => clearPersistedState()).not.toThrow();
    expect(() => clearPersistedState(null as unknown as FakeStorage)).not.toThrow();

    const storage = makeStorage();
    storage.removeItem = () => {
      throw new Error("nope");
    };
    expect(() => clearPersistedState(storage)).not.toThrow();
  });
});
