import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// docs/engine-events.md's "Repair stream (v0)" section is a versioned machine
// interface: the launcher parses those enums and nothing else (#533). The
// section itself says any vocabulary change "lands in the same pull request as
// its update here", but until now nothing enforced that -- the installer stream
// has engine-events.test.mjs comparing implemented against documented, and the
// repair stream had only human review. This is the missing half.
//
// It compares in both directions deliberately. An undocumented value breaks a
// consumer that trusts the document; a phantom value -- documented but never
// emitted -- is worse, because a consumer writes a branch for it that can never
// run and no test ever reports the dead code.
//
// repair.sh's own declarations are the source of truth for what is implemented:
// `class_order` is the finding-class list every diagnosis orders itself by, and
// `mutation_for_action`/`backup_for_action` are the maps --plan reads to emit
// the mutation= and backup= fields.

const repairSource = readFileSync(
  fileURLToPath(new URL("./repair.sh", import.meta.url)),
  "utf8",
).replaceAll("\r\n", "\n");
const contract = readFileSync(
  fileURLToPath(new URL("../docs/engine-events.md", import.meta.url)),
  "utf8",
).replaceAll("\r\n", "\n");

// Body of `readonly -a <name>=( ... )`, comments and blank lines removed.
function bashArray(name) {
  const start = repairSource.indexOf(`readonly -a ${name}=(`);
  expect(start, `repair.sh no longer declares ${name}`).toBeGreaterThan(-1);
  const end = repairSource.indexOf("\n)", start);
  expect(end, `${name} is not closed`).toBeGreaterThan(start);
  return repairSource
    .slice(repairSource.indexOf("(", start) + 1, end)
    .split("\n")
    .map((line) => line.replace(/#.*$/u, "").trim())
    .filter(Boolean);
}

// `readonly -A <name>=( [key]=value ... )` as a plain object.
function bashMap(name) {
  const start = repairSource.indexOf(`readonly -A ${name}=(`);
  expect(start, `repair.sh no longer declares ${name}`).toBeGreaterThan(-1);
  const end = repairSource.indexOf("\n)", start);
  expect(end, `${name} is not closed`).toBeGreaterThan(start);
  const body = repairSource.slice(start, end);
  const entries = [...body.matchAll(/^\s*\[([a-z][a-z-]*)\]=([a-z][a-z-]*)\s*$/gmu)];
  expect(entries.length, `parsed no entries out of ${name}`).toBeGreaterThan(0);
  return Object.fromEntries(entries.map((match) => [match[1], match[2]]));
}

// The repair stream's own section, so a value documented for the installer
// stream earlier in the same file cannot satisfy an assertion here.
function repairStreamSection() {
  const start = contract.indexOf("## Repair stream (v0)");
  expect(start, "docs/engine-events.md no longer has a Repair stream section").toBeGreaterThan(-1);
  const next = contract.indexOf("\n## ", start + 1);
  return contract.slice(start, next === -1 ? contract.length : next);
}

// The fenced block under a `### <heading>` inside the repair stream section.
function fencedBlockUnder(heading) {
  const section = repairStreamSection();
  const start = section.indexOf(`### ${heading}`);
  expect(start, `the repair stream section has no "${heading}" heading`).toBeGreaterThan(-1);
  const open = section.indexOf("```", start);
  const close = section.indexOf("```", open + 3);
  expect(close, `the "${heading}" block is not closed`).toBeGreaterThan(open);
  return section.slice(open + 3, close);
}

function documentedFindingClasses() {
  // The block is laid out in two columns for readability, so split on any
  // whitespace rather than per line.
  return new Set(fencedBlockUnder("finding class").split(/\s+/u).filter(Boolean));
}

// The `| action | mutation | backup |` table, as { action: { mutation, backup } }.
function documentedActionTable() {
  const section = repairStreamSection();
  const start = section.indexOf("### action, mutation and backup");
  expect(start, "the repair stream section has no action/mutation/backup table").toBeGreaterThan(-1);
  const rows = [
    ...section
      .slice(start)
      .matchAll(/^\|\s*`([a-z-]+)`\s*\|\s*`([a-z-]+)`\s*\|\s*`([a-z-]+)`\s*\|$/gmu),
  ];
  expect(rows.length, "parsed no rows out of the action table").toBeGreaterThan(0);
  return Object.fromEntries(
    rows.map((row) => [row[1], { mutation: row[2], backup: row[3] }]),
  );
}

describe("repair stream v0 contract", () => {
  it("documents exactly the finding classes repair.sh can emit", () => {
    const implemented = new Set(bashArray("class_order"));
    const documented = documentedFindingClasses();

    const undocumented = [...implemented].filter((value) => !documented.has(value)).sort();
    const phantom = [...documented].filter((value) => !implemented.has(value)).sort();

    expect(undocumented, "emitted by repair.sh but absent from engine-events.md").toEqual([]);
    expect(phantom, "documented in engine-events.md but never emitted").toEqual([]);
  });

  it("documents exactly the action set, with the mutation each one declares", () => {
    const implemented = bashMap("mutation_for_action");
    const documented = documentedActionTable();

    expect(Object.keys(documented).sort()).toEqual(Object.keys(implemented).sort());
    for (const [action, mutation] of Object.entries(implemented)) {
      expect(documented[action]?.mutation, `mutation for ${action}`).toBe(mutation);
    }
  });

  it("documents the backup requirement each action declares", () => {
    const implemented = bashMap("backup_for_action");
    const documented = documentedActionTable();

    expect(Object.keys(documented).sort()).toEqual(Object.keys(implemented).sort());
    for (const [action, backup] of Object.entries(implemented)) {
      expect(documented[action]?.backup, `backup for ${action}`).toBe(backup);
    }
  });
});
