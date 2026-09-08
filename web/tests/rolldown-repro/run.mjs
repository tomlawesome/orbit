#!/usr/bin/env node
/**
 * Reproduction runner for #782: rolldown's builtin `vite-dynamic-import-vars`
 * plugin mis-parses a JSDoc `/** ... *\/` block comment sitting inside a
 * multi-line, comma-separated parameter or call-argument list -- an arrow
 * function's own parameters, or the arguments of a call on the right of a
 * `{@const ...}` -- inside a SvelteKit route file. `svelte-check` and
 * `vite dev` both accept the same file; only the production build
 * (`vite build`, which bundles through rolldown) crashes, with an opaque
 * "Unexpected token" and often no useful file/line pointer.
 *
 * Reproduced against the versions pinned in pnpm-lock.yaml at the time of
 * writing: rolldown@1.2.4, vite@8.2.2, @sveltejs/vite-plugin-svelte@7.3.0,
 * svelte@5.57.0. Closest known upstream report: vitejs/vite#21855 (comments
 * inside a dynamic import() breaking the same plugin) -- that one silently
 * skips the transform rather than crashing the build, so it documents the
 * same plugin misbehaving on comments rather than confirming this exact
 * PARSE_ERROR shape.
 *
 * `fails.svelte` and `const-fails.svelte` reproduce the crash; `passes.svelte`
 * is the same code with the two comments removed, as a control. A third
 * shape -- a JSDoc comment on a `{#snippet}` parameter, as documented beside
 * `mark` in web/src/routes/household/[id]/+page.svelte -- reproduces inside
 * that full file (confirmed directly: reintroducing a plain `@type`
 * annotation there still fails `pnpm --filter orbit-web build`) but does not
 * reduce to a small standalone fixture the way the other two do -- the same
 * single-comment snippet parameter, alone or copied into a scratch route,
 * builds cleanly. Whatever the plugin's exact trigger condition is, it is
 * not purely local to that shape's own syntax, so there is no fourth
 * fixture here for it.
 *
 * This drives the real `vite build` against a scratch SvelteKit route,
 * which is slow (a whole-app build, three times) and mutates
 * .svelte-kit/output as a side effect -- not wired into the fast suite on
 * purpose. Run it by hand from web/:
 *
 *   node tests/rolldown-repro/run.mjs
 *
 * It copies each fixture in this directory into a throwaway route
 * (src/routes/__rolldown_repro_782__), builds, records pass/fail against
 * the expectation, and always removes the scratch route again -- including
 * on failure/Ctrl-C via the try/finally below. Exits non-zero if any case
 * did not match its expectation.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, rmSync } from "node:fs";
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
