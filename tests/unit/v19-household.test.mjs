import { describe, expect, it } from "vitest";

// #410 / §15: household management's pure transforms. The seam does the
// fetching; everything that turns four API payloads into the screen's words
// is here, so the contract is pinned rather than discovered in a container
// run (the commands.js precedent).
import {
  MAX_SECTIONS,
  deletionNameMatches,
  entriesLabel,
  householdScreenOf,
  householdUpdateCommandOf,
  initialsOf,
  sectionRowsOf,
  sectionsCommandOf,
} from "../../web/src/lib/data/household.js";
import { WORKSPACE_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";
import { MEMBERS_FIXTURE } from "../../web/src/lib/data/fixtures/household.js";

const TOM = { id: "u-fixture", displayName: "Tom Lawson", email: "tom@lawson.example" };
const TODAY = "2026-08-13"; // DESIGN_TODAY: the date every mockup was drawn against
const NOON = "2026-08-13T12:00:00Z";

const lawson = () => WORKSPACE_FIXTURE.households.find((one) => one.id === "hh-lawson-1");

const ownerScreen = (overrides = {}) =>
  householdScreenOf({
    workspace: WORKSPACE_FIXTURE,
    householdId: "hh-lawson-1",
    user: TOM,
    members: MEMBERS_FIXTURE["hh-lawson-1"].members,
    candidates: MEMBERS_FIXTURE["hh-lawson-1"].candidates,
    today: TODAY,
    now: NOON,
    ...overrides,
  });

describe("initials", () => {
  it("takes two letters from a chosen display name", () => {
    expect(initialsOf("Tom Lawson")).toBe("TL");
    expect(initialsOf("Ada Reid")).toBe("AR");
  });

  // The mockup drew "GL" beside a member called Gran. Names are the only
  // thing this screen's routes disclose, so one word yields one letter — the
  // interface never invents a surname nobody typed.
  it("yields one letter for a one-word name", () => {
    expect(initialsOf("Gran")).toBe("G");
  });

  it("has a mark for a name it was never given", () => {
    expect(initialsOf("")).toBe("·");
    expect(initialsOf(null)).toBe("·");
  });
});

describe("the sections editor", () => {
  it("counts the entries sitting in each section", () => {
    expect(sectionRowsOf(lawson()).map((row) => [row.name, row.count])).toEqual([
      ["Home", 3],
      ["Vehicles", 2],
      ["Devices", 1],
      ["Services", 0],
      ["Dates & renewals", 0],
    ]);
  });

  // The hidden-not-removed law, as a property of the data rather than a style:
  // a section holding entries carries no × at all, because sections.replace
  // would silently re-file its items under whichever section survives first.
  it("offers removal only where a section holds nothing", () => {
    expect(sectionRowsOf(lawson()).map((row) => row.removable)).toEqual([false, false, false, true, true]);
  });

  it("says the count in the reader's words", () => {
    expect(entriesLabel(0)).toBe("0 entries");
    expect(entriesLabel(1)).toBe("1 entry");
    expect(entriesLabel(3)).toBe("3 entries");
  });

  it("treats an archived entry as no longer sitting in its section", () => {
    const household = {
      sections: [{ id: "s-a", name: "A", icon: "home", accent: "sage", visible: true }],
      items: [{ id: "i-1", sectionId: "s-a", status: "archived" }],
    };
    expect(sectionRowsOf(household)[0]).toMatchObject({ count: 0, removable: true });
  });

  it("shows a section whose payload never said otherwise", () => {
    const household = { sections: [{ id: "s-a", name: "A" }], items: [] };
    expect(sectionRowsOf(household)[0]).toMatchObject({ visible: true, icon: "home", accent: "sage" });
  });

  // The command replaces the LIST, so the list is what travels — mapped back
  // to the engine's own field names, with the interface's arithmetic left
  // behind.
  it("sends the whole list in the engine's field names", () => {
    const rows = sectionRowsOf(lawson());
    expect(sectionsCommandOf("hh-lawson-1", rows)).toEqual({
      type: "sections.replace",
      householdId: "hh-lawson-1",
      sections: [
        { id: "s-home", name: "Home", icon: "home", accent: "sage", visible: true },
        { id: "s-vehicles", name: "Vehicles", icon: "vehicle", accent: "blue", visible: true },
        { id: "s-devices", name: "Devices", icon: "device", accent: "sand", visible: true },
        { id: "s-services", name: "Services", icon: "service", accent: "plum", visible: true },
        { id: "s-dates", name: "Dates & renewals", icon: "calendar", accent: "coral", visible: true },
      ],
    });
  });

  it("never sends more sections than the schema accepts", () => {
    expect(MAX_SECTIONS).toBe(12);
  });
});

describe("the identity bundle (2c)", () => {
  // Three saves TO THE EYE, one command underneath: a per-field save submits
  // the whole bundle with the other two values as they stand.
  it("carries all three fields whichever one was saved", () => {
    expect(householdUpdateCommandOf("hh-lawson-1", {
      name: "  Lawson Home  ",
      timezone: "Europe/London",
      currency: "GBP",
    })).toEqual({
      type: "household.update",
      householdId: "hh-lawson-1",
      name: "Lawson Home",
      timezone: "Europe/London",
      currency: "GBP",
    });
  });
});

describe("the danger line", () => {
  // The server compares the exact name, so the client's check is the same
  // comparison and not a friendlier one: a button that wakes on a name the
  // route will reject is a worse lie than one that stays asleep.
  it("wakes only on the exact name", () => {
    expect(deletionNameMatches("Lawson Home", "Lawson Home")).toBe(true);
    expect(deletionNameMatches("  Lawson Home  ", "Lawson Home")).toBe(true);
    expect(deletionNameMatches("lawson home", "Lawson Home")).toBe(false);
    expect(deletionNameMatches("Lawson", "Lawson Home")).toBe(false);
  });

  it("never wakes on an empty name", () => {
    expect(deletionNameMatches("", "")).toBe(false);
    expect(deletionNameMatches("", "Lawson Home")).toBe(false);
  });
});

describe("the owner's screen", () => {
  it("reads the mockup's header line", () => {
    expect(ownerScreen().subtitle).toBe("your system · you own it · 4 members · 6 entries in orbit");
  });

  it("marks the reader's own row and nobody else's", () => {
    expect(ownerScreen().roster.map((person) => [person.name, person.role, person.you])).toEqual([
      ["Tom Lawson", "owner", true],
      ["Emma Lawson", "member", false],
      ["Rob Lawson", "member", false],
      ["Gran", "member", false],
    ]);
  });

  it("counts members from the roster, not the workspace's summary", () => {
    // The workspace says 2 because that summary was written for other
    // screens; the roster is the thing being edited here, so it wins.
    expect(lawson().memberCount).toBe(2);
    expect(ownerScreen().memberCount).toBe(4);
  });

  it("falls back to the summary when the roster could not be read", () => {
    expect(ownerScreen({ members: [] }).memberCount).toBe(2);
  });

  it("offers the registered accounts the route handed it, in that order", () => {
    expect(ownerScreen().candidates.map((one) => one.name)).toEqual(["Ben Lawson", "Ada Reid"]);
  });

  // §15-2g: joiners are answered here and nowhere else — and the route
  // answers every request across every household the caller owns, so the
  // screen keeps only its own.
  it("keeps only the joiners asking for THIS system", () => {
    const requests = [
      { id: "jr-1", householdId: "hh-lawson-1", userId: "u-sue", displayName: "Sue Lawson", createdAt: "2026-08-11T12:00:00.000Z" },
      { id: "jr-2", householdId: "hh-seaside-4551", userId: "u-rob", displayName: "Rob Lawson", createdAt: "2026-08-11T12:00:00.000Z" },
    ];
    expect(ownerScreen({ joinRequests: requests }).joinRequests).toEqual([
      { id: "jr-1", userId: "u-sue", name: "Sue Lawson", initials: "SL", waited: "2d ago" },
    ]);
  });

  it("rests when nobody is asking", () => {
    expect(ownerScreen().joinRequests).toEqual([]);
  });

  it("is the system the sky is drawn around", () => {
    expect(ownerScreen().primary).toBe(true);
  });
});

describe("the non-owner's screen", () => {
  const memberScreen = householdScreenOf({
    workspace: WORKSPACE_FIXTURE,
    householdId: "hh-seaside-4551",
    user: TOM,
    members: MEMBERS_FIXTURE["hh-seaside-4551"].members,
    candidates: MEMBERS_FIXTURE["hh-seaside-4551"].candidates,
    today: TODAY,
    now: NOON,
  });

  it("names the owner in its header line", () => {
    expect(memberScreen.subtitle).toBe("a system you’re in · Emma Lawson owns it · 3 members · 3 entries in orbit");
  });

  // 2b: a plain member never sees the sections editor — not disabled, not
  // greyed: absent. The view model has no rows to draw one from.
  it("has no sections editor at all", () => {
    expect(memberScreen.canManage).toBe(false);
    expect(memberScreen.sections).toEqual([]);
  });

  it("is offered nobody to add and no joiner to answer", () => {
    expect(memberScreen.candidates).toEqual([]);
    expect(memberScreen.joinRequests).toEqual([]);
  });

  it("knows which row is the reader's, so leaving has something to point at", () => {
    expect(memberScreen.you).toMatchObject({ id: "u-fixture", role: "member" });
  });

  it("is not the system the sky is drawn around", () => {
    expect(memberScreen.primary).toBe(false);
  });
});

describe("a household this session cannot see", () => {
  // A membership test against data the session already holds, never a request
  // built from the URL: an unknown id is a 404, not a probe.
  it("is nothing, so the route can answer 404", () => {
    expect(householdScreenOf({ workspace: WORKSPACE_FIXTURE, householdId: "hh-somebody-elses" })).toBeNull();
  });
});

describe("an instance admin wearing the owner screen (§15-2i)", () => {
  // They hold owner powers over a household they are not a member of, so they
  // have no row in its roster — and must not be offered "leave this system"
  // for a system they were never in.
  it("has no row of their own to leave by", () => {
    const screen = householdScreenOf({
      workspace: WORKSPACE_FIXTURE,
      householdId: "hh-lawson-1",
      user: { id: "u-admin", displayName: "Ada Admin" },
      members: MEMBERS_FIXTURE["hh-lawson-1"].members,
      candidates: MEMBERS_FIXTURE["hh-lawson-1"].candidates,
      today: TODAY,
    });
    expect(screen.canManage).toBe(true);
    expect(screen.you).toBeNull();
  });
});
