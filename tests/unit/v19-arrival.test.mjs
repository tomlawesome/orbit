import { describe, expect, it } from "vitest";

import {
  ASKING, CREATE, DOOR, NEWCOMER, ONWARD,
  CURRENCIES, DEFAULT_SECTIONS, NAME_LIMIT, TIME_ZONES,
  arrivalStageOf, belongRowsOf, collidingHouseholdOf, createButtonLabel,
  createSystemCommand, discoveredCountOf, preferredCurrency, preferredTimeZone,
  sectionNote, sectionNoteTitle,
} from "$lib/arrival/stage.js";
import {
  T, newcomerAscentBeats, newcomerAscentBeatsReduced, runTimeline,
} from "$lib/flight/timeline.js";
import { NEWCOMER_FAR, NEWCOMER_NEAR } from "$lib/flight/starfields.js";
import { labelledSkyOf } from "$lib/data/chart.js";
import {
  CREATE_ARRIVAL_FIXTURE, NEWCOMER_ARRIVAL_FIXTURE,
} from "$lib/data/fixtures/arrival.js";

/*
 * THE ARRIVAL (#410, §15) — the first-admin create journey and the newcomer's.
 *
 * Every number and every word below is read off design/v19/first-run.html and
 * design/owner-decisions.md §15, so a later edit that quietly retimes the
 * newcomer's dwell, drops a beat of the count, loosens the create command or
 * reworks the sealed card's three questions fails here rather than being
 * noticed by nobody.
 */

describe("which surface an arrival lands on", () => {
  it("hands a member onward: home is theirs", () => {
    expect(arrivalStageOf({ households: [{ id: "hh-1" }], visibleHouseholds: [] })).toBe(ONWARD);
    /* and onward even when the instance has others they do not belong to */
    expect(arrivalStageOf({
      households: [{ id: "hh-1" }],
      visibleHouseholds: [{ id: "hh-2", name: "Seaside Cottage" }],
    })).toBe(ONWARD);
  });

  it("gives the first admin the create card: no households anywhere", () => {
    expect(arrivalStageOf({ households: [], visibleHouseholds: [] })).toBe(CREATE);
    expect(arrivalStageOf(CREATE_ARRIVAL_FIXTURE)).toBe(CREATE);
  });

  it("gives a newcomer the newcomer's arrival: none of theirs, some out there", () => {
    expect(arrivalStageOf({
      households: [],
      visibleHouseholds: [{ id: "hh-2", name: "Seaside Cottage", requested: false }],
    })).toBe(NEWCOMER);
    expect(arrivalStageOf(NEWCOMER_ARRIVAL_FIXTURE)).toBe(NEWCOMER);
  });

  it("answers ASKING until the server has answered, and never guesses", () => {
    expect(arrivalStageOf(null)).toBe(ASKING);
    expect(arrivalStageOf(undefined)).toBe(ASKING);
    /* the door is what an unanswered page draws, and it is its own word */
    expect(DOOR).toBe("door");
  });

  it("treats a workspace with the fields missing as the empty instance it is", () => {
    expect(arrivalStageOf({})).toBe(CREATE);
  });
});

describe("the count is a moment, and it is real", () => {
  it("reads the number off the households and pluralises on it", () => {
    expect(discoveredCountOf([{ id: "a" }, { id: "b" }, { id: "c" }])).toEqual({ count: 3, word: "systems" });
    expect(discoveredCountOf([{ id: "a" }])).toEqual({ count: 1, word: "system" });
    expect(discoveredCountOf([])).toEqual({ count: 0, word: "systems" });
    expect(discoveredCountOf(undefined)).toEqual({ count: 0, word: "systems" });
  });

  it("counts the fixture's five, which is the sheet's own number", () => {
    expect(discoveredCountOf(NEWCOMER_ARRIVAL_FIXTURE.visibleHouseholds))
      .toEqual({ count: 5, word: "systems" });
  });
});

describe("the sealed refusal", () => {
  const out = [
    { id: "hh-lawson-1", name: "Lawson Home", requested: false },
    { id: "hh-seaside-4551", name: "Seaside Cottage", requested: false },
  ];

  it("finds the system that holds the name, so the ask-to-join it offers is real", () => {
    expect(collidingHouseholdOf("Lawson Home", out).id).toBe("hh-lawson-1");
  });

  it("reads case and spacing the way the reader does", () => {
    expect(collidingHouseholdOf("lawson home", out).id).toBe("hh-lawson-1");
    expect(collidingHouseholdOf("  LAWSON   HOME ", out).id).toBe("hh-lawson-1");
  });

  it("refuses nothing else", () => {
    expect(collidingHouseholdOf("Lawson Hom", out)).toBeNull();
    expect(collidingHouseholdOf("", out)).toBeNull();
    expect(collidingHouseholdOf("   ", out)).toBeNull();
    expect(collidingHouseholdOf("Anything", [])).toBeNull();
    expect(collidingHouseholdOf("Anything", undefined)).toBeNull();
  });
});

