// Generates public/schema/<version>/{core.json,docs.json}.
//
// Sources:
//   1. the wasm build itself — `dump_config` for the seven presets gives every
//      option key, its nested shape and the per-style default values;
//   2. LLVM's ClangFormatStyleOptions.rst at the matching tag — gives the C++
//      type, enum values and the docstring.
//
// 16.x/17.x builds have no `dump_config`, and the 22.x/23.x builds dump shifted
// values (see plan §3.1). Those versions set `"dump": "native"` in
// tools/versions.json and get their defaults from a native clang-format binary
// of the same release:
//
//   python -m pip install --target .cache/cf-native/<ver> clang-format==<ver>
//   # 22.1.6 / 22.1.7 are not on PyPI; extract the LLVM release there instead:
//   #   .cache/llvm/<ver>/bin/clang-format{.exe}
//
// The schema is committed, so `npm run dev`/`npm run build` never hit the
// network; this script only runs when versions.json changes.
//
//   node tools/gen-schema.mjs                    regenerate public/schema/
//   node tools/gen-schema.mjs --only=21.1.8      regenerate one version
//   node tools/gen-schema.mjs --refresh-rst      ignore the .cache/rst copies
//   node tools/gen-schema.mjs --check            regenerate into .cache/schema-check
//                                                and fail if it differs from the
//                                                committed schema (nightly drift gate)
//   node tools/gen-schema.mjs --check --allow-missing-native
//                                                nightly mode: versions whose native
//                                                binary is not available are skipped
//                                                for defaults, but their docs/enum
//                                                tables are still re-verified from RST
//   node tools/gen-schema.mjs --out=<dir>        write somewhere else (keeps
//                                                public/schema untouched)

import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { escapeHtml, inline, parseRst, renderDoc } from "./lib/rst.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_SCHEMA = path.join(ROOT, "public", "schema");
const STYLES = ["LLVM", "Google", "Chromium", "Mozilla", "WebKit", "Microsoft", "GNU"];
const RST_URL = (tag) =>
  `https://raw.githubusercontent.com/llvm/llvm-project/${tag}/clang/docs/ClangFormatStyleOptions.rst`;
// Native executable name; pip installs both a launcher under bin/ and the real
// binary under clang_format/data/bin/ — only the latter runs without PYTHONPATH.
const NATIVE_EXE = process.platform === "win32" ? "clang-format.exe" : "clang-format";

// Options whose item shape cannot be inferred from a dumped value: the default
// list is non-empty only for IncludeCategories, and empty lists carry no keys.
const STRUCT_LISTS = {
  IncludeCategories: [
    { key: "Regex", type: { kind: "scalar", scalar: "string" } },
    { key: "Priority", type: { kind: "scalar", scalar: "int" } },
    { key: "SortPriority", type: { kind: "scalar", scalar: "int" } },
    { key: "CaseSensitive", type: { kind: "scalar", scalar: "bool" } },
  ],
  RawStringFormats: [
    { key: "Language", type: { kind: "enum", values: [] } },
    { key: "Delimiters", type: { kind: "list", item: "string" } },
    { key: "EnclosingFunctions", type: { kind: "list", item: "string" } },
    { key: "CanonicalDelimiter", type: { kind: "scalar", scalar: "string" } },
    { key: "BasedOnStyle", type: { kind: "enum", values: STYLES } },
  ],
};

const args = process.argv.slice(2);
const check = args.includes("--check");
const only = args.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);
const outArg = args.find((arg) => arg.startsWith("--out="))?.slice("--out=".length);
// Nightly drift check (plan §8.1.3): the 26 native-dump versions need a native
// clang-format of the same release, and 22.1.6/22.1.7 would need a 862 MB LLVM
// release download in CI. --allow-missing-native skips the native *defaults*
// for those versions, but still re-fetches their RST and byte-compares the
// generated docs/enum tables against the committed docs.json, and checks that
// the documented option set still matches. Only meaningful with --check.
const allowMissingNative = check && args.includes("--allow-missing-native");
// --check refreshes the RST cache so docstring drift in an upstream tag is also
// caught (tags are immutable in practice, but the nightly gate should be able
// to prove it).
const refreshRst = args.includes("--refresh-rst") || check;
const outRoot = outArg
  ? path.resolve(ROOT, outArg)
  : check
    ? path.join(ROOT, ".cache", "schema-check")
    : PUBLIC_SCHEMA;

