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
 * #1130 bisected two more members of the same family, found on
 * `feature/phone-layouts` (#1120) and fixed there in commit fe454eea: a
 * `$props.id()` call, and a `{#snippet}` declared in the markup, EACH
 * crash whenever an earlier top-level JSDoc comment has already closed
 * somewhere in the same `<script>` -- not because of anything about that
 * comment's own content or position, but because Svelte hoists the
 * compiled `$props.id()` declaration, or the `{#snippet}`, and drags the
 * earlier comment into a spot rolldown cannot parse. `props-id-fails.svelte`
 * and `snippet-hoist-fails.svelte` reproduce each in isolation; moving the
 * comment (or, for `$props.id()`, moving the call to be first, per the
 * real fix on Sheet.svelte/Hatch.svelte) avoids it.
 *
 * #1130's THIRD named shape -- a multi-line `@type` JSDoc comment directly
 * above `$props()`, independent of `$props.id()` -- was tried repeatedly
 * (the exact pre-fix content of web/src/lib/pocket/NorthStar.svelte and
 * TopChrome.svelte, standalone, plus several trimmed variants) and never
 * reproduced: every attempt built cleanly. The real files that shape was
 * bisected from also called `$props.id()`, which is enough on its own (see
 * above); the multi-line comment itself does not appear to be a fourth
 * distinct trap, so there is no fixture for it here.
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
 * on failure/Ctrl-C, via the signal trap below (W3-S2, #1151). Exits
 * non-zero if any case did not match its expectation.
 */
import { spawn } from "node:child_process";
import { mkdirSync, copyFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..", "..");
const scratchRoute = path.join(webRoot, "src", "routes", "__rolldown_repro_782__");
const vite = path.join(webRoot, "node_modules", ".bin", "vite");

/* W3-S2 (#1151): overridable only by run.sigint.test.mjs, this script's own
   test that a Ctrl-C is actually cleaned up -- it cannot drive the real
   three-minute `vite build`, three times over, just to prove a signal
   handler fires, so it substitutes a slow, fake build step instead.
   Ordinary use (by hand, or from anywhere else) never sets these, and
   always builds for real. */
const buildCommand = process.env.ROLLDOWN_REPRO_BUILD_CMD ?? vite;
const buildArgs = process.env.ROLLDOWN_REPRO_BUILD_ARGS?.split(" ") ?? ["build"];

const cases = [
  { file: "passes.svelte", expect: "builds" },
  { file: "fails.svelte", expect: "fails" },
  { file: "const-fails.svelte", expect: "fails" },
  { file: "props-id-fails.svelte", expect: "fails" },
  { file: "snippet-hoist-fails.svelte", expect: "fails" },
];

/* W3-S2 (#1151): async, never execFileSync/spawnSync. Node cannot run a
   signal handler while it is blocked inside a synchronous child-process
   call -- confirmed directly: a SIGINT sent mid-execFileSync is not
   delivered to process.on("SIGINT", ...) until the sync call returns. A
   build that took the full three minutes would make Ctrl-C wait the same
   three minutes before the handler below ever ran, leaving the scratch
   route exposed to exactly the interruption it is meant to survive. */
let currentChild = null;
function build() {
  return new Promise((resolve) => {
    const child = spawn(buildCommand, buildArgs, { cwd: webRoot });
    currentChild = child;
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => { currentChild = null; resolve({ ok: false, output: String(error) }); });
    child.on("close", (code) => { currentChild = null; resolve({ ok: code === 0, output }); });
  });
}

/* W3-S2 (#1151): the try/finally below only ever protected against a
   thrown JS exception, never against the whole process being killed by
   Ctrl-C -- Node's default SIGINT disposition, with no handler registered,
   terminates the process immediately without unwinding the call stack
   through that finally at all, so the scratch route it had just created
   was left behind in the real project tree. Trapping the signal explicitly
   is what actually keeps the guarantee this file's own header documents. */
let cleaningUp = false;
function cleanUpAndExit(code) {
  if (cleaningUp) return;
  cleaningUp = true;
  const finish = () => {
    rmSync(scratchRoute, { recursive: true, force: true });
    process.exit(code);
  };
  if (!currentChild) {
    finish();
    return;
  }
  // RANGE-S8 (#1151): wait for the build child to actually close before
  // removing the scratch route it may still be reading, rather than
  // racing it. The timeout is a bound, not the normal path -- SIGTERM
  // should finish it well inside 5s.
  currentChild.once("close", finish);
  currentChild.kill("SIGTERM");
  setTimeout(finish, 5000).unref();
}
process.on("SIGINT", () => cleanUpAndExit(130));
process.on("SIGTERM", () => cleanUpAndExit(143));

let failures = 0;
for (const { file, expect } of cases) {
  rmSync(scratchRoute, { recursive: true, force: true });
  mkdirSync(scratchRoute, { recursive: true });
  try {
    copyFileSync(path.join(here, file), path.join(scratchRoute, "+page.svelte"));
    rmSync(path.join(webRoot, ".svelte-kit", "output"), { recursive: true, force: true });
    const result = await build();
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
