// Enforces the gzip size budgets from plan.md §1 on a production build, and
// makes sure the build actually ships every version listed in
// tools/versions.json.
//
//   npm run build && node tools/check-size.mjs
//
// Budgets (gzip, zlib level 9):
//   initial JS (entry <script type=module src> + <link rel=modulepreload> JS)  ≤ 250 KB
//   each dist/wasm/<ver>/*.wasm                                               ≤ 1.1 MB
//   each dist/schema/<ver>/core.json                                          ≤ 25 KB
//   each dist/schema/<ver>/docs.json                                          ≤ 45 KB
//
// No dependencies: node:fs / node:path / node:zlib only. Exits 1 on any
// violation (or when dist/ is missing the assets it is supposed to check, since
// a build without wasm/schema would otherwise pass with nothing to measure).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = path.join(ROOT, "dist");
const KB = 1024;
const MB = 1024 * KB;

const LIMITS = {
  initialJs: 250 * KB,
  // plan §1 originally said 1.0 MB; 23.1.0/23.1.1 measure 1071.4/1071.5 KB
  // gzip, so the budget is 1.1 MB for every version (no per-version exception).
  wasm: 1.1 * MB,
  core: 25 * KB,
  docs: 45 * KB,
};

// The build must ship exactly the versions in tools/versions.json — checking
// only directories that happen to exist would silently pass a partial build.
const expectedVersions = JSON.parse(readFileSync(path.join(ROOT, "tools", "versions.json"), "utf8")).map(
  (entry) => entry.version,
);

const VERSION_DIR = /^\d+\.\d+\.\d+$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`check-size: ${message}`);
  process.exit(1);
}

function display(bytes) {
  return bytes >= MB ? `${(bytes / MB).toFixed(2)} MB` : `${(bytes / KB).toFixed(2)} KB`;
}

