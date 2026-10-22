// Runs the whole asset pipeline: wasm binaries + option schema.
//
//   node tools/prepare-assets.mjs             # everything, skipping cached work
//   node tools/prepare-assets.mjs --refresh-rst
//   node tools/prepare-assets.mjs --only=21.1.8

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const passThrough = process.argv.slice(2);

function run(script) {
  console.log(`\n> node tools/${script} ${passThrough.join(" ")}`.trimEnd());
  const result = spawnSync(process.execPath, [path.join(here, script), ...passThrough], {
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("fetch-wasm.mjs");
run("gen-schema.mjs");
console.log("\nprepare-assets: done");
