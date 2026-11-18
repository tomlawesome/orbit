import { describe, expect, it } from "vitest";
import { REMINDER_DAYS_MAX } from "../../src/lib/domain";
import { itemRefusal } from "../../src/lib/refusals";
import { parseWorkspaceCommand } from "../../src/lib/workspace";

/*
 * #1892 (owner verdict 2026-11-17, direction T): the Add form may now offer
 * any whole number of days, 1 to 365, so the server must keep refusing
 * everything outside it. The form cannot offer what the save would refuse
 * (design/v19/reminder-days/round-1/README.md, "Range"). These pin the
 * server side; they hold today and must keep holding once the form is built.
 */
const refused = (input: unknown) => {
  try {
    parseWorkspaceCommand(input);
    return false;
  } catch {
    return true;
  }
};
const upsertWith = (reminderDays: unknown[]) => ({
  type: "item.upsert",
  householdId: "our-home",
  item: { id: "mot", sectionId: "garage", title: "MOT", currency: "GBP", dueDate: "2026-11-02", reminderDays },
});

describe("the server still validates every reminder day (#1892)", () => {
  it("pins the ceiling the form's 1 to 365 range is built on", () => {
    expect(REMINDER_DAYS_MAX).toBe(365);
  });

  it.each([1, 3, 21, 90, 365])("accepts %i days before", (day) => {
    expect(refused(upsertWith([day]))).toBe(false);
  });

  it.each([366, 400, 1000])("refuses %i, past the ceiling", (day) => {
    expect(refused(upsertWith([day]))).toBe(true);
    expect(itemRefusal({ title: "MOT", sectionId: "garage", reminderDays: [day] })).toBe("reminderDays");
  });

  it.each([-1, 2.5, 0.5, Number.NaN, "21", null])("refuses %s, not a whole number of days", (day) => {
    expect(refused(upsertWith([day]))).toBe(true);
  });

  it("refuses one bad day among good ones", () => {
    expect(refused(upsertWith([14, 21, 366]))).toBe(true);
    expect(refused(upsertWith([14, 21, 365]))).toBe(false);
  });
});