function limitLabel(bytes) {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${bytes / KB} KB`;
}

function relative(file) {
  return path.relative(DIST, file).split(path.sep).join("/");
}

const gzipCache = new Map();

function gzipSize(file) {
  const cached = gzipCache.get(file);
  if (cached !== undefined) return cached;
  const bytes = gzipSync(readFileSync(file), { level: 9 }).length;
  gzipCache.set(file, bytes);
  return bytes;
}

function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function versionDirectories(parent) {
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && VERSION_DIR.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareVersions);
}

function attribute(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

/** Maps a URL from dist/index.html onto the built file, tolerating VITE_BASE. */
function resolveDistReference(reference) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith("//")) {
    fail(`dist/index.html references external asset "${reference}"; only local build output can be budgeted`);
  }
  const pathname = decodeURIComponent(reference.split(/[?#]/)[0]);
  const segments = pathname.split("/").filter(Boolean);
  for (let start = 0; start < segments.length; start++) {
    const candidate = path.join(DIST, ...segments.slice(start));
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  fail(`dist/index.html references "${reference}", but no matching file exists under dist/ (stale build?)`);
}

// ---------------------------------------------------------------------------
// Rows: one line per measured asset, plus one aggregate line per budget.
// ---------------------------------------------------------------------------

const rows = [];
const violations = [];

function addRow({ budget, asset, actual, limit, ok, violation }) {
  rows.push({
    budget,
    asset,
    actual,
    limit,
    status: ok === undefined ? "info" : ok ? "ok" : "FAIL",
  });
  if (ok === false) violations.push(violation ?? `${budget}: ${asset} is ${actual} (limit ${limit})`);
}

// ---------------------------------------------------------------------------
// 1. Initial JS: entry module script + modulepreload JS in dist/index.html
// ---------------------------------------------------------------------------

if (!existsSync(DIST)) {
  fail('dist/ is missing; run "npm run build" first');
}

const indexPath = path.join(DIST, "index.html");
if (!existsSync(indexPath)) {
  fail('dist/index.html is missing; run "npm run build" first');
}

const html = readFileSync(indexPath, "utf8");
const scripts = [];
const preloads = [];

for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
  const tag = match[0];
  if (!/\btype\s*=\s*["']?module["']?/i.test(tag)) continue;
  const src = attribute(tag, "src");
  if (src) scripts.push(src);
}

for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
  const tag = match[0];
  const rel = attribute(tag, "rel");
  if (!rel || !rel.toLowerCase().split(/\s+/).includes("modulepreload")) continue;
  const href = attribute(tag, "href");
  if (href) preloads.push(href);
}

if (scripts.length === 0) {
  fail('dist/index.html has no <script type="module" src=...> entry; cannot measure initial JS');
}

const initialFiles = [...new Set([...scripts, ...preloads].map(resolveDistReference))];
const initialSizes = initialFiles.map((file) => ({ file, bytes: gzipSize(file) }));
const initialBytes = initialSizes.reduce((total, entry) => total + entry.bytes, 0);
const initialOk = initialBytes <= LIMITS.initialJs;

if (initialSizes.length === 1) {
  addRow({
    budget: "initial JS",
    asset: relative(initialSizes[0].file),
    actual: display(initialBytes),
    limit: limitLabel(LIMITS.initialJs),
    ok: initialOk,
  });
} else {
  for (const entry of initialSizes) {
    addRow({ budget: "initial JS", asset: relative(entry.file), actual: display(entry.bytes), limit: "", ok: undefined });
  }
  addRow({
    budget: "initial JS",
    asset: `${initialSizes.length} files total`,
    actual: display(initialBytes),
    limit: limitLabel(LIMITS.initialJs),
    ok: initialOk,
  });
}

// ---------------------------------------------------------------------------
// 2. wasm: every dist/wasm/<version>/*.wasm ≤ 1.1 MB gzip
// ---------------------------------------------------------------------------

const wasmRoot = path.join(DIST, "wasm");
const wasmVersions = versionDirectories(wasmRoot);
if (wasmVersions.length === 0) {
  addRow({
    budget: "wasm",
    asset: "dist/wasm/<version>/*.wasm",
    actual: "missing",
    limit: limitLabel(LIMITS.wasm),
    ok: false,
    violation: 'wasm: no dist/wasm/<version>/*.wasm found — run "npm run prepare:wasm" before "npm run build"',
  });
} else {
  for (const version of wasmVersions) {
    const directory = path.join(wasmRoot, version);
    const wasmFiles = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".wasm"))
      .map((entry) => entry.name)
      .sort();
    if (wasmFiles.length === 0) {
      addRow({
        budget: "wasm",
        asset: `wasm/${version}/*.wasm`,
        actual: "missing",
        limit: limitLabel(LIMITS.wasm),
        ok: false,
      });
      continue;
    }
    for (const name of wasmFiles) {
      const file = path.join(directory, name);
      const bytes = gzipSize(file);
      addRow({
        budget: "wasm",
        asset: relative(file),
        actual: display(bytes),
        limit: limitLabel(LIMITS.wasm),
        ok: bytes <= LIMITS.wasm,
      });
    }
  }
  // Every version in tools/versions.json must be in the build; a partial
  // prepare:wasm run would otherwise go unnoticed.
  for (const version of expectedVersions.filter((entry) => !wasmVersions.includes(entry))) {
    addRow({
      budget: "wasm",
      asset: `wasm/${version}/*.wasm`,
      actual: "missing",
      limit: limitLabel(LIMITS.wasm),
      ok: false,
      violation: `wasm: dist/wasm/${version} is missing — tools/versions.json lists ${expectedVersions.length} versions`,
    });
  }
  for (const version of wasmVersions.filter((entry) => !expectedVersions.includes(entry))) {
    addRow({ budget: "wasm", asset: `wasm/${version}/`, actual: "unexpected", limit: "", ok: undefined });
  }
}

// ---------------------------------------------------------------------------
// 3./4. schema: core.json ≤ 25 KB and docs.json ≤ 45 KB gzip per version
// ---------------------------------------------------------------------------

const schemaRoot = path.join(DIST, "schema");
const schemaVersions = versionDirectories(schemaRoot);

if (schemaVersions.length === 0) {
  const staleDist = 'schema: no dist/schema/<version>/ directories found — the schema is committed, so this dist/ looks stale (run "npm run build")';
  addRow({
    budget: "schema core",
    asset: "dist/schema/<version>/core.json",
    actual: "missing",
    limit: limitLabel(LIMITS.core),
    ok: false,
    violation: staleDist,
  });
  addRow({
    budget: "schema docs",
    asset: "dist/schema/<version>/docs.json",
    actual: "missing",
    limit: limitLabel(LIMITS.docs),
    ok: false,
    violation: staleDist,
  });
} else {
  for (const version of schemaVersions) {
    for (const [name, budget, limit] of [
      ["core.json", "schema core", LIMITS.core],
      ["docs.json", "schema docs", LIMITS.docs],
    ]) {
      const file = path.join(schemaRoot, version, name);
      if (!existsSync(file)) {
        addRow({
          budget,
          asset: `schema/${version}/${name}`,
          actual: "missing",
          limit: limitLabel(limit),
          ok: false,
        });
        continue;
      }
      const bytes = gzipSize(file);
      addRow({ budget, asset: relative(file), actual: display(bytes), limit: limitLabel(limit), ok: bytes <= limit });
    }
  }
  for (const version of expectedVersions.filter((entry) => !schemaVersions.includes(entry))) {
    addRow({
      budget: "schema core",
      asset: `schema/${version}/core.json`,
      actual: "missing",
      limit: limitLabel(LIMITS.core),
      ok: false,
      violation: `schema: dist/schema/${version} is missing — tools/versions.json lists ${expectedVersions.length} versions`,
    });
    addRow({
      budget: "schema docs",
      asset: `schema/${version}/docs.json`,
      actual: "missing",
      limit: limitLabel(LIMITS.docs),
      ok: false,
    });
  }
  for (const version of schemaVersions.filter((entry) => !expectedVersions.includes(entry))) {
    addRow({ budget: "schema", asset: `schema/${version}/`, actual: "unexpected", limit: "", ok: undefined });
  }
}

// ---------------------------------------------------------------------------
// Table + verdict
// ---------------------------------------------------------------------------

const headers = ["Budget", "Asset", "Actual (gzip)", "Limit", "Status"];
const widths = [
  Math.max(headers[0].length, ...rows.map((row) => row.budget.length)),
  Math.max(headers[1].length, ...rows.map((row) => row.asset.length)),
  Math.max(headers[2].length, ...rows.map((row) => row.actual.length)),
  Math.max(headers[3].length, ...rows.map((row) => row.limit.length)),
  headers[4].length,
];

function line(cells) {
  return cells.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
}

console.log("gzip budgets from plan.md §1 (level 9)\n");
console.log(line(headers));
console.log(line(widths.map((width) => "-".repeat(width))));
for (const row of rows) {
  console.log(line([row.budget, row.asset, row.actual, row.limit, row.status]));
}

const checked = rows.filter((row) => row.status !== "info").length;
if (violations.length === 0) {
  const wasmCount = rows.filter((row) => row.budget === "wasm" && row.status !== "info").length;
  const schemaCount = rows.filter((row) => row.budget.startsWith("schema")).length;
  console.log(
    `\nsize budget: OK — ${checked} checks passed across ${expectedVersions.length} versions (initial JS ${display(
      initialBytes,
    )} of ${limitLabel(LIMITS.initialJs)}, ${wasmCount} wasm, ${schemaCount} schema files)`,
  );
} else {
  console.error("");
  for (const violation of violations) console.error(`FAIL: ${violation}`);
  console.error(`\nsize budget: FAILED — ${violations.length} violation(s) of ${checked} checks`);
  process.exitCode = 1;
}
