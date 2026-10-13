import { describe, expect, it } from "vitest";

import { DEFAULT_FINAL_WARNING_DAYS, DEFAULT_FIRST_WARNING_DAYS } from "../../src/lib/preferences.ts";
import { proposedItemOf } from "../../web/src/lib/editing/item-draft.js";
import { REMINDER_DEFAULT, blankEntry, entryOfProposal } from "../../web/src/routes/create/entry.js";

/*
 * #1316 (release audit: the forms' reminder defaults). Owner decision,
 * 2026-10-12, option (a): the pair every create form starts a new entry with
 * is the engine's own default pair, so a household that never touches the
 * reminders gets the same warnings from the form as from the engine. The
 * forms read the engine's constants here, so the two cannot drift again.
 */

const ENGINE_PAIR = [DEFAULT_FIRST_WARNING_DAYS, DEFAULT_FINAL_WARNING_DAYS];

describe("the forms' default reminders are the engine's default pair", () => {
  it("the engine's pair is the one the owner chose (14 and 3)", () => {
    expect(ENGINE_PAIR).toEqual([14, 3]);
  });

  it("the shared REMINDER_DEFAULT is the engine's pair", () => {
    expect(REMINDER_DEFAULT).toEqual(ENGINE_PAIR);
  });

  it("a blank create-form entry starts with the engine's pair", () => {
    expect(blankEntry().reminderDays).toEqual(ENGINE_PAIR);
  });

  it("an entry pre-filled from a proposal starts with the engine's pair", () => {
    expect(entryOfProposal({ title: "Home insurance renewal" }, { householdId: "hh-1" }).reminderDays).toEqual(ENGINE_PAIR);
    expect(entryOfProposal({}).reminderDays).toEqual(ENGINE_PAIR);
  });

  it("a new item proposed in the item drawer starts with the engine's pair", () => {
    const suggestion = { id: "r-1", title: "Home insurance renewal", proposal: { title: "Home insurance renewal" } };
    const item = proposedItemOf(/** @type {any} */ (suggestion), { householdId: "h1", sectionId: "s-home" });
    expect(item.reminderDays).toEqual(ENGINE_PAIR);
  });
});