describe("the card asks three things only", () => {
  it("offers the sheet's own zones and currencies, in the sheet's own order", () => {
    expect(TIME_ZONES.map((zone) => zone.label)).toEqual([
      "Europe/London", "Europe/Dublin", "Europe/Paris",
      "America/New York", "Australia/Sydney", "UTC",
    ]);
    expect(CURRENCIES).toEqual(["GBP", "EUR", "USD", "CAD", "AUD", "NZD"]);
  });

  it("shows the sheet's word for New York and sends the zone database's", () => {
    const newYork = TIME_ZONES.find((zone) => zone.label === "America/New York");
    expect(newYork.value).toBe("America/New_York");
  });

  it("reads the browser's answer only when the card offers it", () => {
    expect(preferredTimeZone("Australia/Sydney")).toBe("Australia/Sydney");
    expect(preferredTimeZone("America/New_York")).toBe("America/New_York");
    expect(preferredTimeZone("Pacific/Chatham")).toBe("Europe/London");
    expect(preferredTimeZone(null)).toBe("Europe/London");
    expect(preferredCurrency("AUD")).toBe("AUD");
    expect(preferredCurrency("JPY")).toBe("GBP");
    expect(preferredCurrency(undefined)).toBe("GBP");
  });

  it("bounds the name where the server bounds it", () => {
    expect(NAME_LIMIT).toBe(60);
    const command = createSystemCommand(
      { name: "x".repeat(200), timezone: "UTC", currency: "GBP" },
      { uuid: () => "id-1" },
    );
    expect(command.household.name).toHaveLength(60);
  });

  it("writes the system's name into the button as it is typed", () => {
    expect(createButtonLabel("")).toBe("create this system →");
    expect(createButtonLabel("   ")).toBe("create this system →");
    expect(createButtonLabel("Lawson Home")).toBe("create Lawson Home →");
  });

  it("admits to the four default sections in one quiet line, counted not typed", () => {
    expect(DEFAULT_SECTIONS).toEqual(["Home", "Vehicles", "Devices", "Services"]);
    expect(sectionNote()).toBe("4 sections to start · change them later");
    expect(sectionNote(["One", "Two"])).toBe("2 sections to start · change them later");
    expect(sectionNoteTitle()).toContain("Home, Vehicles, Devices, Services");
  });
});

describe("the create command", () => {
  it("is household.create, and carries the three answers and nothing else", () => {
    const command = createSystemCommand(
      { name: "  Lawson Home  ", timezone: "Europe/London", currency: "GBP" },
      { uuid: () => "11111111-2222-3333-4444-555555555555" },
    );
    expect(command).toEqual({
      type: "household.create",
      household: {
        id: "11111111-2222-3333-4444-555555555555",
        name: "Lawson Home",
        timezone: "Europe/London",
        currency: "GBP",
        onboardingComplete: true,
      },
    });
  });

  it("never composes the sections: the server owns what a new system starts with", () => {
    const command = createSystemCommand(
      { name: "Lawson Home", timezone: "UTC", currency: "USD" },
      { uuid: () => "id-1" },
    );
    expect(command.household).not.toHaveProperty("sections");
    expect(command.household).not.toHaveProperty("items");
    expect(command.household).not.toHaveProperty("memberCount");
  });
});

describe("the card and the sky are one list", () => {
  it("puts the rows in the same order the sky places the constellations", () => {
    const galaxy = labelledSkyOf(NEWCOMER_ARRIVAL_FIXTURE.visibleHouseholds);
    const rows = belongRowsOf(galaxy);
    /* placeGalaxy sorts by id, so the card sorts by id: row for constellation */
    expect(rows.map((row) => row.id)).toEqual(Object.keys(galaxy).sort());
    expect(rows.map((row) => row.name)).toEqual([
      "Gran’s Flat", "Lawson Home", "Mum & Dad’s", "The Narrowboat", "Seaside Cottage",
    ]);
  });

  it("carries the waiting state through to the row that has already asked", () => {
    const rows = belongRowsOf(labelledSkyOf(NEWCOMER_ARRIVAL_FIXTURE.visibleHouseholds));
    expect(rows.filter((row) => row.requested).map((row) => row.name)).toEqual(["Mum & Dad’s"]);
  });

  it("survives an empty sky", () => {
    expect(belongRowsOf({})).toEqual([]);
    expect(belongRowsOf(undefined)).toEqual([]);
  });
});

