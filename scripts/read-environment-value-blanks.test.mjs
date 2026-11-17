import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Audit A-F4 (#1789): repair.sh's read_environment_value and the TypeScript
// reader (composeEnvValue in src/lib/configure-engine.ts) both claim to read
// .env-orbit as Compose does. Compose drops blanks between `=` and the value,
// and the TypeScript reader does; the shell reader kept them, so the two read
// the same line differently. Run standalone: node --test <this file>.

function valueRead(script, line) {
  const source = readFileSync(join(import.meta.dirname, script), "utf8");
  const match = source.match(/^read_environment_value\(\) \{\n[\s\S]*?\n\}\n/mu);
  assert.ok(match, "read_environment_value() not found");
  const dir = mkdtempSync(join(tmpdir(), "env-blanks-"));
  try {
    const file = join(dir, ".env-orbit");
    writeFileSync(file, `${line}\n`);
    const run = spawnSync("bash", ["-c", `environment_file="$1"\n${match[0]}\nread_environment_value DOCUMENT_SCAN_MODE`, "bash", file], { encoding: "utf8" });
    return run.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("A-F4: blanks between = and the value", () => {
  for (const script of ["repair.sh", "end-maintenance.sh"]) {
    it(`${script} reads "KEY=  disabled" as disabled, as the TypeScript reader does`, () => {
      assert.equal(valueRead(script, "DOCUMENT_SCAN_MODE=  disabled"), "disabled");
    });
    it(`${script} reads a tab before the value the same way`, () => {
      assert.equal(valueRead(script, "DOCUMENT_SCAN_MODE=\tdisabled # note"), "disabled");
    });
  }
});
