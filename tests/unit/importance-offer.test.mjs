import { describe, expect, it } from "vitest";

import { importanceOfferOf, passRowsOf } from "../../web/src/lib/data/importance-offer.js";

/*
 * #1463, round 7 U: when home shows the quiet "N items have no importance
 * yet" pill, and which items the one-time pass lists.
 *
 * Fixed for the build: web/src/lib/data/importance-offer.js exports
 *  - importanceOfferOf(items, { dismissed }) -> { show: boolean, count: number }
 *    `count` is the active items whose importance is null or missing, and
 *    `show` is count > 0 and not dismissed.
 *  - passRowsOf(items) -> the active unset items, nearest due first
 *    (earliest dueDate first; an item with no date last), as the same objects.
 */
const item = (id, importance, dueDate, status = "active") => ({ id, importance, dueDate, status });

describe("importanceOfferOf", () => {
  it("shows with the count of unset active items when not dismissed", () => {
    const offer = importanceOfferOf([item("a", null, "2026-12-01"), item("b", "high", "2026-12-02"), item("c", null, "2026-12-03")], { dismissed: false });
    expect(offer).toEqual({ show: true, count: 2 });
  });

  it("counts an item with no importance field as unset", () => {
    expect(importanceOfferOf([{ id: "a", status: "active", dueDate: "2026-12-01" }], { dismissed: false })).toEqual({ show: true, count: 1 });
  });

  it("is hidden once every item has a level", () => {
    expect(importanceOfferOf([item("a", "low", "2026-12-01"), item("b", "normal", null)], { dismissed: false })).toEqual({ show: false, count: 0 });
  });

  it("is hidden for good when dismissed, however many are unset", () => {
    const offer = importanceOfferOf([item("a", null, "2026-12-01"), item("b", null, "2026-12-02")], { dismissed: true });
    expect(offer.show).toBe(false);
  });

  it("is hidden for a household with no items", () => {
    expect(importanceOfferOf([], { dismissed: false })).toEqual({ show: false, count: 0 });
  });

  it("does not count items that are not active", () => {
    const offer = importanceOfferOf([item("a", null, "2026-12-01", "archived"), item("b", null, "2026-12-02", "cancelled")], { dismissed: false });
    expect(offer).toEqual({ show: false, count: 0 });
  });
});

describe("passRowsOf", () => {
  it("lists only the unset active items, nearest due first, undated last", () => {
    const rows = passRowsOf([
      item("late", null, "2027-01-21"),
      item("set", "high", "2026-07-28"),
      item("none", null, null),
      item("early", null, "2026-08-29"),
      item("gone", null, "2026-09-01", "archived"),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["early", "late", "none"]);
  });

  it("does not change the order of the items it is given", () => {
    const items = [item("b", null, "2026-12-02"), item("a", null, "2026-12-01")];
    passRowsOf(items);
    expect(items.map((i) => i.id)).toEqual(["b", "a"]);
  });
});
