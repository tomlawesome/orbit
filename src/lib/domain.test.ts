import { describe, expect, it } from "vitest";
import { getDueState, sortByDueDate, suggestNextDate, type HomeItem } from "./domain";

describe("due date rules", () => {
  it("classifies calendar dates without timezone drift", () => {
    expect(getDueState("2026-07-24", "2026-07-25")).toBe("overdue");
    expect(getDueState("2026-08-24", "2026-07-25")).toBe("due-soon");
    expect(getDueState("2026-08-25", "2026-07-25")).toBe("upcoming");
    expect(getDueState(undefined, "2026-07-25")).toBe("unscheduled");
  });

  it("orders overdue first and unscheduled last", () => {
    const base = { sectionId: "home", currency: "GBP", status: "active" } as const;
    const items: HomeItem[] = [
      { ...base, id: "none", title: "None" },
      { ...base, id: "later", title: "Later", dueDate: "2026-09-01" },
      { ...base, id: "late", title: "Late", dueDate: "2026-07-01" },
    ];
    expect(sortByDueDate(items, "2026-07-25").map((item) => item.id)).toEqual(["late", "later", "none"]);
  });

  it("clamps monthly recurrence to the target month's final day", () => {
    expect(suggestNextDate("2027-01-31", 1)).toBe("2027-02-28");
    expect(suggestNextDate("2024-02-29", 12)).toBe("2025-02-28");
  });
});
