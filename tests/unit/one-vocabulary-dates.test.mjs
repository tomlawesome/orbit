import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import * as format from "../../web/src/lib/format.js";

/*
 * #1339 (one vocabulary: dates). Owner decision, 2026-10-09: a two-digit day
 * everywhere ("05 Oct", "05 Oct 2026"). format.js exports one named variant per
 * shape (dayMonth, dayMonthYear, longDate, monthOnly, clockOf); each takes a bare
 * date ("2026-10-05") or an instant plus the household zone. Every inline
 * date formatter and the belt.js `shortDate` are replaced; maintenance/when.js
 * stays. The issue fixes the two day-month outputs only; the others are
 * pinned by what they must contain, not by exact wording.
 *
 * Reading used for the zone: the zone is the second argument (an IANA name).
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

describe("the named date variants exist (#1339)", () => {
  for (const name of ["dayMonth", "dayMonthYear", "longDate", "monthOnly", "clockOf"]) {
    it(`format.js exports ${name}`, () => {
      expect(typeof format[name], name).toBe("function");
    });
  }
});

describe("a bare date, two-digit day (#1339)", () => {
  it("dayMonth reads '05 Oct'", () => {
    expect(format.dayMonth("2026-10-05")).toBe("05 Oct");
  });

  it("dayMonthYear reads '05 Oct 2026'", () => {
    expect(format.dayMonthYear("2026-10-05")).toBe("05 Oct 2026");
  });

  it("a two-digit day stays two digits", () => {
    expect(format.dayMonth("2026-10-25")).toBe("25 Oct");
    expect(format.dayMonthYear("2026-12-31")).toBe("31 Dec 2026");
  });

  it("every month of the year has its short name", () => {
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    names.forEach((name, i) => {
      const month = String(i + 1).padStart(2, "0");
      expect(format.dayMonth(`2026-${month}-01`), name).toBe(`01 ${name}`);
    });
  });

  it("a bare date is not shifted by the machine's own zone", () => {
    expect(format.dayMonth("2026-01-01")).toBe("01 Jan");
    expect(format.dayMonth("2026-12-31")).toBe("31 Dec");
  });

  it("longDate names the day, the month and the year", () => {
    const text = format.longDate("2026-10-05");
    expect(typeof text).toBe("string");
    expect(text).toMatch(/Oct/);
    expect(text).toMatch(/2026/);
  });

  it("monthOnly names the month and carries no day or year", () => {
    const text = format.monthOnly("2026-10-05");
    expect(text).toMatch(/Oct/);
    expect(text).not.toMatch(/2026|05/);
  });
});

describe("an instant with the household zone (#1339)", () => {
  // 2026-10-05 23:30 UTC is already the 6th in Auckland and still the 5th in Los Angeles.
  const instant = "2026-10-05T23:30:00Z";

  it("dayMonth reads the day in the zone given", () => {
    expect(format.dayMonth(instant, "Pacific/Auckland")).toBe("06 Oct");
    expect(format.dayMonth(instant, "America/Los_Angeles")).toBe("05 Oct");
  });

  it("dayMonthYear reads the day in the zone given", () => {
    expect(format.dayMonthYear(instant, "Pacific/Auckland")).toBe("06 Oct 2026");
    expect(format.dayMonthYear(instant, "America/Los_Angeles")).toBe("05 Oct 2026");
  });

  it("dayMonthYear crosses the new year in the zone given", () => {
    expect(format.dayMonthYear("2026-12-31T23:30:00Z", "Pacific/Auckland")).toBe("01 Jan 2027");
  });

  it("clockOf reads the time of day in the zone given", () => {
    // 14:30 UTC on 5 October is 15:30 in London (BST): 24-hour or 12-hour, both carry 3:30.
    const text = format.clockOf("2026-10-05T14:30:00Z", "Europe/London");
    expect(text).toMatch(/15[:.]30|0?3[:.]30/);
    expect(format.clockOf("2026-10-05T14:30:00Z", "Asia/Tokyo")).toMatch(/23[:.]30|0?11[:.]30/);
  });
});

describe("source tripwires (#1339)", () => {
  it("toLocaleDateString appears only in format.js and maintenance/when.js", () => {
    const found = sourceFiles()
      .filter((path) => readFileSync(path, "utf8").includes("toLocaleDateString"))
      .map(rel)
      .sort();
    expect(found).toEqual(found.filter((f) => f === "lib/format.js" || f === "routes/maintenance/when.js"));
  });

  it("belt.js no longer exports its own shortDate", () => {
    const text = readFileSync(join(WEB_SRC, "lib/data/belt.js"), "utf8");
    expect(text).not.toMatch(/export\s+(const|function)\s+shortDate\b/);
  });

  it("at most one export named shortDate remains in web/src", () => {
    const exporters = sourceFiles().filter((path) =>
      /export\s+(const|function)\s+shortDate\b/.test(readFileSync(path, "utf8")),
    );
    expect(exporters.map(rel).length).toBeLessThanOrEqual(1);
  });

  it("each named variant is exported from exactly one file", () => {
    for (const name of ["dayMonth", "dayMonthYear", "longDate", "monthOnly", "clockOf"]) {
      const re = new RegExp(`export\\s+(const|function)\\s+${name}\\b`);
      const exporters = sourceFiles().filter((path) => re.test(readFileSync(path, "utf8")));
      expect(exporters.map(rel), name).toEqual(["lib/format.js"]);
    }
  });
});
