import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1341: one band-to-colour table. web/src/lib/data/bands.js owns BAND_VAR
 * (band -> CSS custom property name); no other file keeps its own object
 * literal mapping a band to a colour token, and every band-table import
 * comes from $lib/data/bands.js.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const SRC = join(ROOT, "web/src");
const BANDS = join(SRC, "lib/data/bands.js");
const OLD_BANDS = join(SRC, "routes/home/bands.js");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(js|svelte)$/u.test(entry.name)) out.push(full);
  }
  return out;
}

const EXPECTED = {
  overdue: "--overdue",
  "due-soon": "--warm",
  upcoming: "--upcoming",
  ok: "--ok",
  ended: "--ink-mid",
  unscheduled: "--ink-mid",
};

describe("#1341: BAND_VAR in lib/data/bands.js", () => {
  it("exports exactly the six bands with the agreed tokens", async () => {
    expect(existsSync(BANDS)).toBe(true);
    const mod = await import(BANDS);
    expect(mod.BAND_VAR).toEqual(EXPECTED);
    expect(Object.keys(mod.BAND_VAR).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("every value is a non-empty --name", async () => {
    expect(existsSync(BANDS)).toBe(true);
    const { BAND_VAR } = await import(BANDS);
    for (const [band, token] of Object.entries(BAND_VAR)) {
      expect(token, band).toMatch(/^--[a-z][a-z0-9-]*$/u);
    }
  });

  it("the old routes/home/bands.js is gone", () => {
    expect(existsSync(OLD_BANDS)).toBe(false);
  });
});

describe("#1341: tripwire - no second band-to-token table", () => {
  // An object key naming a band, and a colour token, on one line.
  const BAND_KEY = /(?:^|[\s{,])(?:"|')?(?:overdue|due-soon|upcoming|unscheduled|ended)(?:"|')?\s*:/u;
  const TOKEN = /--|var\(--/u;
  // PLANET_TONES keeps overdue -> --warm: the planet's warmth, not the band.
  const PLANET_OVERDUE = /^\s*overdue\s*:\s*["']--warm["']\s*,?\s*(?:\/\/.*)?$/u;

  it("no file but lib/data/bands.js maps a band name to a colour token", () => {
    const offenders = [];
    for (const file of walk(SRC)) {
      if (file === BANDS) continue;
      const text = readFileSync(file, "utf8");
      const hasPlanetTones = text.includes("PLANET_TONES");
      text.split("\n").forEach((line, i) => {
        if (/^\s*(?:\/\/|\*|\/\*|<!--)/u.test(line)) return; // comments are prose
        if (!BAND_KEY.test(line) || !TOKEN.test(line)) return;
        if (hasPlanetTones && PLANET_OVERDUE.test(line)) return;
        offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, `band-to-token tables outside lib/data/bands.js:\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("#1341: band tables are imported from $lib/data/bands.js", () => {
  const IMPORT = /import\s+(?:[^;]*?)\s+from\s+["']([^"']*bands(?:\.js)?)["']/gu;

  it("no import of home/bands or ./bands.js remains; all use $lib/data/bands.js", () => {
    const wrong = [];
    let good = 0;
    for (const file of walk(SRC)) {
      if (file === BANDS) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(IMPORT)) {
        if (m[1] === "$lib/data/bands.js") good += 1;
        else wrong.push(`${relative(ROOT, file)}: imports "${m[1]}"`);
      }
    }
    expect(wrong, `imports not from $lib/data/bands.js:\n${wrong.join("\n")}`).toEqual([]);
    expect(good, "at least one importer of $lib/data/bands.js").toBeGreaterThan(0);
  });
});
