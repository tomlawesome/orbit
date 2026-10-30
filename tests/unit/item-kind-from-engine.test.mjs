import { describe, expect, it } from "vitest";

import { entryOf } from "../../web/src/routes/create/entry.js";
import { corridorOf, dialBodiesOf, manifestRowOf } from "../../web/src/lib/data/chart.js";

/*
 * #1346 (from #1328, WI-16): the engine sends each item's `kind`; the browser
 * reads it and stops inferring it from subtype and schedule. Each item below
 * is built so its fields would infer one kind while its `kind` says another:
 * the answer must follow `kind`. The chart keeps its own display word for the
 * engine's kinds (a document is an "expiry" there); the other three read the
 * same.
 */

const TODAY = "2026-08-13";

const item = (over) => ({
  id: "i-1", title: "Thing", sectionId: "s-home", status: "active", currency: "GBP",
  dueDate: "2026-09-20", recurrenceMonths: 12, ...over,
});
const household = (...items) => ({
  id: "hh-1", sections: [{ id: "s-home", name: "Home" }], items, activities: [],
});

describe("entry.js reads the payload's kind (create form)", () => {
  it.each([
    ["service", { subtype: "service", scheduleKind: "service" }, "renewal"],
    ["renewal", { subtype: "renewal", scheduleKind: "renewal" }, "inspection"],
    ["inspection", { subtype: "inspection", scheduleKind: "service" }, "service"],
    ["document", { scheduleKind: "expiry" }, "service"],
    ["suggestion", { subtype: "service", scheduleKind: "service" }, "suggestion"],
  ])("fields that read as %s, kind says otherwise", (_inferred, fields, kind) => {
    expect(entryOf(item({ ...fields, kind })).kind).toBe(kind);
  });

  it("takes the kind from the payload when the fields say nothing", () => {
    expect(entryOf(item({ kind: "document" })).kind).toBe("document");
    expect(entryOf(item({ kind: "inspection" })).kind).toBe("inspection");
  });

  it("lights no chip when the engine sent no kind, whatever the fields would infer", () => {
    expect(entryOf(item({ subtype: "inspection", scheduleKind: "service", kind: null })).kind).toBeNull();
  });
});

describe("chart.js reads the payload's kind", () => {
  it("dial bodies follow kind, not subtype or schedule", () => {
    const bodies = dialBodiesOf(household(
      item({ id: "a", subtype: "service", scheduleKind: "service", kind: "renewal" }),
      item({ id: "b", subtype: "renewal", scheduleKind: "renewal", kind: "inspection", dueDate: "2026-09-21" }),
      item({ id: "c", subtype: "inspection", scheduleKind: "service", kind: "service", dueDate: "2026-09-22" }),
    ), { today: TODAY });
    const kindOf = (id) => bodies.find((body) => body.id === id)?.kind;
    expect(kindOf("a")).toBe("renewal");
    expect(kindOf("b")).toBe("inspection");
    expect(kindOf("c")).toBe("service");
  });

  it("manifest rows follow kind, not subtype or schedule", () => {
    const home = household();
    const row = (fields) => manifestRowOf(home, item(fields), TODAY);
    expect(row({ subtype: "inspection", scheduleKind: "service", kind: "renewal" }).kind).toBe("renewal");
    expect(row({ subtype: "renewal", scheduleKind: "renewal", kind: "service" }).kind).toBe("service");
    expect(row({ scheduleKind: "service", kind: "inspection" }).kind).toBe("inspection");
  });

  it("a document is the chart's own word, expiry, whatever its fields infer", () => {
    const home = household();
    expect(manifestRowOf(home, item({ subtype: "service", scheduleKind: "service", kind: "document" }), TODAY).kind).toBe("expiry");
    expect(manifestRowOf(home, item({ kind: "document" }), TODAY).kind).toBe("expiry");
    const bodies = dialBodiesOf(household(item({ id: "d", scheduleKind: "service", kind: "document" })), { today: TODAY });
    expect(bodies.find((body) => body.id === "d")?.kind).toBe("expiry");
  });

  it("a document that has ended is ended, not overdue; an expiry-shaped service is still overdue", () => {
    const home = household();
    const past = "2026-07-20";
    expect(manifestRowOf(home, item({ scheduleKind: "service", kind: "document", dueDate: past }), TODAY).band).toBe("ended");
    expect(manifestRowOf(home, item({ scheduleKind: "expiry", kind: "service", dueDate: past, recurrenceMonths: undefined }), TODAY).band).toBe("overdue");
  });

  it("the corridor's rows follow kind too", () => {
    const workspace = {
      activeHouseholdId: "hh-1",
      households: [{
        ...household(item({ id: "c-1", subtype: "service", scheduleKind: "service", kind: "inspection", dueDate: "2026-09-20" })),
        name: "Home", timezone: "Europe/London",
      }],
      visibleHouseholds: [],
    };
    const corridor = corridorOf(workspace, TODAY);
    const rows = [...corridor.overdue, ...corridor.current, ...corridor.months.flatMap((month) => month.rows)];
    expect(rows.find((row) => row.id === "c-1")?.kind).toBe("inspection");
  });
});
