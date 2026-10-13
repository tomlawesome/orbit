import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ASKING, DOOR, INVITED, NEWCOMER, ONWARD,
  CURRENCIES, DEFAULT_SECTIONS, NAME_LIMIT, TIME_ZONES,
  arrivalStageOf, belongRowsOf, collidingHouseholdOf,
  createSystemCommand, discoveredCountOf, isInvitedLanding, preferredCurrency, preferredTimeZone,
  sectionNote, sectionNoteTitle, WAITING_APPROVAL_NOTE,
} from "$lib/arrival/stage.js";
import { NEWCOMER_FAR, NEWCOMER_NEAR } from "$lib/flight/starfields.js";
import { labelledSkyOf } from "$lib/data/chart.js";
import * as STAGES from "$lib/arrival/stage.js";
import {
  ARRIVAL_FIXTURES, NEWCOMER_ARRIVAL_FIXTURE,
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

  it("gives the first admin the newcomer's arrival too: no households anywhere (#1263)", () => {
    /* one flight per arrival: the create questions are the belong card's
       drawer, so an empty instance lands on the same stage */
    expect(arrivalStageOf({ households: [], visibleHouseholds: [] })).toBe(NEWCOMER);
  });

  it("has retired the create stage altogether (#1263)", () => {
    expect("CREATE" in STAGES).toBe(false);
    expect(Object.keys(ARRIVAL_FIXTURES)).toEqual(["newcomer"]);
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
    expect(arrivalStageOf({})).toBe(NEWCOMER);
  });
});

describe("the invited landing, told apart from an ordinary return (#871)", () => {
  it("fires only with both the active household and the redemption's own one-shot flag", () => {
    expect(isInvitedLanding({ activeHouseholdId: "hh-harlow-1", justJoined: true })).toBe(true);
  });

  it("never fires for a returning member: the same household, without the flag", () => {
    /* This is the whole point: #481's redemption sets `activeHouseholdId` the
       same way an ordinary sign-in's session already carries it, so the flag
       — set once by `/invite/[token]/+page.server.js` and read-and-cleared by
       `GET /api/auth/session` — is the only thing that can ever be true here
       and false there. */
    expect(isInvitedLanding({ activeHouseholdId: "hh-harlow-1" })).toBe(false);
    expect(isInvitedLanding({ activeHouseholdId: "hh-harlow-1", justJoined: false })).toBe(false);
  });

  it("never fires off the flag alone: a household to land on is the other half", () => {
    expect(isInvitedLanding({ justJoined: true })).toBe(false);
  });

  it("answers false rather than guessing on the door's own null and undefined", () => {
    expect(isInvitedLanding(null)).toBe(false);
    expect(isInvitedLanding(undefined)).toBe(false);
  });

  it("is its own stage, not one arrivalStageOf's workspace read could ever answer", () => {
    expect(INVITED).toBe("invited");
    expect(new Set([DOOR, ASKING, NEWCOMER, ONWARD, INVITED]).size).toBe(5);
  });
});

/*
 * The climb itself (its beats and their timing) is the shared door's since
 * #1371: the folder's timeline, held to its recorded tree hash. What is
 * Orbit's own is what hangs off the folder's `settled` hook in Flight.svelte:
 * the newcomer's count and the question that follows it. Pinned from the
 * component's source, as the other surfaces' wiring is.
 */
const FLIGHT = readFileSync(new URL("../../web/src/lib/flight/Flight.svelte", import.meta.url), "utf8");

