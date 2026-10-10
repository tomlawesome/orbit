import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #1371 items 7-9: Orbit's side of the shared door. One host module calls the
 * folder's createDoor; the hand-made port is gone; Orbit's own layers (homes,
 * the sign-in gate, the lockup, the sign-out) ride on the folder's markup.
 * Source tripwires, written from the issue's specification before the code
 * (the shape of tests/unit/arm-single-source.test.mjs). Failures name files.
 *
 * Everything under web/src/lib/door/ is the imported copy (never Orbit's own
 * code), so the scans over "Orbit's source" leave it out.
 */

const root = path.resolve(import.meta.dirname, "../..");
const src = path.join(root, "web/src");
const lib = path.join(src, "lib");
const doorDir = path.join(lib, "door");

const rel = (file) => path.relative(root, file);

const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(js|ts|svelte)$/.test(entry.name))
        .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    : [];

/* Orbit's own source: everything under web/src except the imported folder */
const orbitSource = walk(src)
  .filter((file) => !file.startsWith(doorDir + path.sep))
  .sort();

const read = (file) => readFileSync(file, "utf8");

/* every module specifier a file imports, re-exports or dynamically imports */
const specifiersOf = (text) => {
  const found = [];
  for (const m of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)) found.push(m[1]);
  return found;
};

const resolveSpecifier = (file, spec) => {
  if (spec.startsWith("$lib/")) return path.join(lib, spec.slice(5));
  if (spec.startsWith(".")) return path.resolve(path.dirname(file), spec);
  return null;
};

const withoutJs = (p) => p.replace(/\.js$/, "");

describe("one host module for the shared door (item 7)", () => {
  const hostFile = path.join(lib, "door-host.js");

  it("web/src/lib/door-host.js exists", () => {
    expect(existsSync(hostFile), "web/src/lib/door-host.js is missing").toBe(true);
  });

  it("it imports createDoor from $lib/door/index.js", () => {
    const text = existsSync(hostFile) ? read(hostFile) : "";
    expect(text).toMatch(/import\s*\{[^}]*\bcreateDoor\b[^}]*\}\s*from\s*["']\$lib\/door\/index\.js["']/);
  });

  it("it calls createDoor with flags: {}", () => {
    const text = existsSync(hostFile) ? read(hostFile) : "";
    expect(text).toMatch(/createDoor\(\s*\{[\s\S]*\bflags\s*:\s*\{\s*\}/);
  });

  it("its image() map comes from import.meta.glob over ./door/img/**/*.webp", () => {
    const text = existsSync(hostFile) ? read(hostFile) : "";
    expect(text).toMatch(/import\.meta\.glob\(/);
    expect(text).toContain("./door/img/**/*.webp");
    expect(text).toMatch(/\bimage\b/);
  });

  it("the glob excludes dawn/lights-strip-*.webp", () => {
    const text = existsSync(hostFile) ? read(hostFile) : "";
    expect(text).toMatch(/["'`]!(?:[^"'`]*\/)?dawn\/lights-strip-\*\.webp["'`]/);
  });

  it("no other file under web/src calls createDoor: it is the one host module", () => {
    const callers = orbitSource
      .filter((file) => file !== hostFile && /\bcreateDoor\s*\(/.test(read(file)))
      .map(rel);
    expect(callers, `second callers of createDoor:\n${callers.join("\n")}`).toEqual([]);
  });
});

describe("the hand-made port is removed (item 8)", () => {
  const removed = ["engine", "timeline", "voyage", "chores", "first-light", "journey-clock"].map(
    (name) => path.join(lib, "flight", `${name}.js`),
  );

  for (const file of removed) {
    it(`${rel(file)} no longer exists`, () => {
      expect(existsSync(file), `${rel(file)} still exists`).toBe(false);
    });
  }

  it("nothing under web/src (outside the imported folder) imports any of the six", () => {
    const targets = new Set(removed.map(withoutJs));
    const hits = [];
    for (const file of orbitSource) {
      for (const spec of specifiersOf(read(file))) {
        const resolved = resolveSpecifier(file, spec);
        if (resolved && targets.has(withoutJs(resolved))) hits.push(`${rel(file)} imports ${spec}`);
      }
    }
    expect(hits, `imports of removed port files:\n${hits.join("\n")}`).toEqual([]);
  });
});

describe("Orbit's layers on the folder's markup (item 9)", () => {
  it("web/src/lib/flight/homes.js exports othersOf", () => {
    const file = path.join(lib, "flight", "homes.js");
    expect(existsSync(file), "web/src/lib/flight/homes.js is missing").toBe(true);
    const text = read(file);
    expect(text).toMatch(/export\s+(?:async\s+)?(?:const|let|function)\s+othersOf\b|export\s*\{[^}]*\bothersOf\b[^}]*\}/);
  });

  it("homes.js flies other households with homeProps imported from the folder", () => {
    const file = path.join(lib, "flight", "homes.js");
    const text = existsSync(file) ? read(file) : "";
    const imported = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)]
      .filter(([, names]) => /\bhomeProps\b/.test(names))
      .map(([, , spec]) => resolveSpecifier(file, spec))
      .filter(Boolean);
    expect(
      imported.some((p) => p.startsWith(doorDir + path.sep)),
      "homes.js does not import homeProps from web/src/lib/door/",
    ).toBe(true);
    expect(text).toMatch(/\bhomeProps\s*\(\s*homes\s*\)/);
  });

  /* a file of Orbit's own that builds the folder's markup */
  const buildersOf = (pattern) =>
    orbitSource.filter((file) => /\b(?:dawnMarkup|duskMarkup)\b/.test(read(file)) && pattern.test(read(file)));

  it("the sign-in content in the gate slot keeps the live status region (statePrimary / stateSub)", () => {
    const files = buildersOf(/\bstatePrimary\b/).filter((file) => {
      const text = read(file);
      return /\bstateSub\b/.test(text) && /\bgate\b/.test(text) && /aria-live|role=["']status["']/.test(text);
    });
    expect(files.length, "no dawnMarkup caller keeps statePrimary/stateSub in a live region").toBeGreaterThan(0);
  });

  it("the lockup content keeps planet-gold", () => {
    const files = buildersOf(/planet-gold/).filter((file) => /\blockup\b/.test(read(file)));
    expect(files.length, "no dawnMarkup caller passes a lockup carrying planet-gold").toBeGreaterThan(0);
  });

  it("the sign-out wraps duskMarkup() in a <main> with a visually hidden <h1>", () => {
    const files = orbitSource.filter((file) => {
      const text = read(file);
      const main = text.match(/<main\b[^>]*>([\s\S]*?)<\/main>/g) ?? [];
      return main.some((block) => {
        if (!/\bduskMarkup\s*\(/.test(block)) return false;
        const h1 = block.match(/<h1\b[^>]*>/);
        return Boolean(h1) && /sr-only|visually-?hidden|screen-?reader/i.test(h1[0]);
      });
    });
    expect(files.length, "no <main> holds duskMarkup() beside a visually hidden <h1>").toBeGreaterThan(0);
  });
});
