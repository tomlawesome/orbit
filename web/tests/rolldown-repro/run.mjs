#!/usr/bin/env node
/**
 * Manual reproduction runner for #782 (rolldown mis-parses a JSDoc-commented
 * multi-line parameter/argument list in a SvelteKit route file).
 *
 * Not wired into any test runner or CI job on purpose -- it drives the real
 * `vite build` against a scratch route under src/routes, which is slow
 * (whole-app build) and mutates .svelte-kit/output as a side effect. Run it
 * by hand from web/:
 *
 *   node tests/rolldown-repro/run.mjs
 *
 * It copies each fixture in this directory into a throwaway route
 * (src/routes/__rolldown_repro_782__), builds, records pass/fail, and
 * always removes the scratch route again -- including on failure/Ctrl-C via
 * the try/finally below.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..", "..");
const scratchRoute = path.join(webRoot, "src", "routes", "__rolldown_repro_782__");
const vite = path.join(webRoot, "node_modules", ".bin", "vite");

const cases = [
  { file: "passes.svelte", expect: "builds" },
  { file: "fails.svelte", expect: "fails" },
  { file: "const-fails.svelte", expect: "fails" },
];

function build() {
  try {
    execFileSync(vite, ["build"], { cwd: webRoot, stdio: "pipe" });
    return { ok: true };
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    return { ok: false, output };
  }
}

let failures = 0;
for (const { file, expect } of cases) {
  rmSync(scratchRoute, { recursive: true, force: true });
  mkdirSync(scratchRoute, { recursive: true });
  try {
    copyFileSync(path.join(here, file), path.join(scratchRoute, "+page.svelte"));
    rmSync(path.join(webRoot, ".svelte-kit", "output"), { recursive: true, force: true });
    const result = build();
    const gotExpected = expect === "builds" ? result.ok : !result.ok;
    console.log(`${gotExpected ? "OK  " : "MISMATCH"} ${file}: expected to ${expect}, ${result.ok ? "built" : "failed"}`);
    if (!gotExpected) {
      failures += 1;
      if (result.output) console.log(result.output.split("\n").slice(-25).join("\n"));
    }
  } finally {
    rmSync(scratchRoute, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`\n${failures} case(s) did not match the expected outcome.`);
  process.exitCode = 1;
} else {
  console.log("\nAll cases matched the expected outcome (#782 reproduced).");
}
