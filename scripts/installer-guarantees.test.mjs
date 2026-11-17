import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  aboutCitationProblems,
  citationContentProblems,
  citedFileLines,
  fileCitationContentProblems,
  fileNamedFunctionProblems,
  mainScriptCitationProblems,
  staleInstallShCitations,
} from "./installer-guarantee-citations.mjs";

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

/*
 * #1846: "main script" citations name top-level code. Each must lie outside
 * every function body and start and end on a code line, and, for the rows in
 * the fixed list below, the cited lines must hold the code the guarantee
 * describes. `index` is the segment's position among the guarantee's
 * install.sh citations.
 */
describe("install.sh main-script citations in the guarantee catalogue (#1846)", () => {
  // Lines 1-2 filler, `alpha` at 4-6, top-level code at 8-9, blank at 7 and 10.
  const installSh = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "alpha() {",
    "  echo inside",
    "}",
    "",
    "recheck_volume=1",
    "echo changed during installation",
    "",
    "echo end",
    "",
  ].join("\n");
  const doc = (...entries) =>
    ["## install.sh (the installer)", "", ...entries.map((e, i) => `${i + 1}. ${e}`), ""].join("\n");
  const entry = (citation) => `Does a thing. \u2014 ${citation} \u2014 category: x \u2014 criticality: LOW`;

  it("accepts a main-script range on top-level code", () => {
    expect(
      mainScriptCitationProblems(doc(entry("install.sh:7-8 (main script, check)")), installSh),
    ).toEqual([]);
  });

  it("reports a main-script range inside a function body", () => {
    const problems = mainScriptCitationProblems(doc(entry("install.sh:3-5 (main script, check)")), installSh);
    expect(problems.map((p) => p.problem)).toEqual(["lines overlap function alpha"]);
  });

  it("reports a main-script range that starts or ends on a blank line", () => {
    const problems = mainScriptCitationProblems(doc(entry("install.sh:6-8 (main script, check)")), installSh);
    expect(problems.map((p) => p.problem)).toEqual(["first line is blank"]);
    const trailing = mainScriptCitationProblems(doc(entry("install.sh:7-9 (main script, check)")), installSh);
    expect(trailing.map((p) => p.problem)).toEqual(["last line is blank"]);
  });

  it("checks a bare range that precedes a main-script one, and ignores function citations", () => {
    const text = doc(entry("install.sh:6, 7-8 (main script, reads); install.sh:3-5 (alpha)"));
    expect(mainScriptCitationProblems(text, installSh).map((p) => p.problem)).toEqual(["first line is blank", "last line is blank"]);
  });

  it("reports code the cited lines lack, and a missing citation", () => {
    const text = doc(entry("install.sh:6-7 (main script, check)"));
    const problems = citationContentProblems(text, installSh, [
      { guarantee: "install.sh #1", index: 0, contains: ["recheck_volume=", "changed during installation"] },
      { guarantee: "install.sh #1", index: 1, contains: ["x"] },
    ]);
    expect(problems.map((p) => p.problem)).toEqual(["lines lack changed during installation", "citation not found"]);
    expect(
      citationContentProblems(doc(entry("install.sh:7-8 (main script, check)")), installSh, [
        { guarantee: "install.sh #1", index: 0, contains: ["recheck_volume=", "changed during installation"] },
      ]),
    ).toEqual([]);
  });

  const installShReal = readFileSync(new URL("./install.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n");

  it("every main-script citation in the real catalogue lies outside functions and on code lines", () => {
    expect(mainScriptCitationProblems(catalogue, installShReal)).toEqual([]);
  });

  it("install.sh #39 cites the docker-compose.yml lines of the model-pull service and its loopback OLLAMA_HOST (#1852)", () => {
    const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
    const cited = citedFileLines(catalogue, compose, "install.sh #39", "docker-compose.yml");
    expect(cited, "install.sh #39 has no docker-compose.yml citation").not.toBeNull();
    expect(cited).toContain("orbit-ollama-model-pull:");
    expect(cited).toContain("OLLAMA_HOST: 127.0.0.1");
  });

  // Fixed list from the #1846 spec; substrings are literal text of install.sh.
  const expectations = [
    { guarantee: "install.sh #17", index: 0, contains: ["recheck_volume=", "changed during installation"] },
    {
      guarantee: "install.sh #22",
      index: 0,
      contains: ["requested_action\" == repair", "exit 3"],
    },
    {
      guarantee: "install.sh #40",
      index: 0,
      contains: ["command -v docker", "docker compose version", "command -v timeout"],
    },
    { guarantee: "install.sh #41", index: 0, contains: ["manifest_digest=", "^sha256:"] },
    {
      guarantee: "install.sh #41",
      index: 1,
      contains: ["docker pull", "RepoDigests", "digest_confirmed=1", "did not return an immutable digest"],
    },
    {
      guarantee: "install.sh #42",
      index: 0,
      contains: ["org.opencontainers.image.revision", "does not record the source revision"],
    },
    {
      guarantee: "install.sh #42",
      index: 1,
      contains: [
        "io.orbit.deployment-assets",
        "built before Orbit bundled its deployment assets",
        "somewhere other than",
      ],
    },
    {
      guarantee: "install.sh #43",
      index: 0,
      contains: ["org.opencontainers.image.version", "$semver_pattern"],
    },
    { guarantee: "install.sh #44", index: 0, contains: ["--banner", "could not render its canonical banner"] },
    { guarantee: "install.sh #55", index: 0, contains: ["compose config --quiet", "configuration is invalid"] },
    { guarantee: "install.sh #56", index: 0, contains: ["# --- after the commit", "rollback_armed=0"] },
    { guarantee: "Summary #4", index: 0, contains: ["@sha256:"] },
    { guarantee: "Summary #6", index: 0, contains: ["semver_pattern="] },
    { guarantee: "Summary #6", index: 1, contains: ["org.opencontainers.image.version", "$semver_pattern"] },
    { guarantee: "Summary #7", index: 0, contains: ["^sha256:"] },
    { guarantee: "Summary #7", index: 1, contains: ["applied_digest="] },
    { guarantee: "Summary #10", index: 0, contains: ["requested_action\" == repair", "exit 3"] },
  ];

  for (const row of expectations) {
    it(`${row.guarantee} citation ${row.index} contains the code it names`, () => {
      expect(citationContentProblems(catalogue, installShReal, [row])).toEqual([]);
    });
  }
});

