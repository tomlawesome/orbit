import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// One pick-list for time zones and one for currencies (#1338): the phone's full
// lists with the six favourites first, shared by the desk, the phone and the
// arrival stage instead of three hand-kept copies.
const MODULE = pathToFileURL(join(import.meta.dirname, "..", "..", "web", "src", "lib", "pick-lists.js")).href;
const lists = () => import(/* @vite-ignore */ MODULE);

const ZONES = ["Europe/London", "Europe/Dublin", "Europe/Paris", "America/New_York", "Australia/Sydney", "UTC"];
const CURRENCIES = ["GBP", "EUR", "USD", "CAD", "AUD", "NZD"];

describe("favourites first", () => {
  it("exports the favourites in the agreed order", async () => {
    const { ZONE_FAVOURITES, CURRENCY_FAVOURITES } = await lists();
    expect(ZONE_FAVOURITES).toEqual(ZONES);
    expect(CURRENCY_FAVOURITES).toEqual(CURRENCIES);
  });

  it("puts the zone favourites first, in order, with no value twice", async () => {
    const { zoneOptions } = await lists();
    const values = zoneOptions().map((row) => row.value);
    expect(values.slice(0, ZONES.length)).toEqual(ZONES);
    expect(new Set(values).size).toBe(values.length);
    expect(values.length).toBeGreaterThan(ZONES.length);
  });

  it("puts the currency favourites first, in order, with no value twice", async () => {
    const { currencyOptions } = await lists();
    const values = currencyOptions().map((row) => row.value);
    expect(values.slice(0, CURRENCIES.length)).toEqual(CURRENCIES);
    expect(new Set(values).size).toBe(values.length);
    expect(values.length).toBeGreaterThan(CURRENCIES.length);
  });

  it("carries every zone and currency the runtime knows", async () => {
    const { zoneOptions, currencyOptions } = await lists();
    const zones = new Set(zoneOptions().map((row) => row.value));
    for (const zone of Intl.supportedValuesOf("timeZone")) expect(zones.has(zone)).toBe(true);
    const codes = new Set(currencyOptions().map((row) => row.value));
    for (const code of Intl.supportedValuesOf("currency")) expect(codes.has(code)).toBe(true);
  });
});

describe("zone values are real", () => {
  it("accepts every zone value in Intl and holds no space", async () => {
    const { zoneOptions } = await lists();
    const rows = zoneOptions();
    expect(rows.length).toBeGreaterThan(0);
    for (const { value } of rows) {
      expect(() => new Intl.DateTimeFormat("en-GB", { timeZone: value })).not.toThrow();
      expect(value).not.toContain(" ");
    }
  });
});

describe("labels", () => {
  it("shows an underscore in a zone as a space, leaving the value alone", async () => {
    const { zoneOptions } = await lists();
    const rows = zoneOptions();
    expect(rows.find((row) => row.value === "America/New_York")).toEqual({
      value: "America/New_York", label: "America/New York",
    });
    for (const { value, label } of rows) expect(label).toBe(value.replaceAll("_", " "));
  });

  it("labels a currency as its code, a dot, and its English name", async () => {
    const { currencyOptions } = await lists();
    const rows = currencyOptions();
    expect(rows.find((row) => row.value === "GBP")).toEqual({ value: "GBP", label: "GBP · British Pound" });
    const names = new Intl.DisplayNames("en", { type: "currency" });
    for (const { value, label } of rows) expect(label).toBe(`${value} · ${names.of(value)}`);
  });
});

const ROOT = join(import.meta.dirname, "..", "..", "web", "src");
const read = (/** @type {string} */ rel) => readFileSync(join(ROOT, rel), "utf8");
/** @param {string} dir @returns {string[]} */
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});

describe("no screen keeps a list of its own", () => {
  const screens = [
    "routes/household/[id]/+page.svelte",
    "routes/household/[id]/pocket.svelte",
    "lib/arrival/stage.js",
  ];

  for (const rel of screens) {
    it(`${rel} imports the shared lists and holds none`, () => {
      const text = read(rel);
      expect(text).toMatch(/from\s+["'][^"']*pick-lists(\.js)?["']/);
      expect(text).not.toContain('"Europe/Dublin"');
      expect(text).not.toContain('"NZD"');
    });
  }

  it("has no file under web/src with the literal \"America/New York\"", () => {
    const offenders = walk(ROOT)
      .filter((path) => /\.(svelte|js)$/.test(path))
      .filter((path) => readFileSync(path, "utf8").includes('"America/New York"'));
    expect(offenders).toEqual([]);
  });
});
