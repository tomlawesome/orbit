// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixtureApi } from "../support/fixture-api.mjs";
import { createPageLoader, runtime } from "../support/svelte-page.mjs";
import { WORKSPACE_FIXTURE, WORKSPACE_FIXTURE_TODAY } from "../../web/src/lib/data/fixtures/workspace.js";

/*
 * Two home-page checks moved down from the stack (#1612, ADR-0039), mounted in
 * happy-dom over the fixtures instance's own home:
 *  - tests/e2e/v19-event-horizon-label.spec.ts:48 -- the dial's overdue line
 *    is announced as the "event horizon" (#1471): one element in the dial
 *    carries the name, it is not inside an aria-hidden region, and the old
 *    "overdue line" wording is gone from the screen. Both dialects draw it
 *    (the desk's dial in +page.svelte, the phone's in pocket.svelte).
 *  - tests/e2e/v19-home-label-text.spec.ts:88 -- on the phone, a household
 *    named with markup is drawn as text under "Other skies", never as an
 *    element (WEB6, #1316). The desk half is v19-home-constellation-label-text.test.mjs.
 * What stays in the browser is that the line is drawn with an extent (layout).
 */

vi.mock("$lib/tour/watch.js", () => ({ watchTour: () => () => {} }));
vi.mock("../../web/src/routes/home/home.behaviour.js", () => ({
  mountHome: () => () => {}, mountAccount: () => () => {}, mountEmptySky: () => () => {},
}));

const PAGE = "routes/home/+page.svelte";
const PAYLOAD = "<img src=x onerror=__xss=1>";

describe("the home page, mounted", () => {
  const loader = createPageLoader("v19-home-event-horizon", {
    stub: (file) => /\/lib\/(Chrome|pocket\/Sky|pocket\/NorthStar|flight\/Leave|flight\/Dawn|sun\/Sun|NorthStarMark)\.svelte$/.test(file),
  });
  beforeAll(() => loader.setup(PAGE));
  afterAll(() => loader.teardown());
  afterEach(() => { loader.unmount(); vi.unstubAllGlobals(); });

  /** @param {{ pocket: boolean, otherName?: string }} options */
  async function mountHome({ pocket, otherName }) {
    const workspace = structuredClone(WORKSPACE_FIXTURE);
    if (otherName) {
      const other = workspace.households.find((hh) => hh.id !== workspace.activeHouseholdId);
      if (!other) throw new Error("the fixtures workspace has no second household");
      other.name = otherName;
    }
    const api = fixtureApi({ "GET /api/workspace": () => ({ workspace, fixtureToday: WORKSPACE_FIXTURE_TODAY }) });
    vi.stubGlobal("fetch", api.fetch);
    vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
      matches: pocket ? !query.includes("840") : query.includes("901"),
      media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    await loader.mount(PAGE, { data: { view: null, fixtures: true } }, { url: "http://localhost/home" });
    const { flushSync } = await runtime();
    await vi.waitFor(() => expect(document.querySelector(pocket ? ".pocket .skies, .pocket .mdial" : ".dialwrap")).not.toBeNull());
    await new Promise((done) => setTimeout(done, 0));
    flushSync();
  }

  for (const [dialect, pocket, dial] of [["desk", false, ".dialwrap"], ["phone", true, ".mdial"]]) {
    it(`${dialect}: the dial's overdue line is announced as the event horizon`, async () => {
      await mountHome({ pocket: /** @type {boolean} */ (pocket) });
      const dials = [...document.querySelectorAll(/** @type {string} */ (dial))];
      expect(dials.length).toBeGreaterThan(0);
      const horizon = dials.flatMap((one) => [...one.querySelectorAll('[aria-label*="event horizon" i]')]);
      expect(horizon).toHaveLength(1);
      const line = horizon[0];
      expect(line.getAttribute("role")).toBe("img");
      expect(line.getAttribute("aria-label")).toMatch(/^event horizon/i);
      expect(line.closest('[aria-hidden="true"]')).toBeNull();
      expect(document.querySelectorAll('[aria-label*="overdue line" i]')).toHaveLength(0);
      expect(document.body.textContent).not.toMatch(/overdue line/i);
    });
  }

  it("phone: a markup-looking household name is listed as text under other skies", async () => {
    await mountHome({ pocket: true, otherName: PAYLOAD });
    const skies = [...document.querySelectorAll('[role="region"]')].find((el) => el.getAttribute("aria-label") === "Other skies");
    expect(skies).toBeTruthy();
    expect(skies?.textContent).toContain(PAYLOAD);
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(/** @type {any} */ (window).__xss).toBeUndefined();
  });
});
