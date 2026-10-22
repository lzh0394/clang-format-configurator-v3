// Generates public/schema/<version>/{core.json,docs.json}.
//
// Sources:
//   1. the wasm build itself — `dump_config` for the seven presets gives every
//      option key, its nested shape and the per-style default values;
//   2. LLVM's ClangFormatStyleOptions.rst at the matching tag — gives the C++
//      type, enum values and the docstring.
//
// The schema is committed, so `npm run dev`/`npm run build` never hit the
// network; this script only runs when versions.json changes.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { escapeHtml, inline, parseRst, renderDoc } from "./lib/rst.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STYLES = ["LLVM", "Google", "Chromium", "Mozilla", "WebKit", "Microsoft", "GNU"];
const RST_URL = (tag) =>
  `https://raw.githubusercontent.com/llvm/llvm-project/${tag}/clang/docs/ClangFormatStyleOptions.rst`;

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
const refreshRst = args.includes("--refresh-rst");
const only = args.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);

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

// dump_config output cannot be trusted blindly: the 22.1.x/23.1.x builds
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

async function loadDumps(version) {
  const entry = path.join(ROOT, "public", "wasm", version, "entry.js");
  const wasm = path.join(ROOT, "public", "wasm", version, "clang-format.wasm");
  if (!existsSync(entry) || !existsSync(wasm)) {
    throw new Error(`${version}: wasm assets missing, run fetch-wasm first`);
  }
  const mod = await import(pathToFileURL(entry).href);
  await mod.default(await readFile(wasm));
  if (typeof mod.dump_config !== "function") {
    throw new Error(`${version}: this build has no dump_config export (clang-format < 18)`);
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
  const { dumps, version: buildVersion } = await loadDumps(entry.version);

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

  const dir = path.join(ROOT, "public", "schema", entry.version);
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

const versions = JSON.parse(await readFile(path.join(ROOT, "tools", "versions.json"), "utf8"));
const selected = only ? versions.filter((v) => v.version === only) : versions;
if (selected.length === 0) throw new Error(`no version matched --only=${only}`);

console.log(`gen-schema: ${selected.length} version(s)`);
const index = [];
for (const entry of selected) index.push(await generate(entry));

// The app reads index.json to know which versions exist without importing
// build tooling.
const schemaRoot = path.join(ROOT, "public", "schema");
await mkdir(schemaRoot, { recursive: true });
const available = versions
  .filter((entry) => existsSync(path.join(schemaRoot, entry.version, "core.json")))
  .map((entry) => index.find((item) => item.version === entry.version) ?? { version: entry.version, options: 0 });
await writeFile(
  path.join(schemaRoot, "index.json"),
  `${JSON.stringify({ default: available[0]?.version ?? null, versions: available }, null, 2)}\n`,
);

if (warnings.length) {
  console.log(`gen-schema: ${warnings.length} warning(s)`);
  for (const warning of warnings.slice(0, 20)) console.log(`  - ${warning}`);
  if (warnings.length > 20) console.log(`  ... ${warnings.length - 20} more`);
}
