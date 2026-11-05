import { describe, expect, it } from "vitest";

import { parseWorkspaceCommand, workspaceItemSchema, workspaceSchema } from "../../src/lib/workspace";
import { WORKSPACE_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";

/*
 * #1463: `importance` on an item. The wire value is "low" | "normal" | "high",
 * or null for "not set". Reads carry null for an existing row; a write may
 * send null (an import leaves it) or omit it (an update that doesn't mention
 * it leaves it as it was). A value outside the three is refused by the parser.
 * Whether a CREATE must carry one is the engine's call (it knows if a row
 * exists): tests/integration/item-importance.test.ts.
 */
const upsert = (item = {}) => ({
  type: "item.upsert", householdId: "hh-harlow-1",
  item: { id: "i-new", sectionId: "s-home", title: "Sweep", currency: "GBP", ...item },
});

describe("item importance on the wire", () => {
  it.each(["low", "normal", "high"])("the command parser accepts %s and keeps it", (importance) => {
    const command = parseWorkspaceCommand(upsert({ importance }));
    expect(command.item.importance).toBe(importance);
  });

  it("the command parser accepts a command that does not mention it", () => {
    const command = parseWorkspaceCommand(upsert());
    expect(command.item.importance).toBeUndefined();
  });

  it.each(["urgent", "", "High", 2, true])("the command parser refuses %j", (importance) => {
    expect(() => parseWorkspaceCommand(upsert({ importance }))).toThrow();
  });

  it("the item schema takes null (not set) and the three levels, and refuses the rest", () => {
    const base = { id: "i", sectionId: "s-home", title: "T", currency: "GBP", status: "active" };
    for (const ok of [null, "low", "normal", "high"]) expect(workspaceItemSchema.safeParse({ ...base, importance: ok }).success, String(ok)).toBe(true);
    for (const bad of ["urgent", "", 1]) expect(workspaceItemSchema.safeParse({ ...base, importance: bad }).success, String(bad)).toBe(false);
  });

  it("the workspace the fixture serves carries importance on every Harlow Home item, null meaning not set", () => {
    expect(workspaceSchema.safeParse(WORKSPACE_FIXTURE).success).toBe(true);
    const harlow = WORKSPACE_FIXTURE.households.find((one) => one.id === "hh-harlow-1");
    expect(harlow.items.length).toBeGreaterThan(0);
    for (const one of harlow.items) expect(["low", "normal", "high", null], one.id).toContain(one.importance);
  });
});
