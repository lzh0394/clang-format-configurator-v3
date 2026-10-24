// Shareable links (plan §5 持久化 / §9 M4): the whole session is encoded into
// the URL hash, so a configuration can be sent to a colleague without a backend.
//
// Format: `#s=<base64url(JSON)>` where the JSON payload is
//   { "k": 1, "v": version, "s": style, "m": modified, "c": code? }
//
// `k` is the payload schema version (bumped only for incompatible changes; an
// unknown `k` is rejected instead of guessed at). `c` is optional because very
// long sources do not belong in a URL; callers pass `null` to share only the
// configuration.
//
// Priority on load is documented in `plan.md` §5: hash > localStorage. App strips
// the hash after hydrating it, so later edits persist normally instead of being
// overwritten by the same link on every reload.
//
// Everything here is pure (no DOM access beyond the standard URL/TextEncoder
// APIs), so the node unit suite can cover the encoding and every rejection path.

import type { Modified } from "./config";
import { isStyleName } from "./persisted-state";
import type { StyleName } from "./schema";

/** Hash fragment key: `#s=...`. */
export const SHARE_HASH_PREFIX = "s=";

/** Payload schema version written into `k`; decode rejects anything else. */
export const SHARE_PAYLOAD_VERSION = 1;

/**
 * Upper bound for the encoded fragment. Keeps a hand-crafted link from making
 * the app allocate/parse something absurd; 48 KB also stays well under the
 * limits browsers and chat clients put on URLs.
 */
export const SHARE_MAX_ENCODED_LENGTH = 48 * 1024;

/** Source code longer than this is left out of share links (configuration only). */
export const SHARE_MAX_CODE_LENGTH = 8 * 1024;

/** Maximum accepted length of the version string (e.g. "21.1.8"). */
const MAX_VERSION_LENGTH = 64;

export type ShareState = {
  version: string;
  style: StyleName;
  modified: Modified;
  /** `null` = share the configuration only. */
  code: string | null;
};

type SharePayload = {
  k: number;
  v: string;
  s: StyleName;
  m: Modified;
  c?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** UTF-8 safe base64url (no padding), usable in a URL fragment. */
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

/** Inverse of `toBase64Url`; returns null for invalid input instead of throwing. */
function fromBase64Url(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(encoded)) return null;
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = padded.length % 4;
  if (remainder === 1) return null;
  try {
    const binary = atob(padded + "=".repeat((4 - remainder) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Encode a session as the URL fragment (including the leading `s=`).
 * Throws only for a non-serializable `modified` value or an out-of-range code;
 * callers surface that as "could not create link" rather than crashing.
 */
export function encodeShareState(state: ShareState): string {
  if (state.version.length === 0 || state.version.length > MAX_VERSION_LENGTH) {
    throw new RangeError("share link: invalid version");
  }
  if (!isStyleName(state.style)) throw new RangeError("share link: invalid style");
  if (!isRecord(state.modified)) throw new RangeError("share link: invalid modified map");
  if (state.code !== null && state.code.length > SHARE_MAX_CODE_LENGTH) {
    throw new RangeError("share link: source code is too long to share");
  }

  const payload: SharePayload = { k: SHARE_PAYLOAD_VERSION, v: state.version, s: state.style, m: state.modified };
  if (state.code !== null) payload.c = state.code;

  const encoded = `${SHARE_HASH_PREFIX}${toBase64Url(JSON.stringify(payload))}`;
  if (encoded.length > SHARE_MAX_ENCODED_LENGTH) {
    throw new RangeError("share link: encoded state is too long");
  }
  return encoded;
}

/**
 * Decode `location.hash` (with or without the leading `#`) into a session.
 * Any structural problem yields `null`; unknown keys are ignored and the
 * schema layer later drops options the target version does not know.
 */
export function decodeShareHash(hash: string): ShareState | null {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!fragment.startsWith(SHARE_HASH_PREFIX)) return null;

  const encoded = fragment.slice(SHARE_HASH_PREFIX.length);
  if (encoded.length === 0 || encoded.length > SHARE_MAX_ENCODED_LENGTH) return null;

  const json = fromBase64Url(encoded);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.k !== SHARE_PAYLOAD_VERSION) return null;
  if (typeof parsed.v !== "string" || parsed.v.length === 0 || parsed.v.length > MAX_VERSION_LENGTH) return null;
  if (!isStyleName(parsed.s)) return null;
  if (!isRecord(parsed.m)) return null;
  if (parsed.c !== undefined && typeof parsed.c !== "string") return null;
  if (typeof parsed.c === "string" && parsed.c.length > SHARE_MAX_CODE_LENGTH) return null;

  return {
    version: parsed.v,
    style: parsed.s,
    modified: parsed.m,
    code: typeof parsed.c === "string" ? parsed.c : null,
  };
}

/**
 * Full URL for `href` with the share fragment; keeps path/query, replaces hash.
 * `base` is optional (App always passes an absolute `location.href`); it exists
 * so callers/tests can resolve a relative href without touching the DOM.
 */
export function shareUrlFor(href: string, state: ShareState, base?: string): string {
  const url = new URL(href, base);
  url.hash = encodeShareState(state);
  return url.toString();
}