describe("the newcomer's clock is the sealed one", () => {
  it("keeps its own 3s dwell while the login landing keeps the trimmed 2s", () => {
    expect(T.dwell).toBe(2000);
    expect(T.newDwell).toBe(3000);
    expect(T.instrumentAt).toBe(8400);
    expect(T.newInstrumentAt).toBe(9400);
  });

  it("opens the count a second earlier than it first did, and holds its rhythm", () => {
    expect(T.countOn).toBe(9900);
    expect(T.countOff).toBe(11900);
    expect(T.belongAt).toBe(12800);
    /* ~2.8s of screen time in all: 0.8s in, 2s held, 0.8s out */
    expect(T.countOff - T.countOn).toBe(2000);
    expect(T.belongAt - T.countOff).toBe(900);
  });

  it("flies the same climb to the millisecond and only lands differently", () => {
    const climb = newcomerAscentBeats().filter((beat) => beat.at <= T.land);
    expect(climb).toEqual([
      { at: 0, act: "arming" },
      { at: 200, act: "warp" },
      { at: 260, act: "mark" },
      { at: 430, act: "release" },
      { at: 1340, act: "markOut" },
      { at: 1560, act: "nameOn" },
      { at: 2600, act: "nameOff" },
      { at: 4800, act: "land" },
    ]);
  });

  it("lands, dwells, settles, counts and then asks — in that order", () => {
    expect(newcomerAscentBeats().map((beat) => beat.act)).toEqual([
      "arming", "warp", "mark", "release", "markOut", "nameOn", "nameOff",
      "land", "instrument", "countOn", "countOff", "belong",
    ]);
  });

  it("pins every beat up to a millisecond and schedules nothing", () => {
    const applied = [];
    const cancel = runTimeline(newcomerAscentBeats(), (act) => applied.push(act), { at: T.countOn });
    expect(applied).toEqual([
      "arming", "warp", "mark", "release", "markOut", "nameOn", "nameOff",
      "land", "instrument", "countOn",
    ]);
    expect(cancel).toBeTypeOf("function");
  });

  it("keeps the whole staging under reduced motion, and only drops the motion", () => {
    const beats = newcomerAscentBeatsReduced();
    expect(beats).toEqual([
      { at: 0, act: "land" },
      { at: 3700, act: "instrument" },
      { at: 3700, act: "countOn" },
      { at: 5600, act: "countOff" },
      { at: 5600, act: "belong" },
    ]);
    /* the bare labelled sky, the ratified 3s dwell, then the instrument */
    expect(beats[1].at).toBe(700 + T.newDwell);
    /* the count still takes its turn, on the mockup's own 1900 hold */
    expect(beats[3].at - beats[1].at).toBe(1900);
  });
});

describe("the newcomer's starfield", () => {
  it("takes the stars the sheet gives it, off the sheet's own stream", () => {
    expect(NEWCOMER_FAR).toHaveLength(95);
    expect(NEWCOMER_NEAR).toHaveLength(46);
    /* the far tile of this pair carries no twinkle, as the sheet seeds it */
    expect(NEWCOMER_FAR.every((star) => star.delay === null)).toBe(true);
  });

  it("is deterministic, so the gate photographs one sky", () => {
    const first = NEWCOMER_FAR[0];
    expect(Number(first.cx)).toBeGreaterThanOrEqual(0);
    expect(Number(first.cx)).toBeLessThanOrEqual(1600);
    expect(first).toEqual(NEWCOMER_FAR[0]);
  });
});

describe("the arrival's fixtures are the states the workspace fixture cannot be in", () => {
  it("has no households of its own on either", () => {
    for (const fixture of [CREATE_ARRIVAL_FIXTURE, NEWCOMER_ARRIVAL_FIXTURE]) {
      expect(fixture.households).toEqual([]);
      expect(fixture.householdLanding).toBe("choose");
      expect(fixture.activeHouseholdId).toBeNull();
    }
  });

  it("gives the newcomer the sheet's five, one of them already asked", () => {
    expect(NEWCOMER_ARRIVAL_FIXTURE.visibleHouseholds).toHaveLength(5);
    expect(NEWCOMER_ARRIVAL_FIXTURE.visibleHouseholds.filter((one) => one.requested))
      .toHaveLength(1);
  });

  it("draws the labelled sky the app's own way: label only, no planets", () => {
    const galaxy = labelledSkyOf(NEWCOMER_ARRIVAL_FIXTURE.visibleHouseholds);
    for (const household of Object.values(galaxy)) {
      expect(household.planets).toEqual([]);
      expect(household.role).toBeNull();
    }
  });
});
