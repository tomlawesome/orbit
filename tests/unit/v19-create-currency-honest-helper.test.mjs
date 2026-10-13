// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * #1316 (owner decision 17a, 2026-10-13; r4 row GS-2): the first-run create
 * card reads the currency off the browser's language, against a short list of
 * regions (GB, IE, FR, DE, US, CA, AU, NZ). When the language has a region on
 * that list the helper (the title on the currency select) keeps saying the
 * value was read off the browser. When it has no region ("en"), a region off
 * the list ("de-AT", "fr-BE"), or Intl.Locale throws, detection fell back to
 * a default and the helper must say so:
 *
 *   your browser didn't say a currency we know — change it in settings
 *
 * The time zone helper is unchanged. Same harness as
 * v19-create-zone-honest-helper.test.mjs, with navigator.language (and
 * Intl.Locale) stubbed; the browser's zone is pinned to a listed one.
 */

const FALLBACK_NOTE = "your browser didn't say a currency we know — change it in settings";
const READ_OFF = "Read off your browser. It moves to settings afterwards, and costs read by it.";
const ZONE_OFF_LIST_NOTE = "your browser's zone isn't on this short list — change it in settings";

const web = resolve(import.meta.dirname, "../../web");
const svelteSrc = join(web, "node_modules/svelte/src");
/** @type {string} */
let compiledDir;
/** @type {string} */
let compiledCard;

beforeAll(async () => {
  const { compile } = await import(pathToFileURL(join(svelteSrc, "compiler/index.js")).href);
  const file = join(web, "src/lib/arrival/CreateSystem.svelte");
  const quoted = (/** @type {string} */ path) => JSON.stringify(path);
  const js = compile(readFileSync(file, "utf8"), { filename: file, generate: "client", dev: false }).js.code
    .replaceAll("'svelte/internal/client'", quoted(join(svelteSrc, "internal/client/index.js")))
    .replaceAll("'svelte/internal/disclose-version'", quoted(join(svelteSrc, "internal/disclose-version.js")))
    .replaceAll('from "svelte"', `from ${quoted(join(svelteSrc, "index-client.js"))}`)
    .replaceAll('"./stage.js"', quoted(join(web, "src/lib/arrival/stage.js")));
  /* Inside the checkout (tmp/ is git-ignored), so the module resolves Svelte,
     the $lib alias and the vitest transforms the way any web/ module does. */
  mkdirSync(resolve(import.meta.dirname, "../../tmp"), { recursive: true });
  compiledDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/create-currency-helper-"));
  compiledCard = join(compiledDir, "create-system.mjs");
  writeFileSync(compiledCard, js);
});
afterAll(() => { rmSync(compiledDir, { recursive: true, force: true }); });

/** @type {(() => void) | null} */
let unmountCard = null;
afterEach(() => {
  unmountCard?.();
  unmountCard = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/** Mounts the card while the browser reports `language`; returns the currency and zone helpers. */
async function mountCard(/** @type {string} */ language, /** @type {{ localeThrows?: boolean, zone?: string }} */ options = {}) {
  const { mount, unmount, flushSync } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  const { default: CreateSystem } = await import(/* @vite-ignore */ compiledCard);
  await import(pathToFileURL(join(web, "src/lib/arrival/stage.js")).href);
  vi.spyOn(navigator, "language", "get").mockReturnValue(language);
  if (options.localeThrows) {
    vi.spyOn(Intl, "Locale").mockImplementation(function () { throw new RangeError("Incorrect locale information provided"); });
  }
  const real = Intl.DateTimeFormat;
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (/** @type {any[]} */ ...args) {
    const format = new real(...args);
    return { ...format, format: format.format.bind(format), formatToParts: format.formatToParts.bind(format),
      resolvedOptions: () => ({ ...format.resolvedOptions(), timeZone: options.zone ?? "Europe/Paris" }) };
  });
  const component = mount(CreateSystem, { target: document.body, props: {} });
  unmountCard = () => unmount(component);
  flushSync();
  const currency = document.querySelector("#cur");
  const zone = document.querySelector("#tz");
  expect(currency, "the currency field is drawn").not.toBeNull();
  expect(zone, "the time zone field is drawn").not.toBeNull();
  return { helper: currency?.getAttribute("title") ?? "", zoneHelper: zone?.getAttribute("title") ?? "" };
}

describe("#1316 / 17a: the create card's currency helper tells the truth about detection", () => {
  for (const language of ["en-GB", "de-DE", "en-US"]) {
    it(`a mapped region (${language}): the helper is unchanged`, async () => {
      const card = await mountCard(language);
      expect(card.helper).toBe(READ_OFF);
    });
  }

  for (const language of ["en", "de-AT", "fr-BE"]) {
    it(`no mapped region (${language}): the helper says it fell back`, async () => {
      const card = await mountCard(language);
      expect(card.helper).toBe(FALLBACK_NOTE);
    });
  }

  it("Intl.Locale throws: the helper says it fell back", async () => {
    const card = await mountCard("en-GB", { localeThrows: true });
    expect(card.helper).toBe(FALLBACK_NOTE);
  });

  it("a fallback currency helper no longer claims the value was read off the browser", async () => {
    const card = await mountCard("de-AT");
    expect(card.helper).not.toMatch(/read off your browser/i);
  });

  it("the zone helper is unchanged: listed zone reads off the browser, whatever the language", async () => {
    const card = await mountCard("de-AT");
    expect(card.zoneHelper).toMatch(/read off your browser/i);
    expect(card.zoneHelper).not.toContain(ZONE_OFF_LIST_NOTE);
  });

  it("the zone helper is unchanged: an off-list zone still says so, even with a mapped currency region", async () => {
    const card = await mountCard("en-US", { zone: "America/Chicago" });
    expect(card.zoneHelper).toBe(ZONE_OFF_LIST_NOTE);
    expect(card.helper).toBe(READ_OFF);
  });
});
