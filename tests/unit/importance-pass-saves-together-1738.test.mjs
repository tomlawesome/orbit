// @vitest-environment happy-dom
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createPageLoader, runtime, settle } from "../support/svelte-page.mjs";
import { subscribeWake } from "$lib/pocket/wake.js";

/*
 * #1738 W-R8, owner ruling BUILD (lows-g2-rulings.md): the one-time importance
 * pass (home/ImportanceOffer.svelte) saved its picks one command at a time,
 * with nothing on screen while N round trips ran, and its failure wake gave
 * one reason with no count. The ruling:
 *  - the picks go out together, at most 6 in flight, every one settled; a
 *    refused pick loses only itself;
 *  - if any failed, one wake (a failure): "<n> pick(s) not saved — <words>",
 *    n counted as `plural(n, "pick")`, <words> the first refusal's own words;
 *  - Done and finish later still close at once and keep every pick; `onsaved`
 *    once; a refused item stays unset, so the pill counts it.
 *
 * The offer is mounted in a small host (written under tmp/, git-ignored) so a
 * test can hand it the household as home re-reads it after the saves.
 */

vi.mock("$lib/data/workspace.js", async (importOriginal) => ({
  ...(await importOriginal()),
  applyCommand: (/** @type {any} */ command) => /** @type {any} */ (globalThis).__applyCommand(command),
}));
const { WorkspaceError } = await import("$lib/data/workspace.js");

const ROOT = resolve(import.meta.dirname, "../..");
const REFUSAL = "someone changed this item on another device";

const items = Array.from({ length: 10 }, (_, k) => ({
  id: `i-${k}`, title: `Thing ${k}`, sectionId: "s-home", status: "active", importance: null,
  dueDate: `2026-09-${String(k + 1).padStart(2, "0")}`, version: 1, currency: "GBP", subtype: "service", scheduleKind: "service",
}));
const household = (/** @type {any[]} */ rows) => ({ id: "hh-1", name: "Home", sections: [{ id: "s-home", name: "Home" }], items: rows });

describe("the importance pass saves its picks together (#1738 W-R8)", () => {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const host = join(ROOT, "tmp", "importance-pass-host.svelte");
  writeFileSync(host, `<script>
  import ImportanceOffer from "../web/src/routes/home/ImportanceOffer.svelte";
  let { first, onsaved } = $props();
  let current = $state(first);
  export function setHousehold(next) { current = next; }
</script>
<ImportanceOffer household={current} today="2026-08-01" dismissed={false} layout="desk" {onsaved} />
`);
  const loader = createPageLoader("importance-pass-1738", {});
  beforeAll(() => loader.setup(host));
  afterAll(() => loader.teardown());
  /** @type {(() => void) | null} */
  let stopWatching = null;
  afterEach(() => { loader.unmount(); stopWatching?.(); stopWatching = null; delete (/** @type {any} */ (globalThis)).__applyCommand; });

  /** @param {(command: any) => Promise<unknown>} apply */
  async function openPass(apply) {
    /** @type {any[]} */
    const entries = [];
    let replay = true;
    stopWatching = subscribeWake((entry) => { if (replay) { replay = false; return; } if (entry) entries.push(entry); });
    /** @type {any} */ (globalThis).__applyCommand = apply;
    /** @type {any} */
    let component = null;
    const onsaved = vi.fn(async () => {
      /* home's re-read: what saved now carries its importance, what did not stays unset */
      component.setHousehold(household(items.map((one) => (saved.has(one.id) ? { ...one, importance: "high" } : one))));
    });
    const saved = new Set();
    ({ component } = await loader.mount(host, { first: household(items), onsaved }));
    const { flushSync } = await runtime();
    await settle(); flushSync();
    const press = async (/** @type {string} */ name) => {
      const one = [...document.querySelectorAll("button")].find((el) => (el.textContent ?? "").trim() === name);
      expect(one, `the ${name} button`).toBeDefined();
      /** @type {HTMLElement} */ (one).click();
      flushSync();
      await settle();
    };
    await press("set them now");
    for (const row of document.querySelectorAll(".pl-row")) /** @type {HTMLElement} */ (row.querySelector('[data-imp="high"]')).click();
    flushSync();
    expect(document.querySelectorAll('.pl-row [aria-checked="true"]')).toHaveLength(10);
    const pill = () => (document.querySelector(".offer")?.textContent ?? "").replace(/\s+/g, " ").trim();
    return { entries, onsaved, press, saved, pill, flushSync };
  }
  const idOf = (/** @type {any} */ command) => command.item.id;

  it("10 picks, 2 refused: 8 land, one wake counts the 2, onsaved once, the pill counts the 2", async () => {
    /** @type {string[]} */
    const landed = [];
    const refused = new Set(["i-2", "i-7"]);
    const { entries, onsaved, press, saved, pill, flushSync } = await openPass(async (command) => {
      if (refused.has(idOf(command))) throw new WorkspaceError(REFUSAL, { status: 409, code: "version_conflict" });
      landed.push(idOf(command));
      saved.add(idOf(command));
    });
    await press("Done");
    await settle(); flushSync();

    expect(landed.sort()).toEqual(items.map((one) => one.id).filter((id) => !refused.has(id)));
    expect(entries).toHaveLength(1);
    expect(entries[0].failure).toBe(true);
    expect(entries[0].message).toMatch(/^2 picks not saved — /);
    expect(entries[0].message).toContain(REFUSAL);
    expect(onsaved).toHaveBeenCalledTimes(1);
    expect(pill()).toContain("2 items have no importance yet");
  });

  it("one refused pick reads \"1 pick not saved — …\"", async () => {
    const { entries, press } = await openPass(async (command) => {
      if (idOf(command) === "i-4") throw new WorkspaceError(REFUSAL, { status: 409, code: "version_conflict" });
    });
    await press("Done");
    await settle();
    expect(entries.map((entry) => entry.message)).toEqual([expect.stringMatching(/^1 pick not saved — .*someone changed this item/)]);
  });

  it("all saved: no wake, onsaved once", async () => {
    const { entries, onsaved, press } = await openPass(async () => {});
    await press("Done");
    await settle();
    expect(entries).toEqual([]);
    expect(onsaved).toHaveBeenCalledTimes(1);
  });

  it("sends the picks together, never more than 6 in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    /** @type {(() => void)[]} */
    const release = [];
    const { press, onsaved } = await openPass(() => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise((resolveSave) => { release.push(() => { inFlight -= 1; resolveSave(undefined); }); });
    });
    await press("Done");
    await settle();
    expect(peak, "six saves are out at once while the rest wait").toBe(6);
    while (release.length) { release.shift()?.(); await settle(2); expect(peak).toBeLessThanOrEqual(6); }
    await settle();
    expect(onsaved).toHaveBeenCalledTimes(1);
  });
});
