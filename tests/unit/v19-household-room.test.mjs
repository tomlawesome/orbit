import { describe, expect, it } from "vitest";

// §15 H2 — "inside this system": the household's own constellation at room
// scale behind the ratified management cards. design/v19/household-inside.html
// is the spec, and the piece its own report leaves open — WHERE YOU STAND,
// hand-placed there per fixture household — is what this suite pins.
import {
  FIELD,
  YEAR_RING,
  berthsOf,
  liftOf,
  roomOf,
  scaleCeilingFor,
  scaleFloorFor,
  skyMap,
  toField,
} from "../../web/src/routes/household/[id]/room.js";
import { constellationOf } from "../../web/src/lib/data/household.js";
import { WORKSPACE_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";

const TODAY = "2026-08-13"; // DESIGN_TODAY: the date every mockup was drawn against

const household = (id) => WORKSPACE_FIXTURE.households.find((one) => one.id === id);
const lawson = () => constellationOf(household("hh-lawson-1"), TODAY);
const seaside = () => constellationOf(household("hh-seaside-4551"), TODAY);

/*
 * The unprotected small type at the gate's own viewport (1600×1000, where the
 * sky's field and the CSS pixel are the same unit): the header's ring and its
 * two lines, the back link and the account orb. Measured off the built screen
 * and rounded outward — these are the rectangles the rule is given, and the
 * caller measures them for real.
 */
const KEEP_OUT = [
  { left: 294, top: 105, right: 338, bottom: 149 },   // the header's ring
  { left: 355, top: 96, right: 718, bottom: 158 },    // the name and its line
  { left: 26, top: 30, right: 100, bottom: 44 },      // ← SETTINGS
  { left: 1534, top: 22, right: 1574, bottom: 62 },   // the account orb
];

const room = (marks, keepOut = KEEP_OUT) => roomOf({ marks, ...FIELD, keepOut });

const hits = (star, guard) =>
  star.cx + star.r > guard.left && star.cx - star.r < guard.right &&
  star.cy + star.r > guard.top && star.cy - star.r < guard.bottom;

describe("the stars are the entries (the chart law, not a copy of it)", () => {
  it("draws one star per active, dated entry, in lead-time order", () => {
    expect(lawson().marks.map((mark) => [mark.title, mark.days, mark.band])).toEqual([
      ["Gutter clearing", -16, "overdue"],
      ["Car MOT — Volvo V60", 16, "due-soon"],
      ["Boiler service", 22, "due-soon"],
      ["Chimney sweep", 61, "upcoming"],
      ["Smoke alarm batteries", 122, "ok"],
      ["Car full service", 161, "ok"],
    ]);
  });

  it("places every star by the dial law and nothing by hand", () => {
    // angle° = days − 90, radius = 62 + 0.242·days, overdue falling inward at
    // 0.625/day. Checked against the arithmetic, not against a screenshot.
    const byId = new Map(lawson().marks.map((mark) => [mark.id, mark]));
    for (const [id, days] of [["i-gutter", -16], ["i-svc", 161]]) {
      const mark = byId.get(id);
      const radius = days < 0 ? 62 - 0.625 * -days : 62 + 0.242 * days;
      const angle = ((days - 90) * Math.PI) / 180;
      expect(Math.hypot(mark.dx - Math.cos(angle) * radius, mark.dy - Math.sin(angle) * radius)).toBeLessThan(1e-9);
    }
  });

  it("sizes each halo by cost, the chart key's own scale", () => {
    const byId = new Map(lawson().marks.map((mark) => [mark.id, mark]));
    // Car full service is the £300 body and Smoke alarm batteries the £12 one.
    expect(byId.get("i-svc").halo).toBeGreaterThan(byId.get("i-smoke").halo);
  });

  it("joins each section's entries in date order, in that section's accent", () => {
    expect(lawson().figures).toEqual([
      { id: "s-home", name: "Home", accent: "sage", members: ["i-gutter", "i-boiler", "i-chimney"] },
      { id: "s-vehicles", name: "Vehicles", accent: "blue", members: ["i-mot", "i-svc"] },
    ]);
  });

  it("leaves a lone entry unjoined and an empty section out of the sky", () => {
    // Devices holds one — a star with no line to anyone. Services and Dates &
    // renewals hold nothing, so they are not in the sky at all. Count the stars
    // per figure and you have read the sections card: 3 · 2 · 1 · 0 · 0.
    const figures = lawson().figures.map((figure) => figure.id);
    expect(figures).not.toContain("s-devices");
    expect(figures).not.toContain("s-services");
    expect(figures).not.toContain("s-dates");
  });

  it("cannot feel the order the API answered in", () => {
    const forward = household("hh-lawson-1");
    const reversed = { ...forward, items: [...forward.items].reverse() };
    expect(constellationOf(reversed, TODAY)).toEqual(constellationOf(forward, TODAY));
  });

  it("draws no sky at all for a household with no today to measure against", () => {
    expect(constellationOf(household("hh-lawson-1"), null)).toEqual({ marks: [], figures: [] });
  });
});

describe("where you stand (the rule the mockup hand-placed)", () => {
  it("answers the fixture's own room, to the tenth of a unit", () => {
    // The rule's answer for Lawson Home at the gate's own frame, with the
    // header rectangles above. If these move, the household fidelity baseline
    // has moved with them and the change is wrong (the placement.js pin, for
    // the placement.js reason).
    const placed = room(lawson().marks);
    expect(placed.sun).toEqual([656.9, 428.9]);
    expect(placed.scale).toBeCloseTo(4.7958, 4);
    expect(placed.rings).toEqual({ sun: 76.7, overdue: 297.3, year: 719.8, rim: 806.1 });
    expect(seaside().marks.length).toBe(3);
    expect(room(seaside().marks).sun).toEqual([1013.5, 404.8]);
    expect(room(seaside().marks).scale).toBeCloseTo(4.1941, 4);
  });

  it("lands in the neighbourhood the mockup authored by hand", () => {
    // household-inside.html chose sun [690, 340] scale 4.95 for Lawson Home
    // and [1034, 448] scale 4.6 for Seaside Cottage. The rule is not asked to
    // reproduce a hand-placement to the pixel — it is asked to be the same
    // composition: the same room size to within a few per cent, from the data.
    expect(room(lawson().marks).scale).toBeGreaterThan(4.4);
    expect(room(lawson().marks).scale).toBeLessThan(5.4);
    expect(room(seaside().marks).scale).toBeGreaterThan(3.9);
    expect(room(seaside().marks).scale).toBeLessThan(4.9);
  });

  it("draws the wider-spread system in the smaller room, as the mockup says", () => {
    // "spread over ten months of calendar rather than six, so the same room has
    // to be drawn a little smaller" — the mockup's own words about Seaside,
    // reached here from the dates instead of by hand.
    expect(room(seaside().marks).scale).toBeLessThan(room(lawson().marks).scale);
  });

  it("keeps every entry in the room with you, where the spread allows", () => {
    for (const marks of [lawson().marks, seaside().marks]) {
      for (const star of room(marks).stars) {
        expect(star.cx).toBeGreaterThan(0);
        expect(star.cx).toBeLessThan(FIELD.width);
        expect(star.cy).toBeGreaterThan(0);
        expect(star.cy).toBeLessThan(FIELD.height);
      }
    }
  });

  it("composes the figure behind the cards rather than off in a margin", () => {
    // The desk is a 1060 column centred in the field; the cards start under the
    // header and run to the foot. The mark cloud's centre belongs in there.
    for (const marks of [lawson().marks, seaside().marks]) {
      const placed = room(marks);
      const cx = placed.stars.reduce((sum, star) => sum + star.cx, 0) / placed.stars.length;
      const cy = placed.stars.reduce((sum, star) => sum + star.cy, 0) / placed.stars.length;
      expect(cx).toBeGreaterThan((FIELD.width - 1060) / 2);
      expect(cx).toBeLessThan(FIELD.width - (FIELD.width - 1060) / 2);
      expect(cy).toBeGreaterThan(150);
      expect(cy).toBeLessThan(FIELD.height - 100);
    }
  });

  it("is a pure function: the same household and viewport give the same room", () => {
    const marks = lawson().marks;
    // The same objects, not merely equal ones — a re-render cannot redraw the
    // room differently (placement.js's memo, for placement.js's reason).
    expect(room(marks)).toBe(room(marks));
    expect(roomOf({ marks: lawson().marks, ...FIELD, keepOut: KEEP_OUT })).toEqual(room(marks));
  });

  it("re-derives the room when the viewport changes and not otherwise", () => {
    const marks = lawson().marks;
    const wide = roomOf({ marks, width: 2000, height: 1000, keepOut: KEEP_OUT });
    expect(wide).not.toBe(room(marks));
    expect(roomOf({ marks, width: 2000, height: 1000, keepOut: KEEP_OUT })).toBe(wide);
  });
});

describe("rule 1 — the room is a room", () => {
  it("always leaves the frame, so the year band can only be an arc", () => {
    // A ring drawn whole inside the frame is a logo; a household is not a logo.
    const cases = [lawson().marks, seaside().marks, [], one(), knot(), sprawl()];
    for (const marks of cases) {
      const placed = room(marks);
      const nearest = Math.min(
        placed.sun[0], FIELD.width - placed.sun[0],
        placed.sun[1], FIELD.height - placed.sun[1],
      );
      expect(placed.arc).toBe(true);
      expect(YEAR_RING * placed.scale).toBeGreaterThan(nearest);
    }
  });

  it("keeps the band inside the frame's corners, so it still sweeps the desk", () => {
    for (const marks of [lawson().marks, seaside().marks, one(), knot(), sprawl()]) {
      const placed = room(marks);
      const corner = Math.max(
        Math.hypot(placed.sun[0], placed.sun[1]),
        Math.hypot(FIELD.width - placed.sun[0], placed.sun[1]),
        Math.hypot(placed.sun[0], FIELD.height - placed.sun[1]),
        Math.hypot(FIELD.width - placed.sun[0], FIELD.height - placed.sun[1]),
      );
      expect(YEAR_RING * placed.scale).toBeLessThan(corner);
    }
  });

  it("holds the floor and the ceiling the frame implies", () => {
    expect(scaleFloorFor(1600, 1000)).toBeCloseTo(510 / YEAR_RING, 6);
    expect(scaleCeilingFor(1600, 1000)).toBeCloseTo((0.9 * Math.hypot(800, 500)) / YEAR_RING, 6);
    // The floor is what makes the arc unconditional: half the short side.
    expect(YEAR_RING * scaleFloorFor(1600, 1000)).toBeGreaterThan(500);
  });
});

describe("rule 2 — the unprotected type is sacred", () => {
  it("puts no halo and no sun on the header, the back link or the orb", () => {
    for (const marks of [lawson().marks, seaside().marks, [], one()]) {
      const placed = room(marks);
      expect(placed.clear).toBe(true);
      for (const guard of KEEP_OUT) {
        expect(hits({ cx: placed.sun[0], cy: placed.sun[1], r: placed.rings.sun }, guard)).toBe(false);
        for (const star of placed.stars) expect(hits(star, guard)).toBe(false);
      }
    }
  });

  it("clears the header by moving as little as it can", () => {
    // The ideal composition centres the cloud; the header is what pushes it off
    // centre, and the push should be a nudge rather than a re-composition.
    const clear = room(lawson().marks);
    const unguarded = roomOf({ marks: lawson().marks, ...FIELD, keepOut: [] });
    expect(clear.scale).toBe(unguarded.scale);
    expect(Math.hypot(clear.sun[0] - unguarded.sun[0], clear.sun[1] - unguarded.sun[1])).toBeLessThan(120);
  });

  it("letters no word onto the header, the chrome or a card", () => {
    const placed = room(lawson().marks);
    const guards = [...KEEP_OUT, ...CARDS];
    const words = berthsOf({ stars: placed.stars, sun: placed.sun, guards, ...FIELD });
    for (const word of words) {
      const box = {
        left: word.anchor === "start" ? word.x : word.x - (word.text.length + word.tag.length) * 9,
        right: word.anchor === "start" ? word.x + (word.text.length + word.tag.length) * 9 : word.x,
        top: word.y - 11,
        bottom: word.y + 4,
      };
      for (const guard of guards) {
        expect(
          box.left < guard.right && box.right > guard.left && box.top < guard.bottom && box.bottom > guard.top,
          `${word.text} on a guard`,
        ).toBe(false);
      }
    }
  });

  it("letters the urgent entries first, and letters none it cannot", () => {
    const placed = room(lawson().marks);
    const words = berthsOf({ stars: placed.stars, sun: placed.sun, guards: [...KEEP_OUT, ...CARDS], ...FIELD });
    // Whoever gets a berth, the more pressing entry chose first: the lettered
    // ones are a subsequence of the household's own lead-time order.
    expect(words.length).toBeGreaterThan(0);
    expect(words.length).toBeLessThanOrEqual(placed.stars.length);
    const urgency = placed.stars.map((star) => star.id);
    expect(words.map((word) => word.id)).toEqual(urgency.filter((id) => words.some((word) => word.id === id)));
    // A star with nowhere readable to put its name is simply not lettered —
    // never half-emerged from behind a card.
    const boxed = berthsOf({
      stars: placed.stars,
      sun: placed.sun,
      guards: [{ left: 0, top: 0, right: FIELD.width, bottom: FIELD.height }],
      ...FIELD,
    });
    expect(boxed).toEqual([]);
  });

  it("is the same lettering whatever order the stars arrive in", () => {
    const placed = room(lawson().marks);
    const guards = [...KEEP_OUT, ...CARDS];
    const forward = berthsOf({ stars: placed.stars, sun: placed.sun, guards, ...FIELD });
    const backward = berthsOf({ stars: [...placed.stars].reverse(), sun: placed.sun, guards, ...FIELD });
    expect(backward).toEqual(forward);
  });
});

/* ── the degenerate rooms ─────────────────────────────────────────────────── */

const mark = (id, days, halo = 5) => {
  const angle = ((days - 90) * Math.PI) / 180;
  const radius = days < 0 ? Math.max(24, 62 - 0.625 * -days) : Math.min(62 + 0.242 * days, 166);
  return {
    id, title: id.toUpperCase(), sectionId: "s", accent: "sage", days,
    tag: days < 0 ? `T+${-days}d` : `T−${days}d`, band: days < 0 ? "overdue" : "ok",
    dx: Math.cos(angle) * radius, dy: Math.sin(angle) * radius, halo,
  };
};
/** One entry: no spread to fit, so the room is the ratified one. */
const one = () => [mark("i-only", 40)];
/** Everything overdue, in a knot around the sun. */
const knot = () => [-3, -9, -14, -31, -60, -90].map((days, index) => mark(`i-late-${index}`, days, 6));
/** Forty entries over three years — more system than a room can hold. */
const sprawl = () =>
  Array.from({ length: 40 }, (unused, index) => mark(`i-many-${String(index).padStart(2, "0")}`, index * 27, 4 + (index % 4)));

describe("the degenerate rooms hold", () => {
  it("draws an empty household's room without dividing by nothing", () => {
    const placed = room([]);
    expect(placed.stars).toEqual([]);
    expect(placed.fitted).toBe(false);
    // The empty room is the mockup's own ratified composition, cleared of the
    // header: the sun, two rings and a year, and nothing else to say.
    expect(placed.scale).toBeCloseTo(4.95, 6);
    expect(placed.sun[0]).toBeCloseTo(690, 0);
    expect(placed.arc).toBe(true);
  });

  it("draws a one-entry household at the ratified scale rather than infinity", () => {
    const placed = room(one());
    expect(Number.isFinite(placed.scale)).toBe(true);
    expect(placed.fitted).toBe(false);
    expect(placed.scale).toBeCloseTo(4.95, 6);
    expect(placed.stars).toHaveLength(1);
  });

  it("draws two entries on one day without an infinite room", () => {
    const twins = [mark("i-a", 40), mark("i-b", 40)];
    const placed = room(twins);
    expect(placed.fitted).toBe(false);
    expect(placed.scale).toBeCloseTo(4.95, 6);
    expect(placed.stars[0].cx).toBeCloseTo(placed.stars[1].cx, 6);
  });

  it("holds an all-overdue knot: a tight cloud takes the biggest room going", () => {
    const placed = room(knot());
    expect(placed.scale).toBeCloseTo(scaleCeilingFor(FIELD.width, FIELD.height), 6);
    expect(placed.clear).toBe(true);
    expect(placed.arc).toBe(true);
    // Every one of them is inside the overdue ring, because every one of them
    // is overdue — the ring is the truth, not a decoration.
    for (const star of placed.stars) {
      expect(Math.hypot(star.cx - placed.sun[0], star.cy - placed.sun[1])).toBeLessThan(placed.rings.overdue);
    }
  });

  it("holds a sprawl: the room stays a room and the entries spill out of it", () => {
    const placed = room(sprawl());
    expect(placed.scale).toBeCloseTo(scaleFloorFor(FIELD.width, FIELD.height), 6);
    expect(placed.arc).toBe(true);
    // The desire is what yields: you cannot see all of your own system at once.
    expect(placed.stars.some((star) => star.cx < 0 || star.cx > FIELD.width || star.cy < 0 || star.cy > FIELD.height))
      .toBe(true);
  });

  it("says so when a household is too crowded to keep the type clear", () => {
    // A guard across the whole frame cannot be cleared by any sun, at any
    // scale. The rule must not answer by breaking rule 1 or by dropping a
    // star: it keeps the least-bad composition and reports it.
    const placed = roomOf({
      marks: sprawl(),
      ...FIELD,
      keepOut: [{ left: 0, top: 0, right: FIELD.width, bottom: FIELD.height }],
    });
    expect(placed.crowded).toBe(true);
    expect(placed.clear).toBe(false);
    expect(placed.stars).toHaveLength(40);
    expect(placed.arc).toBe(true);
  });
});

describe("the descent", () => {
  it("is a pure function of scrollTop, exact at both ends", () => {
    expect(liftOf(0, 1000, 2400)).toBe(0);
    expect(liftOf(1000, 1000, 2400)).toBe(1);
    expect(liftOf(2400, 1000, 2400)).toBe(1);
  });

  it("is monotonic, so the way back up is the way down reversed", () => {
    let previous = -1;
    for (let top = 0; top <= 1400; top += 25) {
      const lift = liftOf(top, 1000, 2400);
      expect(lift).toBeGreaterThanOrEqual(previous);
      previous = lift;
    }
    expect(liftOf(500, 1000, 2400)).toBe(liftOf(500, 1000, 2400));
  });

  it("starts moving on the first scrolled pixel and never before", () => {
    expect(liftOf(-40, 1000, 2400)).toBe(0);
    expect(liftOf(1, 1000, 2400)).toBeGreaterThan(0);
  });

  it("is overhead within 72% of a short page", () => {
    // A page barely taller than the window still gets the whole descent.
    expect(liftOf(720, 1000, 2000)).toBe(1);
  });
});

describe("the field and the desk speak one unit", () => {
  it("is one multiply at the gate's own viewport", () => {
    const map = skyMap(1600, 1000);
    expect(map).toEqual({ k: 1, ox: 0, oy: 0 });
    expect(toField({ left: 10, top: 20, right: 30, bottom: 40 }, map))
      .toEqual({ left: 10, top: 20, right: 30, bottom: 40 });
  });

  it("slices about the centre, as the sky's own preserveAspectRatio does", () => {
    const map = skyMap(1600, 1200);
    expect(map.k).toBeCloseTo(1.2, 6);
    expect(map.oy).toBeCloseTo(0, 6);
    expect(map.ox).toBeCloseTo((1600 - 1600 * 1.2) / 2, 6);
    // A rectangle at the desk's left edge maps back inside the field.
    expect(toField({ left: 0, top: 0, right: 100, bottom: 100 }, map).left)
      .toBeCloseTo((0 - map.ox) / 1.2, 6);
  });
});

/*
 * The cards, at the gate's own viewport: a 1060 column centred in the field,
 * two columns of glass under the header. Words may not sit on them (a label
 * under glass is unreadable ink that costs the panel's small type its own
 * contrast for nothing) even though halos are meant to.
 */
const CARDS = [
  { left: 294, top: 182, right: 787, bottom: 560 },
  { left: 813, top: 182, right: 1306, bottom: 900 },
  { left: 294, top: 578, right: 787, bottom: 900 },
];

describe("the composition the mockup measured", () => {
  it("spends its ink on the sky and none of it on the type", () => {
    // The whole of rule 2, restated as the property the contrast measurement
    // then verifies on real pixels: nothing the backdrop draws — halo, sun,
    // word — is inside a run of unprotected small type.
    const placed = room(lawson().marks);
    const words = berthsOf({ stars: placed.stars, sun: placed.sun, guards: [...KEEP_OUT, ...CARDS], ...FIELD });
    expect(placed.clear).toBe(true);
    expect(words.every((word) => word.leader)).toBe(true);
  });
});
