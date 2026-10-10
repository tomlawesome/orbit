import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import * as format from "../../web/src/lib/format.js";
import { WorkspaceError, wordsOf } from "../../web/src/lib/data/workspace.js";

/*
 * #1340 (one vocabulary: sizes, initials, symbols, plurals, recurrence, elapsed
 * time, error words). Each helper lives once in format.js (wordsOf beside
 * WorkspaceError) and every copy is replaced. The issue fixes: sizeLabel (under
 * 1 KB "N B", under 1 MB whole KB, else MB with one decimal); initials (always
 * "·" on blank); symbolOf via Intl; plural(n, word); every(12) "every year",
 * every(24) "every 2 years"; wordsOf(error, fallback). Everything else is
 * pinned by shape only.
 */

const WEB_SRC = join(process.cwd(), "web/src");
function sourceFiles(dir = WEB_SRC) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(js|mjs|ts|svelte)$/.test(entry.name)) out.push(path);
  }
  return out;
}
const rel = (path) => relative(WEB_SRC, path).split("\\").join("/");

describe("the helpers exist (#1340)", () => {
  for (const name of ["sizeLabel", "initials", "symbolOf", "plural", "every", "tminus", "elapsed"]) {
    it(`format.js exports ${name}`, () => {
      expect(typeof format[name], name).toBe("function");
    });
  }
  it("format.js exports MONTHS", () => {
    expect(Array.isArray(format.MONTHS)).toBe(true);
  });
  it("wordsOf is exported beside WorkspaceError", () => {
    expect(typeof wordsOf).toBe("function");
  });
});

describe("sizeLabel", () => {
  it("under 1 KB reads 'N B'", () => {
    expect(format.sizeLabel(0)).toBe("0 B");
    expect(format.sizeLabel(1)).toBe("1 B");
    expect(format.sizeLabel(1023)).toBe("1023 B");
  });

  it("under 1 MB reads a whole number of KB", () => {
    expect(format.sizeLabel(1024)).toBe("1 KB");
    expect(format.sizeLabel(2048)).toBe("2 KB");
    expect(format.sizeLabel(102400)).toBe("100 KB");
    expect(format.sizeLabel(1536)).toMatch(/^\d+ KB$/);
    expect(format.sizeLabel(1000000)).toMatch(/^\d+ KB$/);
  });

  it("from 1 MB up reads MB with one decimal", () => {
    expect(format.sizeLabel(1048576)).toBe("1.0 MB");
    expect(format.sizeLabel(1572864)).toBe("1.5 MB");
    expect(format.sizeLabel(5242880)).toBe("5.0 MB");
    expect(format.sizeLabel(52428800)).toBe("50.0 MB");
  });
});

describe("initials", () => {
  it("is '·' on every kind of blank", () => {
    for (const blank of ["", "   ", null, undefined]) {
      expect(format.initials(blank), String(blank)).toBe("·");
    }
  });

  it("takes the first letter of each of two words, upper case", () => {
    expect(format.initials("Tom Lawson")).toBe("TL");
    expect(format.initials("tom lawson")).toBe("TL");
  });

  it("is never empty for a real name", () => {
    expect(format.initials("Tom")).toMatch(/^T/);
  });
});

describe("symbolOf", () => {
  it("gives the symbol Intl gives", () => {
    expect(format.symbolOf("GBP")).toBe("£");
    expect(format.symbolOf("EUR")).toBe("€");
    expect(format.symbolOf("USD")).toMatch(/\$/);
  });

  it("is not limited to a three-entry table", () => {
    expect(format.symbolOf("JPY")).toMatch(/[¥￥]/);
  });
});

describe("plural", () => {
  it("one is singular, anything else is plural", () => {
    expect(format.plural(1, "task")).toMatch(/^(1 )?task$/);
    expect(format.plural(2, "task")).toMatch(/^(2 )?tasks$/);
    expect(format.plural(0, "task")).toMatch(/^(0 )?tasks$/);
    expect(format.plural(12, "item")).toMatch(/^(12 )?items$/);
  });
});

describe("every (recurrence)", () => {
  it("12 months reads 'every year' and 24 'every 2 years' (owner decision)", () => {
    expect(format.every(12)).toBe("every year");
    expect(format.every(24)).toBe("every 2 years");
  });

  it("other counts of months are still phrased 'every ... month'", () => {
    expect(format.every(1)).toMatch(/^every .*month/);
    expect(format.every(3)).toMatch(/^every .*3.*month/);
    expect(format.every(6)).toMatch(/^every .*6.*month/);
  });
});

describe("MONTHS", () => {
  it("lists the twelve months in order", () => {
    expect(format.MONTHS).toHaveLength(12);
    const starts = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    starts.forEach((start, i) => expect(format.MONTHS[i], start).toMatch(new RegExp(`^${start}`)));
  });
});

describe("wordsOf (error words)", () => {
  it("gives an error's own message", () => {
    expect(wordsOf(new Error("the disk is full"), "Could not save.")).toBe("the disk is full");
  });

  it("gives a WorkspaceError's message", () => {
    expect(wordsOf(new WorkspaceError("not allowed", { status: 403 }), "Could not save.")).toBe("not allowed");
  });

  it("uses the screen's fallback when there is nothing to say", () => {
    expect(wordsOf(null, "Could not save.")).toBe("Could not save.");
    expect(wordsOf(undefined, "Could not save.")).toBe("Could not save.");
    expect(wordsOf(new Error(""), "Could not save.")).toBe("Could not save.");
  });
});

describe("source tripwires (#1340)", () => {
  it("each helper is defined once, in format.js", () => {
    for (const name of ["sizeLabel", "initials", "symbolOf", "plural", "every", "tminus", "elapsed", "MONTHS"]) {
      const re = new RegExp(`export\\s+(const|function)\\s+${name}\\b`);
      const exporters = sourceFiles().filter((path) => re.test(readFileSync(path, "utf8")));
      expect(exporters.map(rel), name).toEqual(["lib/format.js"]);
    }
  });

  it("wordsOf is defined once, in the module that defines WorkspaceError", () => {
    const re = /export\s+(const|function)\s+wordsOf\b/;
    const exporters = sourceFiles().filter((path) => re.test(readFileSync(path, "utf8")));
    expect(exporters.map(rel)).toEqual(["lib/data/workspace.js"]);
  });

  it("`error?.message ?? String(error)` appears nowhere outside workspace.js", () => {
    const re = /\b\w+\?\.message\s*\?\?\s*String\(\s*\w+\s*\)/;
    const offenders = sourceFiles()
      .filter((path) => rel(path) !== "lib/data/workspace.js")
      .filter((path) => re.test(readFileSync(path, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("no month-name table is spelled out outside format.js and maintenance/when.js", () => {
    const re = /["']Jan["']\s*,\s*["']Feb["']\s*,\s*["']Mar["']/;
    const offenders = sourceFiles()
      .filter((path) => !["lib/format.js", "routes/maintenance/when.js"].includes(rel(path)))
      .filter((path) => re.test(readFileSync(path, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  /* #1340 done-when: `costMinor === 0` renders the same on every row. A
     truthy test hides a free (0) cost that the item rows show as "£0.00". */
  it("no row hides a zero cost behind a truthy costMinor test", () => {
    const re = /\bcostMinor\s*\?(?![?:.])/;
    const offenders = sourceFiles()
      .filter((path) => re.test(readFileSync(path, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
