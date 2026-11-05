import { describe, expect, it } from "vitest";

import { blankEntry, createCommandOf, entryOf, intentOf } from "../../web/src/routes/create/entry.js";

/*
 * #1463: the Add form holds an `importance` ("low" | "normal" | "high", or
 * null until one is picked: nothing is pressed to begin with and there is no
 * default). It travels on the create command; an entry that has none sends
 * no `importance` key at all, so an update that doesn't mention it leaves it.
 */
describe("the entry's importance", () => {
  it("starts null: nothing chosen, no default", () => {
    expect(blankEntry().importance).toBeNull();
    expect(blankEntry({ name: "Sweep", householdId: "h1" }).importance).toBeNull();
  });

  it("is read from an existing item, null when the item has none", () => {
    expect(entryOf({ title: "T", importance: "high" }).importance).toBe("high");
    expect(entryOf({ title: "T", importance: null }).importance).toBeNull();
    expect(entryOf({ title: "T" }).importance).toBeNull();
  });

  it.each(["low", "normal", "high"])("goes on the create command as %s", (importance) => {
    const entry = { ...blankEntry({ name: "Sweep", householdId: "h1" }), sectionId: "s-home", kind: "service", importance };
    const command = createCommandOf(entry, { householdId: "h1", currency: "GBP", id: "i-1" });
    expect(command.item.importance).toBe(importance);
  });

  it("leaves the key out when none is chosen", () => {
    const entry = { ...blankEntry({ name: "Sweep", householdId: "h1" }), sectionId: "s-home" };
    expect("importance" in intentOf(entry)).toBe(false);
    expect("importance" in createCommandOf(entry, { householdId: "h1", currency: "GBP", id: "i-1" }).item).toBe(false);
  });
});