describe("the invited landing's climb is the newcomer's own, to the beat the chooser would stand on", () => {
  it("flies one climb for both, and only reads the last beat differently", () => {
    /* landing="invited" flies the newcomer's count unchanged and differs at
       exactly one beat: the question's. A later edit that moved `belong` off
       the end of the count, or dropped it, would silently strand the invited
       reader on a sky, no chooser and no move either. */
    expect(FLIGHT).toMatch(/const newcomer = landing !== "home";/);
    expect(FLIGHT).toMatch(/settled: \(\) => \{ onsettled\(\); if \(newcomer\) count\(\); \}/);
    expect(FLIGHT).toMatch(/if \(landing === "invited"\) onbelong\(\); else b\.classList\.add\("belong"\)/);
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
    { id: "hh-harlow-1", name: "Harlow Home", requested: false },
    { id: "hh-seaside-4551", name: "Seaside Cottage", requested: false },
  ];

  it("finds the system that holds the name, so the ask-to-join it offers is real", () => {
    expect(collidingHouseholdOf("Harlow Home", out).id).toBe("hh-harlow-1");
  });

  it("reads case and spacing the way the reader does", () => {
    expect(collidingHouseholdOf("harlow home", out).id).toBe("hh-harlow-1");
    expect(collidingHouseholdOf("  HARLOW   HOME ", out).id).toBe("hh-harlow-1");
  });

  it("refuses nothing else", () => {
    expect(collidingHouseholdOf("Harlow Hom", out)).toBeNull();
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
      { name: "  Harlow Home  ", timezone: "Europe/London", currency: "GBP" },
      { uuid: () => "11111111-2222-3333-4444-555555555555" },
    );
    expect(command).toEqual({
      type: "household.create",
      household: {
        id: "11111111-2222-3333-4444-555555555555",
        name: "Harlow Home",
        timezone: "Europe/London",
        currency: "GBP",
        onboardingComplete: true,
      },
    });
  });

  it("never composes the sections: the server owns what a new system starts with", () => {
    const command = createSystemCommand(
      { name: "Harlow Home", timezone: "UTC", currency: "USD" },
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
      "Gran’s Flat", "Harlow Home", "Mum & Dad’s", "The Narrowboat", "Seaside Cottage",
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

describe("the waiting note (owner-decisions §23): the marker is not the explanation", () => {
  it("says the request is waiting", () => {
    expect(WAITING_APPROVAL_NOTE.toLowerCase()).toContain("waiting");
  });

  it("names who has to approve it, in the owner's own words", () => {
    expect(WAITING_APPROVAL_NOTE).toContain("owner");
    expect(WAITING_APPROVAL_NOTE).toContain("administrator");
    expect(WAITING_APPROVAL_NOTE).toContain("approve");
  });

  it("promises no mechanism that does not exist: no notification, email or ETA", () => {
    for (const word of ["email", "notif", "shortly", "soon", "minute", "hour", "day"]) {
      expect(WAITING_APPROVAL_NOTE.toLowerCase()).not.toContain(word);
    }
  });
});

describe("the newcomer's count hangs off the folder's instrument beat (#1222)", () => {
  /** the offsets, in ms from the instrument's arrival, as Flight.svelte writes them */
  const offsets = (name) => {
    const m = FLIGHT.match(new RegExp(`const ${name} = \\{ on: ([^,]+), off: ([^,]+), belong: ([^}]+) \\};`));
    expect(m, `${name} not found in Flight.svelte`).not.toBeNull();
    return m.slice(1, 4).map((expr) => expr.split("+").reduce((sum, term) => sum + Number(term), 0));
  };

  it("keeps the count's own offsets from the instrument beat (#870)", () => {
    const [on, off, belong] = offsets("COUNT");
    expect(on).toBe(300);
    /* ~4.55s of screen time in all: 0.45s in, 3.2s held, 0.9s out */
    expect(off - on).toBe(3200);
    expect(belong - off).toBe(900);
  });

  it("keeps the whole staging under reduced motion, and only drops the fade", () => {
    const [on, off, belong] = offsets("COUNT_REDUCED");
    expect(on).toBe(0);
    /* the count still takes its turn, on the mockup's own 1900 hold, and yields to the question */
    expect(off - on).toBe(1900);
    expect(belong).toBe(off);
  });

  it("is cancelled with the flight, and does not outlive it", () => {
    expect(FLIGHT).toMatch(/function cancelCount\(\)/);
    expect(FLIGHT).toMatch(/cancelCount\(\);\s*j\.destroy\(\)/);
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
  it("has no households of its own on any", () => {
    for (const fixture of Object.values(ARRIVAL_FIXTURES)) {
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
