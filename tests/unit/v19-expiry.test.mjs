import { describe, expect, it } from "vitest";

/*
 * One-off expirations (#1005). A warranty, a guarantee or a fixed-term
 * agreement ends on a day that never comes round again, and once that day is
 * past nothing is owed: it lingers quietly for a fortnight and then leaves.
 *
 * The transforms under test are plain ESM inside web/, which root vitest
 * excludes from COLLECTION (#425) but not from import — the same arrangement
 * v19-chart and v19-belt already rely on.
 */
import {
  bandOfKind,
  corridorOf,
  dialBodiesOf,
  kindOfItem,
  manifestGroupsOf,
} from "../../web/src/lib/data/chart.js";
import { beltManifestOf, whenOf } from "../../web/src/lib/data/belt.js";
import {
  expirySweepBoundary,
  expirySweepIsDue,
  reminderWords,
} from "../../src/server/notification-worker";

const TODAY = "2026-08-13"; // DESIGN_TODAY: the date every mockup was drawn against

/** One item, spelled out only where the transform reads it. */
const itemOf = (over = {}) => ({
  id: "i-expiry",
  sectionId: "s-home",
  title: "Cavity wall guarantee",
  status: "active",
  currency: "GBP",
  costMinor: 14900,
  scheduleKind: "expiry",
  dueDate: "2026-09-02",
  ...over,
});

const householdOf = (items) => ({
  id: "h-1",
  name: "Lawson",
  sections: [{ id: "s-home", name: "Home" }],
  items,
});

const bodiesOf = (items) => dialBodiesOf(householdOf(items), { today: TODAY });

describe("the expiry's kind", () => {
  it("reads off the schedule kind, ahead of the subtype", () => {
    expect(kindOfItem(itemOf())).toBe("expiry");
    /* An inspection comes round again; a one-off ending does not, so the
       schedule kind wins the face. */
    expect(kindOfItem(itemOf({ subtype: "inspection" }))).toBe("expiry");
    expect(kindOfItem(itemOf({ scheduleKind: "renewal" }))).toBe("renewal");
    expect(kindOfItem(itemOf({ scheduleKind: "service" }))).toBe("service");
    expect(kindOfItem(itemOf({ scheduleKind: "service", subtype: "inspection" }))).toBe("inspection");
  });
});

describe("the expiry on the sky", () => {
  it("wears its band's colour while the date is ahead", () => {
    const [soon] = bodiesOf([itemOf({ dueDate: "2026-08-20" })]);
    expect(soon.kind).toBe("expiry");
    expect(soon.paint).toBe("amber");

    const [upcoming] = bodiesOf([itemOf({ dueDate: "2026-10-01" })]);
    expect(upcoming.paint).toBe("sky");

    const [far] = bodiesOf([itemOf({ dueDate: "2027-06-01" })]);
    expect(far.paint).toBe("jade");
  });

  it("is never overdue and never ruby once the date has passed", () => {
    const [ended] = bodiesOf([itemOf({ dueDate: "2026-08-06" })]);
    expect(ended.days).toBe(-7);
    expect(ended.overdue).toBe(false);
    expect(ended.paint).toBe("ended");
    expect(ended.paint).not.toBe("ruby");
  });

  it("still sits where its date falls, inward after the date", () => {
    const [ended] = bodiesOf([itemOf({ dueDate: "2026-08-06" })]);
    const [renewal] = bodiesOf([itemOf({ dueDate: "2026-08-06", scheduleKind: "renewal" })]);
    expect(ended.placement).toEqual(renewal.placement);
    /* The dial law: overdue bodies fall inward from the 62-unit today ring. */
    expect(ended.placement.radius).toBeLessThan(62);
  });

  it("leaves a renewal past its date exactly as overdue as it was", () => {
    const [renewal] = bodiesOf([itemOf({ dueDate: "2026-08-06", scheduleKind: "renewal" })]);
    expect(renewal.overdue).toBe(true);
    expect(renewal.paint).toBe("ruby");
  });
});

