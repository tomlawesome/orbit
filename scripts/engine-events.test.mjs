import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const helperPath = fileURLToPath(new URL("./installer-ui.sh", import.meta.url));
const contractPath = fileURLToPath(
  new URL("../docs/engine-events.md", import.meta.url),
);

const FIELDS = ["phase", "component", "state", "reason", "action"];

function implementedVocabulary() {
  const source = readFileSync(helperPath, "utf8");
  const start = source.indexOf("installer_ui_safe_field()");
  const end = source.indexOf("esac", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end);

  const vocabulary = Object.fromEntries(FIELDS.map((field) => [field, new Set()]));
  for (const match of body.matchAll(
    /(phase|component|state|reason|action):([a-z][a-z-]*)/gu,
  )) {
    vocabulary[match[1]].add(match[2]);
  }
  return vocabulary;
}

function documentedVocabulary() {
  const contract = readFileSync(contractPath, "utf8");
  const vocabulary = {};
  for (const field of FIELDS) {
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
  const implemented = implementedVocabulary();
  const documented = documentedVocabulary();

  for (const field of FIELDS) {
    it(`documents exactly the implemented ${field} vocabulary`, () => {
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
    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; installer_ui_init --plain; installer_ui_emit compose database running database-health wait 42',
        "engine-events-test",
        helperPath,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "phase=compose component=database state=running reason=database-health action=wait elapsed=42s",
    );
  });

  it("renders an unrecognised value as the literal unknown", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; installer_ui_init --plain; installer_ui_emit compose database running $\'evil\\033[2Jvalue\' wait 1',
        "engine-events-test",
        helperPath,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "phase=compose component=database state=running reason=unknown action=wait elapsed=1s",
    );
  });
});
