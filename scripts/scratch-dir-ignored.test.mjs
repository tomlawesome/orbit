/**
 * `tmp/` is ignored by every gate that would otherwise read it (#995).
 *
 * AGENTS.md and the extraction handoffs send agents to `tmp/` to prototype,
 * and it is gitignored, so the files there are both expected to exist and
 * expected to rot: they import modules that have since been refactored. While
 * the gates read them, doing what the instructions say broke the fast suite
 * for the next session — which then read a failure naming a scratch file and
 * had to work out that nothing was actually wrong. CI never saw it, because
 * `tmp/` is untracked, so it could sit broken for days.
 *
 * Asserted against the configuration files rather than by running the gates:
 * this has to hold on a checkout with an empty `tmp/`, where running them
 * would prove nothing at all.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (relative) => readFileSync(`${root}${relative}`, "utf8");

test("tsconfig does not typecheck the scratch directory", () => {
  const tsconfig = JSON.parse(read("tsconfig.json"));
  assert.ok(
    tsconfig.exclude.includes("tmp"),
    'tsconfig.json must exclude "tmp": it includes **/*.ts, so a rotted scratch prototype fails `pnpm typecheck`, which is the first step of scripts/test-backend.sh.',
  );
});

test("eslint does not lint the scratch directory", () => {
  assert.match(
    read("eslint.config.mjs"),
    /"tmp\/\*\*"/u,
    'eslint.config.mjs must ignore "tmp/**", for the same reason tsconfig excludes it.',
  );
});

test("vitest does not collect tests from the scratch directory", () => {
  assert.match(
    read("vitest.config.ts"),
    /"tmp\/\*\*"/u,
    'vitest.config.ts must exclude "tmp/**": a scratch *.test.ts left there is collected and run like any other.',
  );
});
