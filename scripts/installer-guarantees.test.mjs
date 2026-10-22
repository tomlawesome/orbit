import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { staleInstallShCitations } from "./installer-guarantee-citations.mjs";

/*
 * #587: docs/installer-guarantees.md's per-script counts, family totals and
 * document-wide total are hand-maintained and drift whenever a guarantee is
 * added or removed without also updating the aggregates around it — the
 * numbered entries themselves were always kept current, only the tallies
 * derived from them were not. This pins every tally to the numbered entries
 * it is supposed to summarise, so a forgotten recount fails here instead of
 * drifting silently until a harness scenario cites an entry number that no
 * longer means what the table says.
 */

const catalogue = readFileSync(new URL("../docs/installer-guarantees.md", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);

// Script sections are `## name.ext (...)` headings; `## Part N` and
// `## Summary` headings are not script sections and reset/end the current one.
// Guarantees are numbered `1.`, `2.`, ... starting over in each section.
function parseScriptSections(text) {
  const sections = [];
  let current = null;
  let part = 0;
  for (const line of text.split("\n")) {
    const partHeading = /^## Part (\d+)/u.exec(line);
    if (partHeading) {
      part = Number(partHeading[1]);
      current = null;
      continue;
    }
    const heading = /^## (\S.*)$/u.exec(line);
    if (heading) {
      const title = heading[1];
      if (title.startsWith("Summary")) {
        current = null;
        continue;
      }
      current = { name: title.split(" ")[0], part, count: 0 };
      sections.push(current);
      continue;
    }
    if (current && /^\d+\.\s/u.test(line)) current.count += 1;
  }
  return sections;
}

// Parses the "| script.sh | NN |" rows of the markdown table that
// immediately follows the given heading, stopping at the table's end. The
// `**Total**` row is skipped naturally: its first column is not a bare
// script name.
function parseScriptTable(text, headingText) {
  const start = text.indexOf(headingText);
  if (start === -1) throw new Error(`heading not found in catalogue: ${headingText}`);
  const block = /\n\n((?:\|.*\n)+)/u.exec(text.slice(start));
  if (!block) throw new Error(`no table found after heading: ${headingText}`);
  const counts = new Map();
  for (const row of block[1].matchAll(/^\|\s*([\w.-]+)\s*\|\s*(\d+)\s*\|/gmu)) {
    counts.set(row[1], Number(row[2]));
  }
  return counts;
}

const sections = parseScriptSections(catalogue);
const part1Sections = sections.filter((section) => section.part === 1);
const part2Sections = sections.filter((section) => section.part === 2);
const part1ActualTotal = part1Sections.reduce((sum, section) => sum + section.count, 0);
const part2ActualTotal = part2Sections.reduce((sum, section) => sum + section.count, 0);

describe("installer guarantee catalogue aggregates", () => {
  it("has at least the scripts both parts are expected to cover", () => {
    // A parsing regression (a renamed heading no longer matched, a section
    // silently merged into its neighbour) would otherwise show up only as a
    // suspiciously small total further down.
    expect(part1Sections.length).toBeGreaterThanOrEqual(7);
    expect(part2Sections.length).toBeGreaterThanOrEqual(8);
  });

  it("Part 1's per-script table matches the numbered entries in each section", () => {
    const table = parseScriptTable(catalogue, "**Guarantee count by script**");
    for (const section of part1Sections) {
      expect(table.get(section.name), `${section.name} in the Part 1 table`).toBe(section.count);
    }
    expect(table.size).toBe(part1Sections.length);
  });

  it("Part 2's per-script table matches the numbered entries in each section", () => {
    const table = parseScriptTable(catalogue, "### Counts by script");
    for (const section of part2Sections) {
      expect(table.get(section.name), `${section.name} in the Part 2 table`).toBe(section.count);
    }
    expect(table.size).toBe(part2Sections.length);
  });

  it("Part 1's table Total row and criticality table equal the sum of its rows", () => {
    const totalRow = /\*\*Guarantee count by script\*\*[^]*?\|\s*\*\*Total\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|/u.exec(
      catalogue,
    );
    expect(totalRow, "Part 1 script-table Total row").not.toBeNull();
    expect(Number(totalRow[1])).toBe(part1ActualTotal);

    const criticalityTotal =
      /Guarantee count by category × criticality[^]*?\|\s*\*\*Total\*\*\s*\|\s*\*\*\d+\*\*\s*\|\s*\*\*\d+\*\*\s*\|\s*\*\*\d+\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|/u.exec(
        catalogue,
      );
    expect(criticalityTotal, "Part 1 category × criticality Total row").not.toBeNull();
    expect(Number(criticalityTotal[1])).toBe(part1ActualTotal);
  });

  it("Part 2's headline total and criticality table equal the sum of its rows", () => {
    const headline = /Total guarantees catalogued:\s*(\d+)/u.exec(catalogue);
    expect(headline, "Part 2 headline total").not.toBeNull();
    expect(Number(headline[1])).toBe(part2ActualTotal);

    const criticalityTotal = /Counts by criticality[^]*?\|\s*\*\*Total\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|/u.exec(
      catalogue,
    );
    expect(criticalityTotal, "Part 2 criticality Total row").not.toBeNull();
    expect(Number(criticalityTotal[1])).toBe(part2ActualTotal);
  });

  it("the preamble's family totals and document-wide total equal the actual sums", () => {
    const preamble =
      /Totals:\*\*\s*(\d+)\s*guarantees[^]*?Install\/configuration family:\s*(\d+)\s*\(\d+\s*HIGH\)\.\s*Backup\/recovery\/deploy\s*family:\s*(\d+)/u.exec(
        catalogue,
      );
    expect(preamble, "preamble Totals bullet").not.toBeNull();
    const [, documentTotal, installFamilyTotal, backupFamilyTotal] = preamble;

    expect(Number(installFamilyTotal), "Install/configuration family total").toBe(part1ActualTotal);
    expect(Number(backupFamilyTotal), "Backup/recovery/deploy family total").toBe(part2ActualTotal);
    expect(Number(documentTotal), "document-wide total").toBe(part1ActualTotal + part2ActualTotal);
  });

  it("catalogues only scripts that still exist (#1403 D5)", () => {
    // A section for a deleted script (configuration.sh, generate-vapid.mjs)
    // keeps guarantees nothing can break any more and inflates every tally.
    const missing = sections
      .map((section) => section.name)
      .filter((name) => !existsSync(new URL(`./${name}`, import.meta.url)));
    expect(missing).toEqual([]);
  });

  it("no script section heading still says the executor doesn't exist yet", () => {
    // repair.sh grew an `--execute` mode (issue #261 slice 4) and this
    // exact phrase is what drifted out of date after that: it describes a
    // state the script has not been in since 2026-08-13.
    expect(catalogue).not.toContain("no executor yet");
  });
});

/*
 * Redesign r5 (B30, R5-drill-FR3): the test list cites the real-stack drill
 * by the `note` line it prints. A quote the drill no longer prints is
 * evidence of nothing, so every `ACC:` quote in the install.sh #31 and #58
 * rows must appear verbatim in scripts/test-install-acceptance.sh, and #31's
 * cell quotes the note of the hard interruption after the commit.
 */
describe("install.sh test list: the drill's quoted notes (redesign r5)", () => {
  const drill = readFileSync(new URL("./test-install-acceptance.sh", import.meta.url), "utf8");
  const listStart = catalogue.indexOf("### install.sh guarantees: now asserted by");

  function accQuotes(number) {
    expect(listStart, "the install.sh test list").toBeGreaterThan(-1);
    const row = catalogue
      .slice(listStart)
      .split("\n")
      .find((line) => line.startsWith(`| ${number} |`));
    expect(row, `row ${number} of the install.sh test list`).toBeDefined();
    const cell = row.slice(row.indexOf("ACC:") < 0 ? row.length : row.indexOf("ACC:"));
    // ACC: "quote", "quote" -- up to the next `XX:` source or the end of the cell.
    const accPart = cell.split(/\.\s+[A-Z]{2,4}:\s/u)[0];
    return [...accPart.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  }

  it.each([[31], [58]])("every ACC quote in row #%s appears verbatim in the drill", (number) => {
    for (const quote of accQuotes(number)) expect(drill, quote).toContain(quote);
  });

  it("#31 quotes the drill's note for the hard interruption after the commit", () => {
    const note =
      "lifecycle: install.sh's rollback put .env-orbit and .orbit-secrets back byte-identical after a hard interruption after the commit, staging and lock gone (install.sh #58)";
    expect(accQuotes(31)).toContain(note);
    expect(drill).toContain(note);
  });
});

/*
 * #1481: a citation of `scripts/install.sh` that names a function the script
 * no longer defines, or whose line range misses that function, points a
 * reader at unrelated code. The check reads each `install.sh:<lines>
 * (<function>)` citation in the catalogue and fails on both kinds of stale
 * citation.
 */
describe("install.sh citations in the guarantee catalogue (#1481)", () => {
  // Lines 1-3 are filler, `alpha` is defined at lines 4-8, `beta` at 10-12.
  const installSh = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "alpha() {",
    "  echo one",
    "  echo two",
    "  echo three",
    "}",
    "",
    "beta() {",
    "  echo b",
    "}",
    "",
    "alpha",
    "",
  ].join("\n");

  function doc(...entries) {
    return [
      "## install.sh (the installer)",
      "",
      ...entries.map((entry, index) => `${index + 1}. ${entry}`),
      "",
    ].join("\n");
  }

  const entry = (citation) =>
    `The installer does a thing. \u2014 ${citation} \u2014 category: input-validation \u2014 criticality: LOW`;

  it("accepts a citation of a defined function whose range overlaps it", () => {
    expect(
      staleInstallShCitations(doc(entry("install.sh:4-8 (alpha)")), installSh),
    ).toEqual([]);
  });

  it("accepts a range that only partly overlaps the function", () => {
    expect(
      staleInstallShCitations(doc(entry("install.sh:7-20 (alpha)")), installSh),
    ).toEqual([]);
  });

  it("reports a citation naming a function install.sh does not define", () => {
    const problems = staleInstallShCitations(
      doc(entry("install.sh:4-8 (gone_function)")),
      installSh,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toBe("function not defined");
    expect(problems[0].citation).toContain("gone_function");
    expect(String(problems[0].guarantee)).toMatch(/\b1\b/u);
  });

  it("reports a defined function cited at a range entirely outside it", () => {
    const problems = staleInstallShCitations(
      doc(entry("install.sh:30-40 (alpha)")),
      installSh,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toBe("lines do not overlap the function");
    expect(problems[0].citation).toContain("alpha");
  });

  it("reports a range that sits wholly in a neighbouring function", () => {
    const problems = staleInstallShCitations(
      doc(entry("install.sh:10-12 (alpha)")),
      installSh,
    );
    expect(problems.map((problem) => problem.problem)).toEqual([
      "lines do not overlap the function",
    ]);
  });

  it("accepts a single-line citation inside the function", () => {
    expect(
      staleInstallShCitations(doc(entry("install.sh:5 (alpha)")), installSh),
    ).toEqual([]);
  });

  it("reports only the undefined function when one citation names two", () => {
    const problems = staleInstallShCitations(
      doc(entry("install.sh:4-12 (`alpha`, `missing_one`)")),
      installSh,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toBe("function not defined");
    expect(problems[0].citation).toContain("missing_one");
  });

  it("reports the right guarantee when only one of several is stale", () => {
    const problems = staleInstallShCitations(
      doc(
        entry("install.sh:4-8 (alpha)"),
        entry("install.sh:10-12 (nope)"),
        entry("install.sh:10-12 (beta)"),
      ),
      installSh,
    );
    expect(problems).toHaveLength(1);
    expect(String(problems[0].guarantee)).toMatch(/\b2\b/u);
  });

  it("ignores citations of other files", () => {
    const text = doc(
      entry("src/lib/x.ts:10-20 (f)"),
      entry(
        "src/lib/install-orchestrator.ts:364-369 (`runInstall`); install.sh:4-8 (alpha)",
      ),
    );
    expect(staleInstallShCitations(text, installSh)).toEqual([]);
  });

  it("every install.sh citation in the real catalogue names a function install.sh defines, at its lines", () => {
    const installShReal = readFileSync(
      new URL("./install.sh", import.meta.url),
      "utf8",
    ).replaceAll("\r\n", "\n");
    expect(staleInstallShCitations(catalogue, installShReal)).toEqual([]);
  });
});
