/**
 * `read_environment_value` reads one KEY=value line of .env-orbit the way
 * Compose's own env-file parser does: a value in matching quotes loses them,
 * and an unquoted value loses a trailing " # note". Seven scripts each carry
 * their own copy of the function, so each is cut out of its script with sed
 * and run, so none can drift from the others.
 *
 * Uses node:test, not vitest globals: run standalone with
 * `node --test scripts/read-environment-value.test.mjs`, and by
 * scripts/test-backend.sh. vitest.config.ts excludes it.
 *
 * Why each case fails on the code before the change: the function returned the
 * raw text after "=", so the quoted values came back with their quote marks
 * and the commented value came back with its comment. The no-key overlay then
 * appended to that text, giving Compose a path that does not exist. The plain
 * value and the CRLF line already passed and must keep passing.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = fileURLToPath(new URL("./", import.meta.url));

const SCRIPTS = [
  "backup.sh",
  "restore.sh",
  "repair.sh",
  "install.sh",
  "end-maintenance.sh",
  "export-recovery-bundle.sh",
  "import-recovery-bundle.sh",
];

// [label, the raw line in .env-orbit, what the function must print]
const CASES = [
  ["a double-quoted list loses its quotes", 'COMPOSE_FILE="a.yml:b.yml"\n', "a.yml:b.yml"],
  ["a single-quoted value loses its quotes", "COMPOSE_FILE='a.yml'\n", "a.yml"],
  ["an unquoted value loses a trailing comment", "COMPOSE_FILE=a.yml # note\n", "a.yml"],
  ["a plain value is unchanged", "COMPOSE_FILE=a.yml:b.yml\n", "a.yml:b.yml"],
  ["a quoted value keeps a hash inside the quotes", 'COMPOSE_FILE="a #b.yml"\n', "a #b.yml"],
  ["quotes that do not match are left alone", "COMPOSE_FILE=\"a.yml'\n", "\"a.yml'"],
  // Fail on the code before the round-2 change: the unquoted branch removes
  // only the last space before " #", so the padding in front of it stays.
  ["an aligned comment leaves no trailing spaces", "COMPOSE_FILE=a.yml    # note\n", "a.yml"],
  // Fails because the comment marker is matched as space-then-hash only, so a
  // tab before the hash is not seen and the comment stays in the value.
  ["a comment after a tab is removed", "COMPOSE_FILE=a.yml\t# note\n", "a.yml"],
  // Fail because the quoted branch needs the value to end in a quote: a
  // comment after the closing quote sends it to the unquoted branch, which
  // keeps the quote marks.
  ["a quoted value followed by a comment loses quotes and comment", 'COMPOSE_FILE="a.yml:b.yml" # note\n', "a.yml:b.yml"],
  ["a single-quoted value with an aligned comment loses quotes and comment", "COMPOSE_FILE='a.yml'    # note\n", "a.yml"],
  // Fail because the quoted branch takes the LAST matching quote on the line
  // as the closing quote: a quote inside the trailing comment is picked, so the
  // value keeps its opening quote and the comment.
  ["a single-quoted value whose comment holds an apostrophe", "COMPOSE_FILE='a.yml:b.yml' # operator's overlay\n", "a.yml:b.yml"],
  ["a double-quoted value whose comment holds double quotes", 'COMPOSE_FILE="a.yml" # say "hi"\n', "a.yml"],
  // Pass today; guard against a fix that cuts at any hash or inside quotes.
  ["a hash with no space before it is kept", "COMPOSE_FILE=a.yml#b\n", "a.yml#b"],
  ["a quoted value keeps a spaced hash inside the quotes", 'COMPOSE_FILE="a # b.yml"\n', "a # b.yml"],
  ["a CRLF line with quotes loses the CR and the quotes", 'COMPOSE_FILE="a.yml"\r\n', "a.yml"],
  ["a CRLF line with a plain value loses the CR", "COMPOSE_FILE=a.yml\r\n", "a.yml"],
];

function extractFunction(script) {
  const cut = spawnSync(
    "sed",
    ["-n", "/^read_environment_value() {$/,/^}$/p", join(scriptsDir, script)],
    { encoding: "utf8" },
  );
  assert.equal(cut.status, 0, `sed failed on ${script}`);
  assert.match(cut.stdout, /^read_environment_value\(\) \{/u, `${script} defines read_environment_value`);
  return cut.stdout;
}

const workDir = mkdtempSync(join(tmpdir(), "orbit-read-env-"));
process.on("exit", () => rmSync(workDir, { recursive: true, force: true }));

for (const script of SCRIPTS) {
  const definition = extractFunction(script);
  for (const [label, line, expected] of CASES) {
    test(`${script}: ${label}`, () => {
      const environmentFile = join(workDir, `${script}.env`);
      writeFileSync(environmentFile, `OTHER=x\n${line}`);
      const run = spawnSync(
        "bash",
        ["-c", `${definition}\nenvironment_file="$1"\nread_environment_value COMPOSE_FILE`, "bash", environmentFile],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, expected);
    });
  }
}