describe("the ended band", () => {
  it("replaces overdue for an expiry, and nothing else", () => {
    expect(bandOfKind("expiry", -1)).toBe("ended");
    expect(bandOfKind("expiry", 0)).toBe("due-soon");
    expect(bandOfKind("expiry", 200)).toBe("ok");
    expect(bandOfKind("renewal", -1)).toBe("overdue");
    expect(bandOfKind("service", -1)).toBe("overdue");
  });
});

describe("what counts as overdue", () => {
  const workspace = {
    activeHouseholdId: "h-1",
    households: [householdOf([
      itemOf({ id: "i-ended", dueDate: "2026-08-06" }),
      itemOf({ id: "i-late", title: "Car MOT", scheduleKind: "renewal", dueDate: "2026-08-06" }),
    ])],
  };

  it("keeps an ended expiry out of the corridor's red zone but on the line", () => {
    const corridor = corridorOf(workspace, TODAY);
    expect(corridor.overdue.map((row) => row.id)).toEqual(["i-late"]);
    expect(corridor.total).toBe(2);
    /* It keeps its seat where the date fell -- August is the current month. */
    expect(corridor.current.map((row) => row.id)).toContain("i-ended");
  });

  it("gives the manifest an ended row rather than an overdue one", () => {
    const groups = manifestGroupsOf(workspace.households[0], { today: TODAY });
    const ended = groups.attention.find((row) => row.id === "i-ended");
    expect(ended.band).toBe("ended");
    expect(ended.kind).toBe("expiry");
    expect(groups.attention.find((row) => row.id === "i-late").band).toBe("overdue");
  });
});

describe("the belt's words", () => {
  it("says what the day is, not just which day", () => {
    expect(whenOf("expiry", 20, "02 Sep")).toBe("ends 02 Sep");
    expect(whenOf("expiry", -7, "06 Aug")).toBe("ended 06 Aug");
    expect(whenOf("renewal", -7, "06 Aug")).toBe("06 Aug");
    expect(whenOf("service", 20, "02 Sep")).toBe("02 Sep");
  });

  it("carries those words and the ended urgency onto the rock", () => {
    const [row] = beltManifestOf({ household: householdOf([itemOf({ dueDate: "2026-08-06" })]), today: TODAY });
    expect(row.kind).toBe("expiry");
    expect(row.when).toBe("ended 06 Aug");
    expect(row.urg).toBe("ended");
    expect(row.months).toBe(null);

    const [ahead] = beltManifestOf({ household: householdOf([itemOf()]), today: TODAY });
    expect(ahead.when).toBe("ends 02 Sept");
    expect(ahead.urg).toBe("soon");
  });
});

describe("the reminder's words", () => {
  it("says an expiry is running out, never that it is due", () => {
    const words = reminderWords("Cavity wall guarantee", "2026-09-02", "expiry");
    expect(words.subject).toBe("Cavity wall guarantee is running out");
    expect(words.body).toBe("Cavity wall guarantee ends on 2026-09-02.");
    expect(words.text).toContain("ends on 2026-09-02");
    expect(words.text).not.toContain("is due");
  });

  it("leaves a renewal and a service saying what they always said", () => {
    for (const kind of ["renewal", "service"]) {
      const words = reminderWords("Car MOT", "2026-09-02", kind);
      expect(words.subject).toBe("Car MOT is coming up");
      expect(words.body).toBe("Car MOT is due on 2026-09-02.");
    }
  });
});

describe("the daily sweep", () => {
  it("lets an ended expiry linger a fortnight before it is swept", () => {
    /* The boundary is the first date still inside the linger: an item whose
       date falls before it has had its fourteen days. */
    expect(expirySweepBoundary(new Date("2026-08-13T09:00:00Z"))).toBe("2026-07-30");
  });

  it("runs once a day, not once a tick", () => {
    expect(expirySweepIsDue("2026-08-13", undefined)).toBe(true);
    expect(expirySweepIsDue("2026-08-13", "2026-08-12")).toBe(true);
    expect(expirySweepIsDue("2026-08-13", "2026-08-13")).toBe(false);
  });
});
