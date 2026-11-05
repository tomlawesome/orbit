import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #1382 (one layout switch): the phone layout shows under 840px wide or under
 * 480px tall, the desk layout otherwise (Material 3 window size classes).
 * Reads the real sources, never copies of them.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SRC = join(ROOT, "web", "src");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const POCKET = "(max-width: 839.98px), (max-height: 479.98px)";

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(css|svelte|js)$/.test(name)) out.push(p);
  }
  return out;
}
const STATIC_SCREENS = join(ROOT, "web", "static", "screens");
const FILES = [...walk(SRC), ...walk(STATIC_SCREENS)].map((p) => ({ rel: relative(ROOT, p), text: readFileSync(p, "utf8") }));

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every @media prelude (text between "@media" and "{"), comments removed. */
function mediaPreludes(text) {
  return [...stripComments(text).matchAll(/@media([^{;]*)\{/g)].map((m) => m[1].trim());
}
/** Every quoted string that holds a width/height media feature. */
function queryStrings(text) {
  return [...text.matchAll(/(["'`])((?:(?!\1)[^\n])*?\((?:min|max)-(?:width|height)\s*:(?:(?!\1)[^\n])*)\1/g)].map((m) => m[2]);
}
function queriesOf(file) {
  return [...mediaPreludes(file.text), ...queryStrings(file.text)].map((q) => ({ file: file.rel, q }));
}
const ALL_QUERIES = FILES.flatMap(queriesOf);

const OLD = [
  /max-width\s*:\s*900px/, /max-height\s*:\s*600px/,
  /min-width\s*:\s*901px/, /min-height\s*:\s*601px/,
  /max-width\s*:\s*599\.98px/,
];

describe("the one pocket/desk switch at 840/480 (#1382)", () => {
  it("POCKET_QUERY is the phone side of the switch", () => {
    const src = read("web/src/lib/pocket/media.js");
    const m = src.match(/export const POCKET_QUERY\s*=\s*(["'`])(.*?)\1/);
    expect(m, "POCKET_QUERY export").toBeTruthy();
    expect(m[2]).toBe(POCKET);
  });

  it("the home page DESK query is the desk side of the switch", () => {
    const src = read("web/src/routes/home/+page.svelte");
    const m = src.match(/const DESK\s*=\s*(["'`])(.*?)\1/);
    expect(m, "DESK constant").toBeTruthy();
    expect(m[2].replace(/\s+/g, " ")).toBe("(min-width: 840px) and (min-height: 480px)");
  });

  it("scans a non-trivial set of files and queries", () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.some((f) => f.rel.startsWith("web/static/screens/"))).toBe(true);
    expect(ALL_QUERIES.length).toBeGreaterThan(10);
  });

  it("no @media or query string in web/src or web/static/screens uses an old switch value", () => {
    const bad = ALL_QUERIES.filter(({ q }) => OLD.some((re) => re.test(q)))
      .map(({ file, q }) => `${file}: ${q}`);
    expect(bad).toEqual([]);
  });

  it("every max-height:479.98px phone condition is paired with max-width:839.98px", () => {
    const bad = ALL_QUERIES
      .filter(({ q }) => /max-height\s*:\s*479\.98px/.test(q) && !/max-width\s*:\s*839\.98px/.test(q))
      .map(({ file, q }) => `${file}: ${q}`);
    expect(bad).toEqual([]);
  });

  it("every max-width:839.98px query is paired with max-height:479.98px", () => {
    const bad = ALL_QUERIES
      .filter(({ q }) => /max-width\s*:\s*839\.98px/.test(q) && !/max-height\s*:\s*479\.98px/.test(q))
      .map(({ file, q }) => `${file}: ${q}`);
    expect(bad).toEqual([]);
  });

  const HELD_OLD_SWITCH = [
    "web/src/lib/Chrome.svelte",
    "web/src/lib/arrival/arrival.css",
    "web/src/lib/door/door.css",
    "web/src/lib/flight/door-phone.css",
    "web/src/lib/pocket/Wake.svelte",
    "web/src/lib/reading/Pager.svelte",
    "web/src/lib/tour/transport.js",
    "web/src/routes/about/about.css",
    "web/src/routes/home/pocket.css",
  ];
  it.each(HELD_OLD_SWITCH)("%s holds the new switch", (rel) => {
    const file = FILES.find((f) => f.rel === rel);
    expect(file, `${rel} exists`).toBeTruthy();
    const qs = queriesOf(file).map((x) => x.q);
    expect(
      qs.some((q) => /max-width\s*:\s*839\.98px/.test(q) || /min-width\s*:\s*840px/.test(q)),
      `${rel} has a 840 query`,
    ).toBe(true);
  });

  it("the door-phone reduced-motion rule uses the new switch", () => {
    const qs = mediaPreludes(read("web/src/lib/flight/door-phone.css"));
    const rm = qs.filter((q) => /prefers-reduced-motion/.test(q));
    expect(rm.length).toBeGreaterThan(0);
    for (const q of rm) {
      expect(q).toMatch(/max-width\s*:\s*839\.98px/);
      expect(q).toMatch(/max-height\s*:\s*479\.98px/);
    }
  });

  it("the home pocket.css pair is the 840/480 desk and phone sides", () => {
    const qs = mediaPreludes(read("web/src/routes/home/pocket.css")).map((q) => q.replace(/\s+/g, ""));
    expect(qs).toContain("(min-width:840px)and(min-height:480px)");
    expect(qs).toContain("(max-width:839.98px),(max-height:479.98px)");
  });
});

describe("no device sniffing chooses the layout (#1382)", () => {
  it.each(["web/src/lib/pocket/media.js", "web/src/routes/home/+page.svelte"])(
    "%s has no userAgent test", (rel) => {
      expect(read(rel)).not.toMatch(/userAgent/);
    });

  it("the switch queries carry no pointer or hover feature", () => {
    const desk = read("web/src/routes/home/+page.svelte").match(/const DESK\s*=\s*(["'`])(.*?)\1/);
    const pocket = read("web/src/lib/pocket/media.js").match(/POCKET_QUERY\s*=\s*(["'`])(.*?)\1/);
    expect(desk && pocket).toBeTruthy();
    for (const q of [desk[2], pocket[2]]) expect(q).not.toMatch(/pointer\s*:|hover\s*:/);
  });
});

describe("widths inside one layout are left alone (#1382 point 4)", () => {
  it("settings.css still narrows at 880px", () => {
    const hits = FILES.filter((f) => /settings[^/]*\.css$/.test(f.rel))
      .flatMap(queriesOf).filter(({ q }) => /max-width\s*:\s*880px/.test(q));
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("ADR for the layout switch (#1382)", () => {
  const dir = join(ROOT, "docs", "adr");
  const adrs = existsSync(dir)
    ? readdirSync(dir).filter((n) => /^\d{4}-.*\.md$/.test(n)).map((n) => ({ n, text: readFileSync(join(dir, n), "utf8") }))
    : [];
  const adr = adrs.find(({ n, text }) => /layout.?switch|840/i.test(n + "\n" + (text.match(/^#\s.*$/m)?.[0] ?? "")));

  it("exists, titled for the layout switch or 840", () => {
    expect(adr, "an ADR whose title mentions the layout switch or 840").toBeTruthy();
  });
  it("names 840, 480 and Material and mentions #1382", () => {
    expect(adr, "ADR present").toBeTruthy();
    expect(adr.text).toMatch(/\b840\b/);
    expect(adr.text).toMatch(/\b480\b/);
    expect(adr.text).toMatch(/Material/);
    expect(adr.text).toMatch(/#1382/);
  });
});
