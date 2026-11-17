// @vitest-environment happy-dom
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixtureApi } from "../support/fixture-api.mjs";
import { createPageLoader, runtime } from "../support/svelte-page.mjs";
import { subscribeWake } from "$lib/pocket/wake.js";
import { readHome } from "$lib/data/workspace.js";

/*
 * #1604 W-R9, owner ruling BUILD (lows-g2-rulings.md): on a phone, tapping a
 * search result for an item that is gone from the household (its paper was
 * read while the item still stood; the item was deleted elsewhere since)
 * opens nothing today and says nothing. The ruling: the sheet stays closed,
 * the pocket's own wake says, politely (not a failure, no undo),
 *     “<title>” is no longer in your orbit
 * (`that item is no longer in your orbit` when the row showed no title), then
 * home is read again (`onchanged`) and the papers are read again, so the row
 * drops out because its data was re-read. A result that IS held opens its row
 * with no wake.
 *
 * The pocket is mounted inside a small host (written under tmp/, git-ignored)
 * so the test can hand it a newer view, as the page does after another device
 * deletes an item.
 */

const POCKET = "routes/home/pocket.svelte";
const MOT = { id: "i-mot", title: "Car MOT — Volvo V60" };
const DOCUMENT = { id: "d-mot", displayName: "MOT certificate 2025", mediaType: "application/pdf", sizeBytes: 1000, scanStatus: "clean", lifecycle: "available", ready: true };

vi.mock("$lib/tour/watch.js", () => ({ watchTour: () => () => {} }));

describe("pocket search: a result for an item deleted elsewhere (#1604 W-R9)", () => {
  mkdirSync(join(resolve(import.meta.dirname, "../.."), "tmp"), { recursive: true });
  const host = join(resolve(import.meta.dirname, "../.."), "tmp", "pocket-search-deleted-host.svelte");
  writeFileSync(host, `<script>
  import Pocket from "../web/src/routes/home/pocket.svelte";
  let { first, onchanged } = $props();
  let view = $state(first);
  export function setView(next) { view = next; }
</script>
<Pocket {view} {onchanged} />
`);
  const loader = createPageLoader("pocket-search-deleted-1604", {
    stub: (file) => /\/lib\/(Chrome|pocket\/Sky|pocket\/NorthStar|flight\/Leave|flight\/Dawn|sun\/Sun|NorthStarMark)\.svelte$/.test(file),
  });
  beforeAll(() => loader.setup(host));
  afterAll(() => loader.teardown());
  /** @type {(() => void) | null} */
  let stopWatching = null;
  afterEach(() => { loader.unmount(); stopWatching?.(); stopWatching = null; vi.unstubAllGlobals(); });

  async function mountPocket() {
    /** @type {Record<string, number>} */
    const paperReads = {};
    const api = fixtureApi({
      "GET /api/households/*/items/*/documents": ({ path }) => {
        const item = path.split("/")[5];
        paperReads[item] = (paperReads[item] ?? 0) + 1;
        return { documents: item === MOT.id ? [DOCUMENT] : [] };
      },
    });
    vi.stubGlobal("fetch", api.fetch);
    vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
      matches: !query.includes("840"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    const before = await readHome(api.fetch);
    /** @type {string[]} */
    const wakes = [];
    /** @type {any[]} */
    const entries = [];
    let replay = true;
    stopWatching = subscribeWake((entry) => { if (replay) { replay = false; return; } if (entry) { wakes.push(entry.message); entries.push(entry); } });
    const onchanged = vi.fn(async () => {});
    const { component, flushSync } = await loader.mount(host, { first: before, onchanged }, { url: "http://localhost/home" });
    await vi.waitFor(() => expect(document.querySelector(".pocket .pk-below [data-row]")).not.toBeNull());
    const { flushSync: flush } = await runtime();
    const settle = async () => { await new Promise((done) => setTimeout(done, 0)); flush(); };
    await settle();
    void flushSync;
    return { before, component: /** @type {any} */ (component), onchanged, wakes, entries, paperReads, settle };
  }

  const $ = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (document.querySelector(selector));
  const $$ = (/** @type {string} */ selector) => /** @type {HTMLElement[]} */ ([...document.querySelectorAll(selector)]);

  /** Opens the search sheet and types. @param {() => Promise<void>} settle @param {string} words */
  async function search(settle, words) {
    $(".msearch").click();
    await settle();
    const field = /** @type {HTMLInputElement} */ ($(".pk-field"));
    field.value = words;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
  }
  const resultFor = (/** @type {string} */ words) => $$(".pk-results [data-row-face]").find((el) => el.textContent?.includes(words));

  it("closes the sheet, says the item is no longer in the orbit, and reads home and the papers again", async () => {
    const { before, component, onchanged, wakes, entries, paperReads, settle } = await mountPocket();
    $(".msearch").click();
    await settle();
    await vi.waitFor(() => expect(paperReads[MOT.id]).toBe(1));
    await settle();
    /* the car's MOT is deleted on another device; home's data has caught up, the cached paper has not */
    const after = structuredClone(before);
    after.household.items = after.household.items.filter((/** @type {{ id: string }} */ item) => item.id !== MOT.id);
    component.setView(after);
    await settle();
    const field = /** @type {HTMLInputElement} */ ($(".pk-field"));
    field.value = "MOT certificate";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const hit = resultFor(MOT.title);
    expect(hit, "the cached paper still lists its item as a result").toBeDefined();
    const paperReadsBefore = Object.values(paperReads).reduce((sum, n) => sum + n, 0);

    /** @type {HTMLElement} */ (hit).click();
    await settle();
    await settle();

    expect($$(".p-sheet-layer.open"), "the sheet stays closed").toHaveLength(0);
    expect(wakes).toEqual([`“${MOT.title}” is no longer in your orbit`]);
    expect(entries[0].failure, "polite, not a failure").toBe(false);
    expect(entries[0].undo, "nothing to undo").toBeNull();
    expect(onchanged, "home is read again, once").toHaveBeenCalledTimes(1);
    const paperReadsAfter = Object.values(paperReads).reduce((sum, n) => sum + n, 0);
    expect(paperReadsAfter, "the papers are read again, so the orphan drops out").toBeGreaterThan(paperReadsBefore);
  });

  it("a result that is held still opens its row, with no wake and no re-read", async () => {
    const { onchanged, wakes, settle } = await mountPocket();
    await search(settle, "Chimney");
    /** @type {HTMLElement} */ (resultFor("Chimney sweep")).click();
    await settle();
    await settle();
    expect(document.querySelector('.pocket .pk-below [data-row-key="i-chimney"]')?.hasAttribute("data-open")).toBe(true);
    expect(wakes).toEqual([]);
    expect(onchanged).not.toHaveBeenCalled();
  });
});
