// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * #1316 (owner decision 16a, 2026-10-13; r4 rows F2 / GS-1): the first-run
 * create card, "where do you belong?", tells a reader that "the systems
 * around you are labels until someone lets you in". On an empty instance
 * nobody can let them in, so the subline reads instead:
 *
 *   no systems out here yet — the first one is yours to name
 *
 * With one or more systems the original subline stays; the heading is the
 * same in both. The test is the card's own list: no rows, new subline.
 *
 * Newcomer.svelte is compiled with Svelte's own compiler and mounted in
 * happy-dom (the shape of v19-create-partial-landing-words.test.mjs). Its two
 * child components are stood in for; neither has a part in the subline.
 */

vi.mock("../../web/src/lib/NorthStarMark.svelte", () => ({ default: () => {} }));
vi.mock("../../web/src/lib/arrival/CreateSystem.svelte", () => ({ default: () => {} }));

const EMPTY_SUBLINE = "no systems out here yet — the first one is yours to name";
const ORIGINAL_SUBLINE = "the systems around you are labels until someone lets you in";
const HEADING = "where do you belong?";

const web = resolve(import.meta.dirname, "../../web");
const svelteSrc = join(web, "node_modules/svelte/src");
/** @type {string} */
let compiledDir;
/** @type {string} */
let compiledNewcomer;

beforeAll(async () => {
  const { compile } = await import(pathToFileURL(join(svelteSrc, "compiler/index.js")).href);
  const file = join(web, "src/lib/arrival/Newcomer.svelte");
  const quoted = (/** @type {string} */ path) => JSON.stringify(path);
  const js = compile(readFileSync(file, "utf8"), { filename: file, generate: "client", dev: false }).js.code
    .replaceAll("'svelte/internal/client'", quoted(join(svelteSrc, "internal/client/index.js")))
    .replaceAll("'svelte/internal/disclose-version'", quoted(join(svelteSrc, "internal/disclose-version.js")))
    .replaceAll('from "svelte"', `from ${quoted(join(svelteSrc, "index-client.js"))}`)
    .replaceAll('"$lib/NorthStarMark.svelte"', quoted(join(web, "src/lib/NorthStarMark.svelte")))
    .replaceAll('"./CreateSystem.svelte"', quoted(join(web, "src/lib/arrival/CreateSystem.svelte")))
    .replaceAll('"./stage.js"', quoted(join(web, "src/lib/arrival/stage.js")))
    .replaceAll('"../../routes/home/placement.js"', quoted(join(web, "src/routes/home/placement.js")));
  /* Inside the checkout (tmp/ is git-ignored), so the module resolves Svelte,
     the $lib alias and the vitest transforms the way any web/ module does. */
  mkdirSync(resolve(import.meta.dirname, "../../tmp"), { recursive: true });
  compiledDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/newcomer-subline-"));
  compiledNewcomer = join(compiledDir, "newcomer.mjs");
  writeFileSync(compiledNewcomer, js);
});
afterAll(() => { rmSync(compiledDir, { recursive: true, force: true }); });

/** @type {(() => void) | null} */
let unmountCard = null;
afterEach(() => { unmountCard?.(); unmountCard = null; document.body.innerHTML = ""; });

/** Mounts the card over the given systems and returns its heading and subline. */
async function mountCard(/** @type {{ id: string, name: string, requested?: boolean }[]} */ visibleHouseholds) {
  const { mount, unmount, flushSync } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  const { default: Newcomer } = await import(/* @vite-ignore */ compiledNewcomer);
  const component = mount(Newcomer, { target: document.body, props: { visibleHouseholds } });
  unmountCard = () => unmount(component);
  flushSync();
  const top = document.querySelector(".belong .top");
  expect(top, "the belong card is drawn").not.toBeNull();
  return {
    heading: top?.querySelector("h2")?.textContent?.trim(),
    subline: top?.querySelector("p")?.textContent?.trim(),
    rows: document.querySelectorAll(".belong ul li").length,
  };
}

describe("#1316 / 16a: the belong card's subline on an empty instance", () => {
  it("with no systems, the subline says there are none yet and the first is the reader's to name", async () => {
    const card = await mountCard([]);
    expect(card.rows, "no list on an empty instance").toBe(0);
    expect(card.subline).toBe(EMPTY_SUBLINE);
  });

  it("with no systems, the heading is unchanged", async () => {
    expect((await mountCard([])).heading).toBe(HEADING);
  });

  it("with no systems, nobody is told to wait to be let in", async () => {
    await mountCard([]);
    expect(document.querySelector(".belong")?.textContent).not.toContain("until someone lets you in");
  });

  it("with one system, the original subline stays", async () => {
    const card = await mountCard([{ id: "hh-1", name: "Seaside Cottage", requested: false }]);
    expect(card.rows).toBe(1);
    expect(card.subline).toBe(ORIGINAL_SUBLINE);
  });

  it("with several systems, the original subline stays and the empty-instance line is absent", async () => {
    const card = await mountCard([
      { id: "hh-1", name: "Seaside Cottage", requested: false },
      { id: "hh-2", name: "Hill Farm", requested: true },
    ]);
    expect(card.rows).toBe(2);
    expect(card.subline).toBe(ORIGINAL_SUBLINE);
    expect(document.querySelector(".belong")?.textContent).not.toContain("no systems out here yet");
  });

  it("with systems, the heading is unchanged", async () => {
    expect((await mountCard([{ id: "hh-1", name: "Seaside Cottage" }])).heading).toBe(HEADING);
  });
});
