import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * The changed-run tier (#1934, ruling in note 68442): the script reads changed
 * paths on stdin, one per line, and prints one word: `whole` (every test),
 * `unit` (the --changed selection plus all of tests/unit/) or `changed`.
 * The strongest tier wins.
 */

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/ci/changed-test-tier.sh");

function tierOf(paths) {
  const result = spawnSync("bash", [SCRIPT], {
    input: paths.length ? `${paths.join("\n")}\n` : "",
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

const CASES = [
  ["a web/src route .svelte file", ["web/src/routes/administration/+page.svelte"], "unit"],
  ["a web/src fixture", ["web/src/lib/data/fixtures/admin.js"], "unit"],
  ["a src file", ["src/lib/x.ts"], "unit"],
  ["a markdown file only", ["docs/a.md"], "changed"],
  ["a Dockerfile", ["Dockerfile"], "whole"],
  ["a mixed list: .md, web/src file, Dockerfile", ["docs/a.md", "web/src/lib/a.js", "Dockerfile"], "whole"],
  ["a .md plus a src file", ["docs/a.md", "src/lib/x.ts"], "unit"],
  ["a test file outside web/src and src", ["tests/unit/foo.test.mjs"], "changed"],
  ["a script outside web/src and src", ["scripts/ci/x.mjs"], "changed"],
  ["empty input", [], "changed"],
  ["a .yml file", [".gitlab-ci.yml"], "whole"],
  ["a .json file", ["package.json"], "whole"],
];

describe("changed-test-tier.sh (#1934)", () => {
  for (const [name, paths, tier] of CASES) {
    it(`${name} gives ${tier}`, () => {
      expect(tierOf(paths)).toBe(tier);
    }, 30_000);
  }
});