/*
 * #1859: every `repair.sh:` citation list in the catalogue, e.g.
 * `repair.sh:2144-2161 (`read_compose_project_name`), 3101-3126 (`run_diagnosis`, Step 6)`
 * (a list runs up to its " — " separator). Backticked names in a segment's
 * parenthesis that resolve to a repair.sh function, or to a multi-line
 * `readonly|declare -A|-a name=(` array (span: that line to the next line that
 * is just `)`), are checked: the segment must overlap them, start at the first
 * line / inside / inside the `#` comment block directly above, and end no later
 * than the closing line. With several resolved names the range may span them:
 * start >= the earliest comment-block start, end <= the latest closing line.
 * A lowercase snake_case name (env vars like `ORBIT_X` are not checked) that resolves to nothing fails, unless written as
 * `readonly `name``: those are single lines, and the cited lines must contain
 * `name=`. `, Step X` additionally requires the cited start line to be that
 * step's `# ---` header (`Steps 9 and 9b` / `Steps 1-3` mean the first named).
 */
describe("repair.sh function and step citations (#1859)", () => {
  const repairLines = readFileSync(new URL("./repair.sh", import.meta.url), "utf8").split("\n");
  const lineAt = (n) => repairLines[n - 1] ?? "";

  function commentStart(first) {
    let commentFrom = first;
    while (commentFrom > 1 && lineAt(commentFrom - 1).trimStart().startsWith("#")) commentFrom -= 1;
    return commentFrom;
  }

  function nameSpan(name) {
    const fnFirst = repairLines.findIndex((l) => l.startsWith(`${name}() {`)) + 1;
    if (fnFirst > 0) {
      let last = fnFirst + 1;
      while (last <= repairLines.length && !lineAt(last).startsWith("}")) last += 1;
      return { first: fnFirst, commentFrom: commentStart(fnFirst), last };
    }
    const arrayHead = new RegExp(`^(?:readonly|declare) -[Aa] ${name}=\\(\\s*$`, "u");
    const arrFirst = repairLines.findIndex((l) => arrayHead.test(l)) + 1;
    if (arrFirst > 0) {
      let last = arrFirst + 1;
      while (last <= repairLines.length && lineAt(last).trim() !== ")") last += 1;
      return { first: arrFirst, commentFrom: commentStart(arrFirst), last };
    }
    return null;
  }

  const segments = [];
  const unresolved = [];
  for (const line of catalogue.split("\n")) {
    for (const list of line.matchAll(/repair\.sh:(.*?)(?: — |$)/gu)) {
      const segmentPattern = /(\d+)(?:-(\d+))?\s*(?:\(((?:[^()]|\([^()]*\))*)\))?/gu;
      for (const m of list[1].matchAll(segmentPattern)) {
        const paren = m[3] ?? "";
        const start = Number(m[1]);
        const end = Number(m[2] ?? m[1]);
        const text = m[0].trim();
        const names = [];
        const readonlyNames = [];
        for (const n of paren.matchAll(/(readonly\s+)?`([A-Za-z_][A-Za-z0-9_]*)`/gu)) {
          (n[1] ? readonlyNames : names).push(n[2]);
        }
        for (const name of readonlyNames) {
          const hit = repairLines.slice(start - 1, end).some((l) => l.includes(`${name}=`));
          if (!hit) unresolved.push(`${text}: readonly \`${name}\` - no line ${start}-${end} contains "${name}="`);
        }
        const spans = [];
        for (const name of names) {
          const span = nameSpan(name);
          if (span) spans.push({ name, ...span });
          else if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/u.test(name)) unresolved.push(`${text}: \`${name}\` is neither a repair.sh function nor a multi-line array`);
        }
        if (spans.length === 0) continue;
        segments.push({
          text,
          label: spans.map((s) => s.name).join(", "),
          spans,
          first: Math.min(...spans.map((s) => s.first)),
          commentFrom: Math.min(...spans.map((s) => s.commentFrom)),
          last: Math.max(...spans.map((s) => s.last)),
          start,
          end,
          step: /,\s*Steps?\s+(\d+[a-z]?)(?![0-9A-Za-z])/u.exec(paren)?.[1],
        });
      }
    }
  }

  it("finds function citations to check", () => {
    expect(segments.length).toBeGreaterThanOrEqual(92) // 102 at #1859, minus ~10%;
  });

  it("every identifier-like name in a citation resolves", () => {
    expect(unresolved).toEqual([]);
  });

  it("each citation covers its function or array and stays inside it", () => {
    const problems = [];
    for (const { text, label, spans, first, commentFrom, last, start, end } of segments) {
      const real = spans.map((s) => `${s.name} is at repair.sh:${s.first}-${s.last} (comment from ${s.commentFrom})`).join("; ");
      if (end < first || start > last) problems.push(`${text} [${label}]: does not overlap; ${real}`);
      else if (start < commentFrom) problems.push(`${text} [${label}]: starts before the first name and its comment; ${real}`);
      else if (end > last) problems.push(`${text} [${label}]: ends past the last closing line; ${real}`);
    }
    expect(problems).toEqual([]);
  });

  it("each `Step X` citation starts at that step's `# ---` header", () => {
    const problems = [];
    for (const { text, label, start, step } of segments) {
      if (!step) continue;
      const header = new RegExp(`^\\s*# ---.*\\bStep ${step}(?![0-9A-Za-z])`, "u");
      if (!header.test(lineAt(start))) {
        problems.push(`${text}: line ${start} of ${label} is not the "Step ${step}" header, it is: ${lineAt(start).trim()}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

/*
 * #1880: "about N-M" citations and citations into installer-ui.sh. An "about"
 * citation names a function that must start inside the range. installer-ui.sh
 * citations name no function in their parentheses, so each cited range must
 * hold the code its guarantee describes, and each function a guarantee names
 * in backticks must overlap one of its citations.
 */
describe("'about' and installer-ui.sh citations in the guarantee catalogue (#1880)", () => {
  const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const entry = (text) => `## fake.sh\n\n1. ${text}\n`;
  const fake = "a() {\n  :\n}\n\nb() {\n  :\n}\n";

  it("accepts an 'about' range that holds the function's first line", () => {
    expect(aboutCitationProblems(entry("fake.sh `b` (about 4-7)"), { "fake.sh": fake })).toEqual([]);
  });

  it("reports an 'about' range that misses the function's first line, or an undefined function", () => {
    const stale = aboutCitationProblems(entry("fake.sh `b` (about 1-3), `c` (about 5-7)"), { "fake.sh": fake });
    expect(stale.map((p) => p.problem)).toEqual([
      "function starts at line 5, outside the range",
      "function not defined",
    ]);
  });

  it("reports a content citation whose lines lack the code", () => {
    const problems = fileCitationContentProblems(entry("x. fake.sh:1-3, 5-6"), fake, "fake.sh", [
      { guarantee: "fake.sh #1", index: 0, contains: ["a() {"] },
      { guarantee: "fake.sh #1", index: 1, contains: ["a() {"] },
      { guarantee: "fake.sh #1", index: 2, contains: ["a() {"] },
    ]);
    expect(problems.map((p) => p.problem)).toEqual(["lines lack a() {", "citation not found"]);
  });

  it("reports a named function that no citation of its guarantee overlaps", () => {
    const problems = fileNamedFunctionProblems(entry("`a` and `b`. fake.sh:1-3"), fake, "fake.sh");
    expect(problems.map((p) => p.citation)).toEqual(["fake.sh:1-3 [b]"]);
  });

  it("every 'about' citation in the real catalogue starts its function inside the range", () => {
    expect(aboutCitationProblems(catalogue, { "repair.sh": read("repair.sh"), "install.sh": read("install.sh") })).toEqual([]);
  });

  it("every function an installer-ui.sh guarantee names lies inside its citations", () => {
    expect(fileNamedFunctionProblems(catalogue, read("installer-ui.sh"), "installer-ui.sh")).toEqual([]);
  });

  // `index` is the segment's position among the guarantee's installer-ui.sh citations.
  const uiExpectations = [
    { guarantee: "installer-ui.sh #1", index: 0, contains: ["installer_ui_safe_field() {", "printf 'unknown'"] },
    { guarantee: "installer-ui.sh #2", index: 0, contains: ["installer_ui_elapsed() {", "printf '0s'"] },
    { guarantee: "installer-ui.sh #3", index: 0, contains: ["installer_ui_emit() {", "$# -eq 5 || $# -eq 6"] },
    { guarantee: "installer-ui.sh #4", index: 0, contains: ["[SIMULATION] "] },
    { guarantee: "installer-ui.sh #4", index: 1, contains: ["simulation=true"] },
    { guarantee: "installer-ui.sh #5", index: 0, contains: ["subshell per keystroke"] },
    { guarantee: "installer-ui.sh #6", index: 0, contains: ["osc_index < 256", "sequence_index < 32"] },
    { guarantee: "installer-ui.sh #7", index: 0, contains: ["installer_ui_read_paste() {", "[[:cntrl:]]", "return 2"] },
    { guarantee: "installer-ui.sh #8", index: 0, contains: ["${#value} -le maximum", "[[:cntrl:]]", "return 2"] },
    { guarantee: "installer-ui.sh #9", index: 0, contains: ["installer_ui_menu_render() {"] },
    { guarantee: "installer-ui.sh #9", index: 1, contains: ["installer_ui_select() {"] },
    { guarantee: "installer-ui.sh #9", index: 2, contains: ['printf \'%s\\n\\n\' "$prompt" >&"$terminal_fd"'] },
    { guarantee: "installer-ui.sh #10", index: 0, contains: ["saved_state=", "installer_ui_save_traps", "trap 'interrupted=1' INT TERM HUP"] },
    { guarantee: "installer-ui.sh #10", index: 1, contains: ['stty "$saved_state"', "installer_ui_restore_traps"] },
    { guarantee: "installer-ui.sh #10", index: 2, contains: ["installer_ui_save_traps", "trap 'interrupted=1' INT TERM HUP"] },
    { guarantee: "installer-ui.sh #10", index: 3, contains: ['stty "$saved_state"', "installer_ui_restore_traps"] },
    { guarantee: "installer-ui.sh #11", index: 0, contains: ["ORBIT_INSTALLER_PLAIN", "NO_COLOR", "dumb"] },
    { guarantee: "installer-ui.sh #12", index: 0, contains: ["installer_ui_terminal_width() {", "stty size"] },
    { guarantee: "installer-ui.sh #13", index: 0, contains: ["installer_ui_safe_field() {"] },
  ];

  it("each installer-ui.sh citation holds the code its guarantee describes", () => {
    expect(fileCitationContentProblems(catalogue, read("installer-ui.sh"), "installer-ui.sh", uiExpectations)).toEqual([]);
  });
});