const warnings = [];
const warn = (message) => warnings.push(message);

function scalarFromCpp(cppType) {
  const type = (cppType ?? "").replace(/^std::/, "").trim();
  if (type === "bool") return { kind: "scalar", scalar: "bool" };
  if (type === "int" || type === "int32_t" || type === "int64_t") {
    return { kind: "scalar", scalar: "int" };
  }
  if (type === "unsigned" || type === "unsigned int" || type === "size_t" || type === "uint32_t") {
    return { kind: "scalar", scalar: "uint" };
  }
  if (type === "string") return { kind: "scalar", scalar: "string" };
  return null;
}

function typeFromValue(value) {
  if (typeof value === "boolean") return { kind: "scalar", scalar: "bool" };
  if (typeof value === "number") {
    return { kind: "scalar", scalar: value < 0 ? "int" : "uint" };
  }
  if (Array.isArray(value)) return { kind: "list", item: "string" };
  return { kind: "scalar", scalar: "string" };
}

function fieldType(field, value) {
  if (field?.enumValues?.length) {
    return { kind: "enum", values: field.enumValues.map((entry) => entry.value) };
  }
  return scalarFromCpp(field?.cppType) ?? typeFromValue(value);
}

function structList(key, rst) {
  const language = rst.get("Language");
  return STRUCT_LISTS[key].map((field) => {
    if (field.key !== "Language" || !language?.enumValues?.length) return field;
    return { key: field.key, type: { kind: "enum", values: language.enumValues.map((v) => v.value) } };
  });
}

// The RST uses human-readable type names, not C++ types.
const RST_SCALARS = {
  Boolean: "bool",
  Integer: "int",
  Unsigned: "uint",
  String: "string",
};

function typeFromRst(rstType, key, rstMap) {
  const type = (rstType ?? "").trim();
  if (RST_SCALARS[type]) return { kind: "scalar", scalar: RST_SCALARS[type] };
  if (type.startsWith("List of ")) {
    if (STRUCT_LISTS[key]) {
      return { kind: "list", item: "struct", fields: structList(key, rstMap) };
    }
    return { kind: "list", item: "string" };
  }
  return null;
}

function optionType(key, parsed, sample, rstMap) {
  if (sample !== undefined && sample !== null && typeof sample === "object" && !Array.isArray(sample)) {
    const children = Object.entries(sample).map(([childKey, value]) => ({
      key: childKey,
      type: fieldType(
        parsed?.fields?.find((field) => field.name === childKey),
        value,
      ),
    }));
    return { kind: "map", children };
  }
  if (Array.isArray(sample) || (parsed?.cppType ?? "").startsWith("List of ")) {
    return typeFromRst(parsed?.cppType, key, rstMap) ?? { kind: "list", item: "string" };
  }
  if (parsed?.enumValues?.length) {
    return { kind: "enum", values: parsed.enumValues.map((entry) => entry.value) };
  }
  return (
    typeFromRst(parsed?.cppType, key, rstMap) ?? scalarFromCpp(parsed?.cppType) ?? typeFromValue(sample)
  );
}

