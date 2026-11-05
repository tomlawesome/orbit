// @vitest-environment happy-dom
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { draftOf, proposedItemOf } from "../../web/src/lib/editing/item-draft.js";
import { createPageLoader } from "../support/svelte-page.mjs";

/*
 * #1468 review fixes (ADR-0044: an item has no type).
 *  1. an expiry offers no repeat in the edit rows (the engine refuses one);
 *  2. a mail proposal whose schedule is an expiry offers none in review and amend;
 *  3. the five legacy marker words in subtype draw no "type" row, a free-text
 *     descriptor (what a document proposal gives) still does (#1466 note 53014,
 *     decision 3).
 * The rows learn the schedule from the draft (draftOf of the item), the only
 * thing SuggestionView hands EditRows besides the session.
 */

const page = createPageLoader("review-fixes-1468");
afterEach(() => page.unmount());
afterAll(() => page.teardown());

const labels = (/** @type {Element} */ root) => [...root.querySelectorAll(".kv > span, .p-kv > span")].map((s) => s.textContent?.trim());

const item = (over = {}) => ({
  id: "i-1", householdId: "h-1", sectionId: "s-1", status: "active", title: "Passport",
  subtype: null, scheduleKind: "renewal", provider: null, reference: null, dueDate: "2027-03-01",
  recurrenceMonths: null, costMinor: null, currency: "GBP", reminderDays: [21, 7], notes: null, ...over,
});

/** EditRows over a stand-in session whose draft is the item's own. */
async function rowsOf(/** @type {any} */ one, pocket = false) {
  const draft = draftOf(one);
  const modes = {
    edit: { id: one.id, draft, item: one, choose() {} },
    completing: null, foot: null, choosingKey: null,
  };
  const { target } = await page.mount("routes/home/EditRows.svelte", {
    modes, sections: [{ id: "s-1", name: "Home" }], pocket, scheduleKind: one.scheduleKind,
  });
  return labels(target);
}

describe("1. the edit rows of an expiry offer no repeat", () => {
  it("an expiry has no orbital period row, on the desk or the phone", async () => {
    for (const pocket of [false, true]) {
      const rows = await rowsOf(item({ scheduleKind: "expiry" }), pocket);
      expect(rows).toContain("due");
      expect(rows).not.toContain("orbital period");
      page.unmount();
    }
  });

  it("a renewal and a service item still show it", async () => {
    for (const scheduleKind of ["renewal", "service"]) {
      expect(await rowsOf(item({ scheduleKind, recurrenceMonths: 12 }))).toContain("orbital period");
      page.unmount();
    }
  });
});

describe("2. review and amend of a mail proposal that is an expiry", () => {
  const suggestion = (scheduleKind) => ({
    id: "s-9", title: "Passport", proposal: { title: "Passport", dueDate: "2027-03-01", scheduleKind, recurrenceMonths: 12 },
  });
  const proposed = (kind) => proposedItemOf(suggestion(kind), { householdId: "h-1", sectionId: "s-1" });

  it("offers no orbital period for an expiry proposal", async () => {
    const rows = await rowsOf(proposed("expiry"));
    expect(rows).not.toContain("orbital period");
  });

  it("still offers it for a renewal proposal", async () => {
    expect(await rowsOf(proposed("renewal"))).toContain("orbital period");
  });
});

describe("3. the type row: marker words are inert, a descriptor shows", () => {
  const MARKERS = ["service", "renewal", "inspection", "document", "suggestion"];
  const raw = (subtype) => item({ subtype });
  const one = (over = {}) => ({
    id: "i-1", title: "Passport", band: "ok", dueDate: "2027-03-01", days: 100, section: "Home",
    recurrenceMonths: null, costMinor: null, currency: "GBP", costIsEstimate: false, ...over,
  });

  it("ItemDrawer (phone) draws no type row for a marker word, and one for 'Insurance'", async () => {
    for (const word of MARKERS) {
      const { target } = await page.mount("routes/home/ItemDrawer.svelte", { one: one(), raw: raw(word), papers: [] });
      expect(labels(target), `subtype ${word}`).not.toContain("type");
      page.unmount();
    }
    const { target } = await page.mount("routes/home/ItemDrawer.svelte", { one: one(), raw: raw("Insurance"), papers: [] });
    expect(labels(target)).toContain("type");
    expect(target.textContent).toContain("Insurance");
  });

  it("ItemView (desk) draws no type row for a marker word, and one for 'Insurance'", async () => {
    const acts = { modes: { edit: { id: null, draft: null }, completing: null, foot: null, id: null, choosingKey: null }, sections: [] };
    const props = (subtype) => ({
      row: { id: "i-1", title: "Passport", band: "ok" }, detail: { ...raw(subtype), section: "Home", today: "2026-11-05" },
      detailBusy: false, detailProblem: null, showingDoc: null, onOpenDoc() {}, acts,
    });
    for (const word of MARKERS) {
      const { target } = await page.mount("routes/home/ItemView.svelte", props(word));
      expect(labels(target), `subtype ${word}`).not.toContain("type");
      page.unmount();
    }
    const { target } = await page.mount("routes/home/ItemView.svelte", props("Insurance"));
    expect(labels(target)).toContain("type");
  });
});
