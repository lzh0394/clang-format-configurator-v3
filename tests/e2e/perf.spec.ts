import { expect, test } from "@playwright/test";

import { openApp } from "./helpers";

// plan §1 performance budgets:
//   - option change -> new formatted result: p95 <= 80 ms for 20 KB of code
//   - cold version switch <= 1.2 s; re-selecting an already-cached version <= 200 ms
//
// These run against the production preview (real wasm, real worker), but they
// measure in-page work only: the format calls run directly in the page and the
// version switch is timed from the select event to "ready + formatted output".
// A single retry is allowed because the suite runs other wasm-heavy tests in
// parallel; the budgets themselves are not relaxed.

test.describe.configure({ retries: 1 });

const VERSION_SWITCH_COLD_BUDGET_MS = 1_200;
const VERSION_SWITCH_CACHED_BUDGET_MS = 200;

test("wasm format() p95 stays under 80 ms for ~20 KB of source", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);

  const measurement = await page.evaluate(async () => {
    type WasmModule = {
      default: () => Promise<unknown>;
      format: (content: string, filename?: string, style?: string) => string;
    };
    const url = new URL("wasm/21.1.8/entry.js", document.baseURI).href;
    const module = (await import(url)) as WasmModule;
    await module.default();

    const unit = [
      "struct Widget {",
      "  int id;",
      "  const char* name;",
      "};",
      "int compute(Widget* w, int scale) {",
      "  if (w->id > 0) { return (w->id + scale) * 2; }",
      "  return scale;",
      "}",
      "",
    ].join("\n");
    let code = "";
    while (code.length < 20 * 1024) code += unit;
    code = code.slice(0, 20 * 1024);

    const style = JSON.stringify({ BasedOnStyle: "LLVM", ColumnLimit: 80, IndentWidth: 2 });
    // Warm-up: first calls include lazy wasm/JIT work we do not want to measure.
    for (let index = 0; index < 5; index += 1) module.format(code, "perf.cpp", style);

    const samples: number[] = [];
    for (let index = 0; index < 25; index += 1) {
      const started = performance.now();
      module.format(code, "perf.cpp", style);
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    // Nearest-rank p95 for 25 samples (index 23).
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    return {
      bytes: code.length,
      samples: samples.length,
      p95,
      median: samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY,
      min: samples[0] ?? Number.POSITIVE_INFINITY,
      max: samples[samples.length - 1] ?? Number.POSITIVE_INFINITY,
    };
  });

  console.log(
    `perf: ${measurement.samples} formats of ${measurement.bytes} B -> p95 ${measurement.p95.toFixed(1)} ms ` +
      `(median ${measurement.median.toFixed(1)} ms, min ${measurement.min.toFixed(1)} ms, max ${measurement.max.toFixed(1)} ms)`,
  );

  expect(measurement.bytes).toBe(20 * 1024);
  expect(measurement.samples).toBe(25);
  expect(measurement.p95).toBeLessThan(80);
});

test("version switch meets the cold and cached budgets", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);

  /** Time from selecting a version until it is ready AND the output is formatted. */
  const switchTo = async (version: string): Promise<number> => {
    const started = Date.now();
    await page.getByLabel("Version").selectOption(version);
    await page.waitForFunction(
      (expectedVersion: string) => {
        const status = document.querySelector('[data-testid="status"]')?.textContent ?? "";
        const output = document.querySelector('[data-testid="output"]');
        const text = output
          ? Array.from(output.querySelectorAll(".cm-line"), (line) => line.textContent).join("\n")
          : "";
        return status.includes(`clang-format ${expectedVersion} ready`) && text.includes("class Widget {");
      },
      version,
      { polling: 10, timeout: 60_000 },
    );
    return Date.now() - started;
  };

  // 21.1.8 is what the page loaded with; 18.1.8 has to be fetched + compiled.
  const cold = await switchTo("18.1.8");
  const back = await switchTo("21.1.8");
  // Switching to a version that has already been loaded is the cached case.
  const cached = await switchTo("18.1.8");

  console.log(`version switch: cold ${cold} ms, back ${back} ms, cached ${cached} ms`);

  expect(cold).toBeLessThan(VERSION_SWITCH_COLD_BUDGET_MS);
  expect(cached).toBeLessThan(VERSION_SWITCH_CACHED_BUDGET_MS);
});