function enumTable(parsed) {
  if (!parsed?.enumValues?.length) return "";
  const rows = parsed.enumValues
    .map(
      (entry) =>
        `<tr><td><code>${escapeHtml(entry.value)}</code></td><td>${inline(entry.description)}</td></tr>`,
    )
    .join("");
  return `<table class="enum-values"><thead><tr><th>Value</th><th>Meaning</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// dump-config output cannot be trusted blindly: the 22.1.x/23.1.x builds
// emit shifted values (e.g. `AlignAfterOpenBracket: true`, a bool, and
// `Cpp11BracedListStyle: AlignFirstComment`, an enum). Comparing every
// dumped default against the RST-derived type turns that into a build error
// instead of a silently wrong schema.
function validateValue(type, value, path, errors) {
  if (value === undefined) return;
  if (type.kind === "scalar") {
    const ok =
      (type.scalar === "bool" && typeof value === "boolean") ||
      ((type.scalar === "int" || type.scalar === "uint") && typeof value === "number") ||
      (type.scalar === "string" && typeof value === "string");
    if (!ok) errors.push(`${path}: expected ${type.scalar}, got ${JSON.stringify(value)}`);
    return;
  }
  if (type.kind === "enum") {
    // clang-format accepts enum names case-insensitively and dumps
    // `RawStringFormats[].BasedOnStyle` in lowercase.
    const matches =
      typeof value === "string" &&
      (type.values.length === 0 || type.values.some((entry) => entry.toLowerCase() === value.toLowerCase()));
    if (!matches) {
      errors.push(`${path}: ${JSON.stringify(value)} is not one of [${type.values.join(", ")}]`);
    }
    return;
  }
  if (type.kind === "list") {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected a list, got ${JSON.stringify(value)}`);
      return;
    }
    if (type.item === "struct") {
      value.forEach((item, index) => {
        if (item === null || typeof item !== "object") {
          errors.push(`${path}[${index}]: expected an object`);
          return;
        }
        for (const field of type.fields) validateValue(field.type, item[field.key], `${path}[${index}].${field.key}`, errors);
      });
    }
    return;
  }
  if (type.kind === "map") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path}: expected a mapping, got ${JSON.stringify(value)}`);
      return;
    }
    for (const child of type.children) {
      validateValue(child.type, value[child.key], `${path}.${child.key}`, errors);
    }
  }
}

function locateNative(version) {
  const candidates = [
    path.join(ROOT, ".cache", "cf-native", version, "clang_format", "data", "bin", NATIVE_EXE),
    path.join(ROOT, ".cache", "llvm", version, "bin", NATIVE_EXE),
    path.join(ROOT, ".cache", "cf-native", version, "bin", NATIVE_EXE),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function runNative(binary, binaryArgs, label) {
  const result = spawnSync(binary, binaryArgs, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim().slice(0, 500);
    throw new Error(`${label}: native clang-format exited ${result.status}${stderr ? `: ${stderr}` : ""}`);
  }
  return result.stdout;
}

function loadNativeDumps(entry) {
  const binary = locateNative(entry.version);
  if (!binary) {
    throw new Error(
      `${entry.version}: no native clang-format found (versions.json marks it dump=native). ` +
        `Install it with "python -m pip install --target .cache/cf-native/${entry.version} ` +
        `clang-format==${entry.version}"; 22.1.6/22.1.7 have no PyPI wheel, extract the matching ` +
        `LLVM release to .cache/llvm/${entry.version} instead.`,
    );
  }
  const build = runNative(binary, ["--version"], `${entry.version} --version`).trim();
  const dumps = {};
  for (const style of STYLES) {
    const text = runNative(
      binary,
      [`--style=${style}`, "--assume-filename=main.cc", "--dump-config"],
      `${entry.version}/${style} --dump-config`,
    );
    const parsed = parseYaml(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`${entry.version}/${style}: native dump-config returned no YAML`);
    }
    delete parsed.Language;
    delete parsed.BasedOnStyle;
    dumps[style] = parsed;
  }
  return { dumps, version: build };
}

async function loadWasmDumps(version) {
  const entry = path.join(ROOT, "public", "wasm", version, "entry.js");
  const wasm = path.join(ROOT, "public", "wasm", version, "clang-format.wasm");
  if (!existsSync(entry) || !existsSync(wasm)) {
    throw new Error(`${version}: wasm assets missing, run fetch-wasm first`);
  }
  const mod = await import(pathToFileURL(entry).href);
  await mod.default(await readFile(wasm));
  if (typeof mod.dump_config !== "function") {
    throw new Error(
      `${version}: this build has no dump_config export (clang-format < 18); ` +
        'add "dump": "native" to its tools/versions.json row',
    );
  }

  const dumps = {};
  for (const style of STYLES) {
    const text = mod.dump_config({ style, filename: "main.cc", code: "" });
    const parsed = parseYaml(text);
    if (!parsed || typeof parsed !== "object") throw new Error(`${version}/${style}: dump_config returned no YAML`);
    delete parsed.Language;
    dumps[style] = parsed;
  }
  return { dumps, version: mod.version?.() ?? version };
}

async function loadDumps(entry) {
  return entry.dump === "native" ? loadNativeDumps(entry) : loadWasmDumps(entry.version);
}

async function loadRst(tag) {
  const cacheDir = path.join(ROOT, ".cache", "rst");
  const cache = path.join(cacheDir, `${tag}.rst`);
  if (existsSync(cache) && !refreshRst) return readFile(cache, "utf8");
  const response = await fetch(RST_URL(tag));
  if (!response.ok) throw new Error(`RST ${response.status} for ${tag}`);
  const text = await response.text();
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cache, text);
  return text;
}

