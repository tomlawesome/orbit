import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// Two tests here run installer-ui.sh under bash; a spawn that takes tens of
// milliseconds quiet takes seconds on a starved core (#698). Budget and
// reasoning: scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const helperPath = fileURLToPath(new URL("./installer-ui.sh", import.meta.url));
const contractPath = fileURLToPath(
  new URL("../docs/engine-events.md", import.meta.url),
);

const FIELDS = ["phase", "component", "state", "reason", "action", "recovery"];

function implementedVocabulary() {
  const source = readFileSync(helperPath, "utf8");
  const start = source.indexOf("installer_ui_safe_field()");
  const end = source.indexOf("esac", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end);

  const vocabulary = Object.fromEntries(FIELDS.map((field) => [field, new Set()]));
  for (const match of body.matchAll(
    /(phase|component|state|reason|action|recovery):([a-z][a-z-]*)/gu,
  )) {
    vocabulary[match[1]].add(match[2]);
  }
  return vocabulary;
}

function documentedVocabulary(fields = FIELDS) {
  const contract = readFileSync(contractPath, "utf8");
  const vocabulary = {};
  for (const field of fields) {
    const section = contract.match(
      new RegExp(`### ${field}\\n\\n\`\`\`\\n([^\`]+)\`\`\``, "u"),
    );
    expect(section, `docs/engine-events.md must contain a \`\`\` block for ${field}`).not.toBeNull();
    vocabulary[field] = new Set(
      section[1]
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
  }
  return vocabulary;
}

describe("engine event stream v0 contract", () => {
  for (const field of FIELDS) {
    it(`documents exactly the implemented ${field} vocabulary`, () => {
      // Read inside the test, so a field missing from the contract fails here rather than the whole file's collection.
      const implemented = implementedVocabulary();
      const documented = documentedVocabulary([field]);
      const undocumented = [...implemented[field]].filter(
        (value) => !documented[field].has(value),
      );
      const phantom = [...documented[field]].filter(
        (value) => !implemented[field].has(value),
      );
      expect(undocumented, `implemented but undocumented ${field} values`).toEqual([]);
      expect(phantom, `documented but unimplemented ${field} values`).toEqual([]);
    });
  }

  it("emits the documented plain-mode line format", () => {
    const result = failOnProcessDeadline(spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; installer_ui_init --plain; installer_ui_emit compose database running database-health wait 42',
        "engine-events-test",
        helperPath,
      ],
      { encoding: "utf8", ...processGuard() },
    ), { label: "plain-mode line format" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "phase=compose component=database state=running reason=database-health action=wait elapsed=42s",
    );
  });

  it("renders an unrecognised value as the literal unknown", () => {
    const result = failOnProcessDeadline(spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; installer_ui_init --plain; installer_ui_emit compose database running $\'evil\\033[2Jvalue\' wait 1',
        "engine-events-test",
        helperPath,
      ],
      { encoding: "utf8", ...processGuard() },
    ), { label: "unrecognised value renders as unknown" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "phase=compose component=database state=running reason=unknown action=wait elapsed=1s",
    );
  });

  // Redesign r4 addendum: the recovery-command contract.
  it("appends recovery=command when a recovery command was printed", () => {
    const result = failOnProcessDeadline(spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; installer_ui_init --plain; installer_ui_recovery=command; installer_ui_emit preparation compose failed docker-host retry 42',
        "engine-events-test",
        helperPath,
      ],
      { encoding: "utf8", ...processGuard() },
    ), { label: "recovery field" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "phase=preparation component=compose state=failed reason=docker-host action=retry elapsed=42s recovery=command",
    );
  });

  it("renders an unrecognised recovery value as unknown", () => {
    const result = failOnProcessDeadline(spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; installer_ui_init --plain; installer_ui_recovery=bogus; installer_ui_emit preparation compose failed docker-host retry 42',
        "engine-events-test",
        helperPath,
      ],
      { encoding: "utf8", ...processGuard() },
    ), { label: "unrecognised recovery value" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().endsWith(" recovery=unknown")).toBe(true);
  });

  it("documents the recovery-command line", () => {
    const contract = readFileSync(contractPath, "utf8");
    const at = contract.indexOf("\n## Recovery command (v0)\n");
    expect(at, "docs/engine-events.md must have a `## Recovery command (v0)` section").toBeGreaterThan(-1);
    const next = contract.indexOf("\n## ", at + 1);
    const section = contract.slice(at, next < 0 ? undefined : next);
    const block = /```[a-z]*\n([^\n]*)\n/u.exec(section);
    expect(block, "the section must hold a ``` code block").not.toBeNull();
    expect(block[1]).toBe("recovery-command: <command>");
    // Redesign r5 (B28): the two command shapes -- `cd` into the dated folder's engine/, and the volume removal.
    expect(section).toContain("orbit-install-backups");
    expect(section).toContain("docker volume rm");
  });
});
