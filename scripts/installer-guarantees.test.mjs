import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

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
    expect(part2Sections.length).toBeGreaterThanOrEqual(9);
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

  it("no script section heading still says the executor doesn't exist yet", () => {
    // repair.sh grew an `--execute` mode (issue #261 slice 4) and this
    // exact phrase is what drifted out of date after that: it describes a
    // state the script has not been in since 2026-08-13.
    expect(catalogue).not.toContain("no executor yet");
  });
});