async function generate(entry) {
  const { dumps, version: buildVersion } = await loadDumps(entry);

  let rst = new Map();
  let docsMissing = false;
  try {
    rst = parseRst(await loadRst(entry.tag));
  } catch (error) {
    docsMissing = true;
    warn(`${entry.version}: RST unavailable (${error.message}), types fall back to dump values`);
  }

  const union = new Set();
  for (const style of STYLES) for (const key of Object.keys(dumps[style])) union.add(key);

  const order = [...rst.keys()].filter((key) => key !== "BasedOnStyle" && key !== "Language");
  for (const key of [...union].sort()) {
    if (!order.includes(key) && key !== "BasedOnStyle" && key !== "Language") order.push(key);
  }

  const options = [];
  const docs = {};
  const errors = [];
  for (const key of order) {
    const parsed = rst.get(key);
    const sample = STYLES.map((style) => dumps[style][key]).find((value) => value !== undefined);
    const type = optionType(key, parsed, sample, rst);

    const defaults = {};
    for (const style of STYLES) {
      const value = dumps[style][key];
      if (value !== undefined) defaults[style] = value;
      else if (!parsed?.deprecated && type.kind === "list") defaults[style] = [];
    }

    const deprecated = parsed?.deprecated ?? false;
    if (sample === undefined && !deprecated && type.kind !== "list") {
      warn(`${entry.version}/${key}: no default value in dump-config`);
    }

    for (const style of STYLES) {
      validateValue(type, defaults[style], `${key}/${style}`, errors);
    }

    options.push({ key, type, deprecated, defaults });

    if (parsed) {
      const html = [renderDoc(parsed.docLines), enumTable(parsed)].filter(Boolean).join("\n");
      if (html) docs[key] = html;
    }
  }

  const core = {
    version: entry.version,
    build: buildVersion,
    tag: entry.tag,
    styles: STYLES,
    options,
  };

  if (errors.length) {
    const sample = errors.slice(0, 8).map((error) => `  - ${error}`).join("\n");
    throw new Error(
      `${entry.version}: dump-config does not match the documented option types ` +
        `(${errors.length} mismatch(es)):\n${sample}`,
    );
  }

  const dir = path.join(outRoot, entry.version);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "core.json"), `${JSON.stringify(core, null, 2)}\n`);
  await writeFile(path.join(dir, "docs.json"), `${JSON.stringify(docs, null, 2)}\n`);

  const deprecated = options.filter((option) => option.deprecated).length;
  const kinds = options.reduce((acc, option) => {
    acc[option.type.kind] = (acc[option.type.kind] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `  ${entry.version}  ${options.length} options (${Object.entries(kinds)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(", ")}), ${deprecated} deprecated, ${docsMissing ? "docs MISSING" : `${Object.keys(docs).length} docs`}`,
  );

  return { version: entry.version, options: options.length };
}

async function listFiles(root) {
  const files = [];
  async function walk(dir, prefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  await walk(root, "");
  return files.sort();
}

const versions = JSON.parse(await readFile(path.join(ROOT, "tools", "versions.json"), "utf8"));
if (versions.some((entry) => !entry.version || !entry.tag || !entry.pkg)) {
  throw new Error("tools/versions.json: every row needs version, tag and pkg");
}
const selected = only ? versions.filter((v) => v.version === only) : versions;
if (selected.length === 0) throw new Error(`no version matched --only=${only}`);

if (check) {
  await rm(outRoot, { recursive: true, force: true });
  console.log(`gen-schema: --check — regenerating into ${path.relative(ROOT, outRoot)}`);
}
await mkdir(outRoot, { recursive: true });

console.log(`gen-schema: ${selected.length} version(s)`);
const index = [];
const skipped = [];
for (const entry of selected) {
  if (entry.dump === "native" && allowMissingNative && !locateNative(entry.version)) {
    skipped.push(entry);
    continue;
  }
  index.push(await generate(entry));
}

// Docs-only verification for versions whose native binary is unavailable: the
// committed core.json/docs.json are regenerated from the RST tag alone (option
// set, order, docstrings, enum tables), so upstream doc drift still fails the
// gate without downloading a native toolchain.
const skippedDrift = [];
for (const entry of skipped) {
  const corePath = path.join(PUBLIC_SCHEMA, entry.version, "core.json");
  const docsPath = path.join(PUBLIC_SCHEMA, entry.version, "docs.json");
  if (!existsSync(corePath) || !existsSync(docsPath)) {
    skippedDrift.push(`${entry.version}: committed schema is missing, cannot verify without native dump`);
    continue;
  }
  const core = JSON.parse(await readFile(corePath, "utf8"));
  const committedDocs = await readFile(docsPath, "utf8");
  const rst = parseRst(await loadRst(entry.tag));
  const regenerated = {};
  for (const option of core.options ?? []) {
    const parsed = rst.get(option.key);
    if (!parsed) continue;
    const html = [renderDoc(parsed.docLines), enumTable(parsed)].filter(Boolean).join("\n");
    if (html) regenerated[option.key] = html;
  }
  const expected = `${JSON.stringify(regenerated, null, 2)}\n`;
  if (expected !== committedDocs) {
    skippedDrift.push(`${entry.version}: docs.json drifted against tag ${entry.tag} (native defaults not verified)`);
  }
  const known = new Set((core.options ?? []).map((option) => option.key));
  for (const [key, parsed] of rst) {
    if (key === "BasedOnStyle" || key === "Language" || parsed.deprecated) continue;
    if (!known.has(key)) {
      skippedDrift.push(`${entry.version}: RST documents ${key} but the committed schema has no such option`);
    }
  }
  console.log(`  ${entry.version}  skipped-native (docs/enum tables verified against ${entry.tag})`);
}

// The app reads index.json to know which versions exist without importing
// build tooling. The list leads with the newest release, and that same newest
// build is the preselected `default` (so shipping a version makes it the
// default) and the dropdown row labelled `latest`.
const compareVersionsDesc = (a, b) => {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

const available = [];
for (const entry of versions) {
  const generated = index.find((item) => item.version === entry.version);
  if (generated) {
    available.push(generated);
    continue;
  }
  // --only/--check regenerate a subset; reuse whatever is already committed.
  const core = [path.join(outRoot, entry.version, "core.json"), path.join(PUBLIC_SCHEMA, entry.version, "core.json")]
    .filter(existsSync)
    .at(0);
  if (!core) continue;
  try {
    const parsed = JSON.parse(await readFile(core, "utf8"));
    available.push({ version: entry.version, options: Array.isArray(parsed.options) ? parsed.options.length : 0 });
  } catch {
    continue;
  }
}
available.sort((a, b) => compareVersionsDesc(a.version, b.version));
const newest = available[0]?.version ?? null;
await writeFile(
  path.join(outRoot, "index.json"),
  `${JSON.stringify(
    { default: newest, latest: newest, versions: available },
    null,
    2,
  )}\n`,
);

if (warnings.length) {
  console.log(`gen-schema: ${warnings.length} warning(s)`);
  const verbose = args.includes("--verbose-warnings");
  for (const warning of warnings.slice(0, verbose ? warnings.length : 20)) console.log(`  - ${warning}`);
  if (!verbose && warnings.length > 20) console.log(`  ... ${warnings.length - 20} more`);
}

if (check) {
  const diffs = [];
  for (const relative of await listFiles(outRoot)) {
    const committed = path.join(PUBLIC_SCHEMA, relative);
    if (!existsSync(committed)) {
      diffs.push(`added: ${relative}`);
      continue;
    }
    const [generated, existing] = await Promise.all([
      readFile(path.join(outRoot, relative)),
      readFile(committed),
    ]);
    if (!generated.equals(existing)) diffs.push(`changed: ${relative}`);
  }
  const generatedVersions = new Set(
    readdirSync(outRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  for (const entry of skipped) generatedVersions.add(entry.version);
  for (const entry of readdirSync(PUBLIC_SCHEMA, { withFileTypes: true })) {
    if (entry.isDirectory() && !generatedVersions.has(entry.name)) diffs.push(`removed: ${entry.name}/`);
  }
  const failures = [...diffs, ...skippedDrift];
  if (skipped.length) {
    console.log(
      `gen-schema: --check skipped-native for ${skipped.length} version(s) ` +
        `(docs/enum tables were still verified): ${skipped.map((entry) => entry.version).join(", ")}`,
    );
  }
  if (failures.length) {
    console.error(`gen-schema: --check FAILED — committed schema drifted (${failures.length} problem(s))`);
    for (const failure of failures.slice(0, 40)) console.error(`  ${failure}`);
    if (failures.length > 40) console.error(`  ... ${failures.length - 40} more`);
    process.exitCode = 1;
  } else {
    console.log("gen-schema: --check OK — committed schema matches a fresh regeneration");
  }
}
