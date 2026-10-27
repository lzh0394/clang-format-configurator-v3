// Reports upstream clang-format releases that are newer than the newest entry
// in tools/versions.json.
//
// Only @wasm-fmt/clang-format builds are actionable: the app formats in the
// browser, so an LLVM tag without a matching wasm package cannot be added
// (tools/fetch-wasm.mjs downloads the tarballs from npm). The newest LLVM
// release is still reported, so a lagging wasm build stays visible.
//
//   node tools/check-new-versions.mjs          table + GITHUB_OUTPUT
//   node tools/check-new-versions.mjs --json   JSON only
//
// Exit code 0 means "the comparison ran" — with or without something newer.
// Exit code 1 means upstream could not be read (network, HTTP, bad shape); the
// version-watch workflow keeps that red so a silently dead watch is noticed.

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERSIONS_PATH = path.join(ROOT, "tools", "versions.json");

const REGISTRY = process.env.NPM_REGISTRY ?? "https://registry.npmjs.org";
const WASM_PACKAGE = "@wasm-fmt/clang-format";
const WASM_TAGS_URL = "https://api.github.com/repos/wasm-fmt/clang-format/tags?per_page=100";
const LLVM_RELEASES_URL = "https://api.github.com/repos/llvm/llvm-project/releases?per_page=20";

const REQUEST_TIMEOUT_MS = 15_000;
const ATTEMPTS = 2;

const jsonOnly = process.argv.includes("--json");
const onActions = Boolean(process.env.GITHUB_ACTIONS);

/** `23.1.1`, `v23.1.1` and `llvmorg-23.1.1` all parse to [23, 1, 1]. */
function parseVersion(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/^llvmorg-/, "")
    .replace(/^v/, "");
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function maxVersion(values) {
  let max = null;
  for (const value of values) {
    if (!parseVersion(value)) continue;
    if (max === null || compareVersions(value, max) > 0) max = value;
  }
  return max;
}

async function fetchJson(url) {
  let lastError = null;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const headers = {
        accept: "application/json",
        "user-agent": "clang-format-configurator-version-watch",
      };
      // GH_TOKEN is a GitHub token: never hand it to the npm registry.
      if (url.startsWith("https://api.github.com/") && process.env.GH_TOKEN) {
        headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
      }

      const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    }
  }

  throw new Error(`${url}: ${lastError?.message ?? "unknown error"}`);
}

function report(message) {
  if (!jsonOnly) process.stdout.write(`${message}\n`);
}

function note(message) {
  if (!jsonOnly) report(`note: ${message}`);
}

const pinned = JSON.parse(await readFile(VERSIONS_PATH, "utf8"));
if (!Array.isArray(pinned) || pinned.length === 0) {
  throw new Error("tools/versions.json must be a non-empty array");
}

const repoMax = maxVersion(pinned.map((row) => row.version));
if (repoMax === null) throw new Error("tools/versions.json has no x.y.z version");

const registry = await fetchJson(`${REGISTRY}/${WASM_PACKAGE}`);
const published = Object.keys(registry?.versions ?? {});
if (published.length === 0) throw new Error(`${WASM_PACKAGE}: the registry returned no versions`);

const wasmMax = maxVersion(published);
const addable = published
  .filter((version) => parseVersion(version) && compareVersions(version, repoMax) > 0)
  .sort(compareVersions);

// GitHub metadata is a bonus signal (early tag, LLVM release without a wasm
// build). Neither can be added on its own, so a failure here is a note, not a
// failed run — the actionable check above already succeeded.
let wasmTagMax = null;
try {
  const tags = await fetchJson(WASM_TAGS_URL);
  wasmTagMax = maxVersion(tags.map((tag) => tag.name));
  if (wasmTagMax && wasmMax && compareVersions(wasmTagMax, wasmMax) > 0) {
    note(`wasm-fmt tagged ${wasmTagMax} but the newest npm build is ${wasmMax}`);
  }
} catch (error) {
  note(`wasm-fmt tags unavailable: ${error.message}`);
}

let llvmMax = null;
try {
  const releases = await fetchJson(LLVM_RELEASES_URL);
  const stable = (Array.isArray(releases) ? releases : []).filter((r) => !r.prerelease && !r.draft);
  llvmMax = maxVersion(stable.map((release) => release.tag_name));
} catch (error) {
  note(`LLVM releases unavailable: ${error.message}`);
}

const wasmNew = wasmMax && compareVersions(wasmMax, repoMax) > 0 ? wasmMax : "";
const llvmNew = llvmMax && compareVersions(llvmMax, repoMax) > 0 ? llvmMax : "";

report(`pinned (${pinned.length} entries)  ${repoMax}`);
report(`npm wasm build        ${wasmMax ?? "unknown"}`);
report(`wasm-fmt tag          ${wasmTagMax ?? "unknown"}`);
report(`newest LLVM release   ${llvmMax ?? "unknown"}`);

if (addable.length > 0) {
  report(`newer wasm builds     ${addable.join(", ")}`);
} else if (llvmNew) {
  report(`status                up to date — LLVM ${llvmNew} has no wasm build yet`);
} else {
  report("status                up to date");
}

const outputs = {
  repo_max: repoMax,
  wasm_max: wasmMax ?? "",
  wasm_tag_max: wasmTagMax ?? "",
  llvm_max: llvmMax ?? "",
  wasm_new: wasmNew,
  llvm_new: llvmNew,
  addable: addable.join(", "),
};

if (onActions && wasmNew) {
  report(`::warning::a newer wasm build exists: ${addable.join(", ")}`);
}

if (jsonOnly) {
  process.stdout.write(`${JSON.stringify(outputs, null, 2)}\n`);
} else if (process.env.GITHUB_OUTPUT) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}
