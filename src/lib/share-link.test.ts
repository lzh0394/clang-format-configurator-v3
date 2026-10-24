// Tests for URL-hash share links (plan §5 / §9 M4).
//
// Encoding is pure and round-trips through base64url; the interesting cases are
// the rejection paths, because a hand-edited or truncated URL must degrade to
// "no shared state" instead of crashing or hydrating garbage into the editor.

import { describe, expect, it } from "vitest";

import {
  SHARE_HASH_PREFIX,
  SHARE_MAX_CODE_LENGTH,
  SHARE_MAX_ENCODED_LENGTH,
  SHARE_PAYLOAD_VERSION,
  decodeShareHash,
  encodeShareState,
  shareUrlFor,
  type ShareState,
} from "./share-link";

const state: ShareState = {
  version: "21.1.8",
  style: "Google",
  modified: { IndentWidth: 4, BraceWrapping: { AfterClass: true } },
  code: "class Widget{};\n",
};

function payload(json: unknown): string {
  const encoded = Buffer.from(JSON.stringify(json), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
  return `#${SHARE_HASH_PREFIX}${encoded}`;
}

describe("encodeShareState", () => {
  it("produces an s= fragment with a base64url payload", () => {
    const fragment = encodeShareState(state);
    expect(fragment.startsWith(SHARE_HASH_PREFIX)).toBe(true);
    expect(fragment.slice(SHARE_HASH_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("omits the optional code when it is null", () => {
    const fragment = encodeShareState({ ...state, code: null });
    const decoded = JSON.parse(
      Buffer.from(fragment.slice(SHARE_HASH_PREFIX.length), "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(decoded).toMatchObject({ k: SHARE_PAYLOAD_VERSION, v: "21.1.8", s: "Google" });
    expect(decoded).not.toHaveProperty("c");
  });

  it("rejects invalid versions/styles and oversized code", () => {
    expect(() => encodeShareState({ ...state, version: "" })).toThrow(RangeError);
    expect(() => encodeShareState({ ...state, version: "x".repeat(65) })).toThrow(RangeError);
    expect(() =>
      encodeShareState({ ...state, style: "Clang" as unknown as ShareState["style"] }),
    ).toThrow(RangeError);
    expect(() => encodeShareState({ ...state, code: "x".repeat(SHARE_MAX_CODE_LENGTH + 1) })).toThrow(
      RangeError,
    );
  });
});

describe("decodeShareHash", () => {
  it("round-trips a full session including non-ASCII source", () => {
    const unicode: ShareState = {
      ...state,
      code: "// 中文注释 🙂\nint  main(){return 0;}\n",
      modified: { ForEachMacros: ["BOOST_FOREACH"], BasedOnStyle: "Google", IndentWidth: 2 },
    };
    expect(decodeShareHash(`#${encodeShareState(unicode)}`)).toEqual(unicode);
    // A fragment without the leading '#' is accepted too (e.g. history entries).
    expect(decodeShareHash(encodeShareState(unicode))).toEqual(unicode);
  });

  it("returns null for anything that is not a share fragment", () => {
    for (const hash of ["", "#", "#foo=bar", "#s=", "?s=abc", "#sec=1"]) {
      expect(decodeShareHash(hash)).toBeNull();
    }
  });

  it("returns null for malformed base64 or JSON", () => {
    expect(decodeShareHash("#s=***not-base64***")).toBeNull();
    expect(decodeShareHash("#s=abc")).toBeNull(); // length % 4 === 1
    expect(decodeShareHash(payloadRaw("not json"))).toBeNull();
    expect(decodeShareHash(payload("<not-an-object>"))).toBeNull();
    expect(
      decodeShareHash(payload({ k: SHARE_PAYLOAD_VERSION + 1, v: "21.1.8", s: "LLVM", m: {} })),
    ).toBeNull();
  });

  it("returns null for invalid field values", () => {
    const valid = { k: SHARE_PAYLOAD_VERSION, v: "21.1.8", s: "Google", m: {} };
    expect(decodeShareHash(payload({ ...valid, v: 42 }))).toBeNull();
    expect(decodeShareHash(payload({ ...valid, v: "" }))).toBeNull();
    expect(decodeShareHash(payload({ ...valid, s: "Clang" }))).toBeNull();
    expect(decodeShareHash(payload({ ...valid, m: [] }))).toBeNull();
    expect(decodeShareHash(payload({ ...valid, c: 7 }))).toBeNull();
    // Missing k / unknown payload versions are rejected instead of guessed.
    expect(decodeShareHash(payload({ v: "21.1.8", s: "Google", m: {} }))).toBeNull();
  });

  it("returns null for absurdly long fragments", () => {
    expect(decodeShareHash(`#${SHARE_HASH_PREFIX}${"A".repeat(SHARE_MAX_ENCODED_LENGTH)}`)).toBeNull();
  });

  it("drops unknown payload keys and defaults a missing code to null", () => {
    const decoded = decodeShareHash(
      payload({ k: SHARE_PAYLOAD_VERSION, v: "18.1.8", s: "LLVM", m: { IndentWidth: 8 }, extra: true }),
    );
    expect(decoded).toEqual({ version: "18.1.8", style: "LLVM", modified: { IndentWidth: 8 }, code: null });
  });
});

describe("shareUrlFor", () => {
  it("keeps the path/query and replaces the hash", () => {
    const url = shareUrlFor("https://example.com/app/index.html?lang=en#section", state);
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://example.com");
    expect(parsed.pathname).toBe("/app/index.html");
    expect(parsed.search).toBe("?lang=en");
    expect(decodeShareHash(parsed.hash)).toEqual(state);
  });

  it("resolves a relative href when a base is supplied", () => {
    const url = shareUrlFor("./app/", state, "https://example.com/root/index.html");
    expect(url).toBe("https://example.com/root/app/" + "#" + encodeShareState(state));
    expect(decodeShareHash(new URL(url).hash)).toEqual(state);
  });
});

/** Encode arbitrary raw text as a share fragment (for malformed-payload tests). */
function payloadRaw(text: string): string {
  const encoded = Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
  return `#${SHARE_HASH_PREFIX}${encoded}`;
}
