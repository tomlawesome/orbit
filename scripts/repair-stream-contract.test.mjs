import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// Body of a one-line or multi-line `readonly -a <name>=( ... )`, comments removed.
// bashArray above looks for a "\n)" terminator, which a one-line declaration such
// as safe_action_classes does not have.
function bashWordArray(name) {
  const start = repairSource.indexOf(`readonly -a ${name}=(`);
  expect(start, `repair.sh no longer declares ${name}`).toBeGreaterThan(-1);
  const open = repairSource.indexOf("(", start);
  const close = repairSource.indexOf(")", open);
  expect(close, `${name} is not closed`).toBeGreaterThan(open);
  return repairSource
    .slice(open + 1, close)
    .split("\n")
    .map((line) => line.replace(/#.*$/u, ""))
    .join(" ")
    .split(/\s+/u)
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

  // #1584 D-F2/O-F7: the PLAN MODE paragraph once said "the same 26 reason classes" while
  // class_order held 28 (and other documents said 21 and 25). A stated count must equal the
  // array, and the paragraph must point the reader at the array it is derived from.
  it("the PLAN MODE paragraph states no reason-class count that class_order contradicts, and names class_order", () => {
    const lines = repairSource.split("\n");
    const start = lines.findIndex((line) => line.includes("PLAN MODE (--plan)"));
    expect(start, "repair.sh no longer has the PLAN MODE (--plan) heading").toBeGreaterThan(-1);
    const end = lines.findIndex((line, index) => index > start && /^#\s*Severity gate/.test(line));
    expect(end, "repair.sh no longer has the Severity gate heading after PLAN MODE").toBeGreaterThan(start);
    const paragraph = lines
      .slice(start, end)
      .map((line) => line.replace(/^#\s?/, ""))
      .join(" ")
      .replace(/\s+/g, " ");

    const stated = paragraph.match(/(\d+) reason classes/);
    if (stated) expect(Number(stated[1])).toBe(bashArray("class_order").length);
    expect(paragraph).toContain("class_order");
  });

  // #1584 D-F2/O-F6 (owner decision 5a, 2026-10-31): the stage-one safe set is four action
  // classes, restore-compose-file having joined under #1484. The usage text and the header's
  // EXECUTE MODE section had kept saying three; safe_action_classes is the source of truth.
  it("the usage text names every safe_action_classes entry in its --safe-only sentence and no other action class", () => {
    const safe = bashWordArray("safe_action_classes");
    expect(safe).toEqual([
      "fix-permissions",
      "restore-transaction",
      "restart-services",
      "restore-compose-file",
    ]);
    const result = spawnSync("bash", [fileURLToPath(new URL("./repair.sh", import.meta.url))], {
      cwd: tmpdir(),
      encoding: "utf8",
      input: "",
      timeout: 30_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");

    const start = result.stderr.indexOf("--safe-only executes");
    const end = result.stderr.indexOf("--dangerous executes");
    expect(start, "usage no longer has the --safe-only executes sentence").toBeGreaterThan(-1);
    expect(end, "usage no longer has the --dangerous executes sentence").toBeGreaterThan(start);
    const sentence = result.stderr.slice(start, end);

    for (const action of safe) {
      expect(sentence, `usage --safe-only sentence omits ${action}`).toContain(action);
    }
    const mentioned = Object.keys(bashMap("mutation_for_action")).filter((action) =>
      sentence.includes(action),
    );
    const extra = mentioned.filter((action) => !safe.includes(action));
    expect(extra, "usage --safe-only sentence names action classes outside safe_action_classes").toEqual([]);
  });

  it("the EXECUTE MODE (--execute --safe-only) header section names every safe_action_classes entry and states a matching count", () => {
    const safe = bashWordArray("safe_action_classes");
    const lines = repairSource.split("\n");
    const start = lines.findIndex((line) => /^#\s*EXECUTE MODE \(--execute --safe-only\)/.test(line));
    expect(start, "repair.sh no longer has the EXECUTE MODE (--execute --safe-only) heading").toBeGreaterThan(-1);
    const end = lines.findIndex((line, index) => index > start && /^#\s*Action implementations/.test(line));
    expect(end, "repair.sh no longer has the Action implementations heading after EXECUTE MODE").toBeGreaterThan(start);
    const section = lines
      .slice(start, end)
      .map((line) => line.replace(/^#\s?/, ""))
      .join(" ")
      .replace(/\s+/g, " ");

    for (const action of safe) {
      expect(section, `EXECUTE MODE (--safe-only) section omits ${action}`).toContain(action);
    }
    const words = { three: 3, four: 4, five: 5, six: 6 };
    for (const [, word] of section.matchAll(/\b(three|four|five|six) action classes/giu)) {
      expect(words[word.toLowerCase()], `section says "${word} action classes"`).toBe(safe.length);
    }
    for (const [, word] of section.matchAll(/\bexactly the (three|four|five|six)\b/giu)) {
      expect(words[word.toLowerCase()], `section says "exactly the ${word}"`).toBe(safe.length);
    }
  });
});
