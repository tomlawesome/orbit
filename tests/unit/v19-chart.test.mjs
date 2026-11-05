import { describe, expect, it } from "vitest";

// The workspace→chart transform is plain ESM inside web/, which root vitest
// excludes from COLLECTION (#425: web's own suites are Playwright); importing
// a module from there is fine — only test files are excluded.
import {
  bodySize,
  DESK_SIZE,
  POCKET_SIZE,
  constellationPosOf,
  daysUntil,
  dialBodiesOf,
  dialPlacement,
  seatBodies,
  CLOSE_UP_DAYS,
  HORIZON_DAYS,
  OVERDUE_CLOSE_UP_DAYS,
  OVERDUE_SPAN_DAYS,
  corridorOf,
  galaxyOf,
  manifestGroupsOf,
} from "../../web/src/lib/data/chart.js";
import { bandOf } from "../../web/src/lib/format.js";
import { WORKSPACE_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";

const TODAY = "2026-08-13"; // DESIGN_TODAY: the date every mockup was drawn against

// #414/#451, #1464: the dial is an orbital calendar. Today sits at 12 o'clock
// and each day of lead time is one degree clockwise (angle° = days − 90).
// Distance is logarithmic (decision 37): radius = 62 + 104·ln(1 + d/14)/ln(1 + 365/14),
// reaching the rim (166) at a year; overdue bodies fall inward on a mirror curve
// (62 − 38·ln(1 + |d|/7)/ln(1 + 60/7)) to the event horizon (24) at 60 days.
// Every expected radius below was worked out independently (python3) and
// rounded to 0.1; none is recomputed with the formula.
describe("dial placement law", () => {
  it("places bodies where the log law puts them (bearing a degree a day)", () => {
    // [daysUntil, x, y]: the mockup's days, positions from the log radius
    // (#1464: was the linear 62 + 0.242·days of design/v19/home.html)
    const bodies = [
      [16, 213.7, 107.3],
      [22, 224.4, 104.9],
      [51, 275.8, 120.5],
      [61, 290.5, 134.3],
      [122, 303.4, 260.8],
    ];
    for (const [days, cx, cy] of bodies) {
      const p = dialPlacement(days);
      expect(Math.hypot(p.x - cx, p.y - cy), `T−${days}d`).toBeLessThan(0.2);
    }
  });

  it("places overdue bodies inside the ring on the same clock", () => {
    const p = dialPlacement(-16); // radius 42.0 on the mirror curve
    expect(Math.hypot(p.x - 178.4, p.y - 149.6)).toBeLessThan(0.2);
    expect(p.radius).toBeLessThan(62);
  });

  it("corrects the #414 defect: T−161d belongs at 161 days, not 177", () => {
    const correct = dialPlacement(161);
    const handPlaced = { x: 199.1, y: 294.3 }; // where the mockup drew it
    expect(Math.hypot(correct.x - handPlaced.x, correct.y - handPlaced.y)).toBeGreaterThan(10);
  });

  it("never leaves the dial nor collapses into the sun", () => {
    expect(dialPlacement(4000).radius).toBeLessThanOrEqual(166);
    expect(dialPlacement(-4000).radius).toBeGreaterThanOrEqual(24);
  });

  it("names the four constants (decision 37)", () => {
    expect([CLOSE_UP_DAYS, HORIZON_DAYS, OVERDUE_CLOSE_UP_DAYS, OVERDUE_SPAN_DAYS]).toEqual([14, 365, 7, 60]);
  });

  describe("radius by days (log law, #1464)", () => {
    const cases = [
      [0, 62.0],
      [14, 83.9],
      [30, 98.1],
      [90, 125.2],
      [365, 166.0],
      [366, 166.0],
      [1000, 166.0],
      [-1, 59.8],
      [-7, 50.3],
      [-60, 24.0],
      [-200, 24.0],
    ];
    for (const [days, radius] of cases) {
      it(`${days} days sits at radius ${radius}`, () => {
        expect(dialPlacement(days).radius).toBeCloseTo(radius, 1);
      });
    }
  });

  it("0 days is 62, a year and beyond is the rim, 60 days overdue and beyond is the horizon", () => {
    expect(dialPlacement(0).radius).toBeCloseTo(62, 5);
    expect(dialPlacement(365).radius).toBeCloseTo(166, 5);
    expect(dialPlacement(5000).radius).toBe(166);
    expect(dialPlacement(-60).radius).toBeCloseTo(24, 5);
    expect(dialPlacement(-5000).radius).toBe(24);
  });

  it("radius increases strictly with days from 0 to 365", () => {
    let prev = -Infinity;
    for (let d = 0; d <= 365; d++) {
      const r = dialPlacement(d).radius;
      expect(r, `day ${d}`).toBeGreaterThan(prev);
      prev = r;
    }
  });

  it("overdue radius decreases strictly from 0 to −60 days", () => {
    let prev = Infinity;
    for (let d = 0; d >= -60; d--) {
      const r = dialPlacement(d).radius;
      expect(r, `day ${d}`).toBeLessThan(prev);
      prev = r;
    }
  });

  it("keeps the bearing: a degree a day, today at 12 o'clock, clamped to −90..430", () => {
    const deg = (days) => (dialPlacement(days).angle * 180) / Math.PI;
    expect(deg(0)).toBeCloseTo(-90, 6);
    expect(deg(90)).toBeCloseTo(0, 6);
    expect(deg(-90)).toBeCloseTo(-180, 6);
    expect(deg(430)).toBeCloseTo(340, 6);
    expect(deg(500)).toBeCloseTo(340, 6);
    expect(deg(-200)).toBeCloseTo(-180, 6);
  });

  it("keeps its return shape, x and y rounded to 0.1", () => {
    const p = dialPlacement(90); // angle 0, radius 125.2275 -> x = 190 + 125.2
    expect(Object.keys(p).sort()).toEqual(["angle", "radius", "x", "y"]);
    expect(p.x).toBe(315.2);
    expect(p.y).toBe(190);
  });
});

// #1464 (round 4 G's rule): planets that would touch are nudged apart by
// bearing only. Distances here are measured from the returned angle and radius.
describe("seatBodies", () => {
  const at = (days) => ({ days, ...dialPlacement(days) });
  const gap = (a, b) =>
    Math.hypot(a.radius * Math.cos(a.angle) - b.radius * Math.cos(b.angle), a.radius * Math.sin(a.angle) - b.radius * Math.sin(b.angle));
  const sized = (n) => () => n;
  const deg = (rad) => (rad * 180) / Math.PI;

  it("pushes a touching outer body clear (r1 + r2 + 3) and the inner keeps its bearing", () => {
    const input = [at(0), at(1)]; // radii 62.0 and 64.2, one degree apart: 2.4 units
    const out = seatBodies(input, sized(5));
    expect(gap(out[0], out[1])).toBeGreaterThanOrEqual(13);
    expect(out[0].angle).toBe(input[0].angle);
    // smallest +shift that clears 13 units: 43 steps of 0.25 degree
    expect(deg(out[1].angle)).toBeCloseTo(-78.25, 6);
  });

  it("keeps the bearing of a body that is already clear", () => {
    const input = [at(0), at(90)];
    const out = seatBodies(input, sized(5));
    expect(out.map((b) => b.angle)).toEqual(input.map((b) => b.angle));
    expect(out.map((b) => [b.x, b.y])).toEqual(input.map((b) => [b.x, b.y]));
  });

  it("never changes a radius", () => {
    const input = [at(-3), at(0), at(1), at(2), at(3), at(40)];
    const out = seatBodies(input, sized(6));
    expect(out.map((b) => b.radius)).toEqual(input.map((b) => b.radius));
  });

  it("returns x and y that match the new angle, rounded to 0.1", () => {
    const out = seatBodies([at(0), at(1)], sized(5));
    const moved = out[1];
    expect(moved.x).toBeCloseTo(190 + Math.cos(moved.angle) * moved.radius, 1);
    expect(moved.y).toBeCloseTo(190 + Math.sin(moved.angle) * moved.radius, 1);
    expect(Math.round(moved.x * 10)).toBeCloseTo(moved.x * 10, 6);
  });

  it("seats inner first, ties by days, whatever order the input is in", () => {
    const a = at(1);
    const b = at(0);
    const out = seatBodies([a, b], sized(5));
    const byDays = (days) => out.find((x) => x.days === days);
    expect(byDays(0).angle).toBe(b.angle); // inner keeps its bearing
    expect(byDays(1).angle).not.toBe(a.angle); // outer moves
  });

  it("gives the same output for the same input", () => {
    const input = [at(0), at(1), at(2), at(3)];
    expect(seatBodies(input, sized(5))).toEqual(seatBodies(input, sized(5)));
  });

  it("does not mutate the input", () => {
    const input = [at(0), at(1), at(2)];
    const before = JSON.parse(JSON.stringify(input));
    seatBodies(input, sized(5));
    expect(input).toEqual(before);
  });

  it("takes the smallest shift, and + before −", () => {
    // Same bearing, 4.2 units apart in radius: + and − are equally clear, so + wins.
    const mk = (radius) => ({ days: 0, angle: -Math.PI / 2, radius, x: 190, y: 190 - radius });
    const out = seatBodies([mk(62), mk(66.2)], sized(5));
    expect(out[0].angle).toBe(-Math.PI / 2);
    // 13 units first reached 45 steps of 0.25 degree on (62, 66.2)
    expect(deg(out[1].angle)).toBeCloseTo(-78.75, 6);
  });

  it("sizes each body with the function it is given", () => {
    const small = seatBodies([at(0), at(1)], sized(1)); // 1 + 1 + 3 = 5 units
    const big = seatBodies([at(0), at(1)], sized(8)); // 8 + 8 + 3 = 19 units
    expect(gap(small[0], small[1])).toBeGreaterThanOrEqual(5);
    expect(gap(big[0], big[1])).toBeGreaterThanOrEqual(19);
    expect(Math.abs(big[1].angle - at(1).angle)).toBeGreaterThan(Math.abs(small[1].angle - at(1).angle));
  });
});

describe("body size (bigger = costlier per year, #1460)", () => {
  // £/yr -> [desk, pocket] radius, the design note's anchor table
  const ANCHORS = [
    [50, 3.5, 5.0],
    [250, 4.8, 6.1],
    [500, 5.4, 6.7],
    [1000, 6.2, 7.3],
    [2500, 7.4, 8.2],
    [5000, 8.4, 9.0],
    [10000, 9.6, 9.8],
    [50000, 13.0, 12.0],
  ];
  it("exports the two ranges", () => {
    expect(DESK_SIZE).toEqual([3.5, 13]);
    expect(POCKET_SIZE).toEqual([5, 12]);
  });
  for (const [pounds, desk, pocket] of ANCHORS) {
    it(`desk radius at £${pounds}/yr is ${desk}`, () => {
      expect(Math.abs(bodySize(pounds * 100, 12, DESK_SIZE) - desk)).toBeLessThanOrEqual(0.05);
    });
    it(`pocket radius at £${pounds}/yr is ${pocket}`, () => {
      expect(Math.abs(bodySize(pounds * 100, 12, POCKET_SIZE) - pocket)).toBeLessThanOrEqual(0.05);
    });
  }
  it("annualises: £5 a month equals £60 a year", () => {
    for (const range of [DESK_SIZE, POCKET_SIZE]) {
      expect(bodySize(500, 1, range)).toBe(bodySize(6000, 12, range));
    }
  });
  it("counts a one-off (0 or no recurrence) once", () => {
    for (const range of [DESK_SIZE, POCKET_SIZE]) {
      const yearly = bodySize(25000, 12, range);
      expect(bodySize(25000, 0, range)).toBe(yearly);
      expect(bodySize(25000, undefined, range)).toBe(yearly);
    }
  });
  it("never shrinks as the yearly cost grows (£1 to £1,000,000)", () => {
    for (const range of [DESK_SIZE, POCKET_SIZE]) {
      let last = 0;
      for (let pounds = 1; pounds <= 1_000_000; pounds = Math.ceil(pounds * 1.25)) {
        const r = bodySize(pounds * 100, 12, range);
        expect(r).toBeGreaterThanOrEqual(last);
        last = r;
      }
    }
  });
  it("separates the dear from the cheap: £84,000 vs £250", () => {
    expect(bodySize(8_400_000, 12, DESK_SIZE) / bodySize(25000, 12, DESK_SIZE)).toBeGreaterThanOrEqual(2.5);
    expect(bodySize(8_400_000, 12, POCKET_SIZE) / bodySize(25000, 12, POCKET_SIZE)).toBeGreaterThanOrEqual(1.8);
  });
  it("gives no cost the smallest radius", () => {
    expect(bodySize(undefined, 12, DESK_SIZE)).toBe(3.5);
    expect(bodySize(undefined, 12, POCKET_SIZE)).toBe(5);
    expect(bodySize(null, undefined, DESK_SIZE)).toBe(3.5);
    expect(bodySize(0, 12, POCKET_SIZE)).toBe(5);
  });
  it("stays within the range at both extremes", () => {
    for (const [lo, hi] of [DESK_SIZE, POCKET_SIZE]) {
      for (const cost of [100, 1_000_000_000]) {
        const r = bodySize(cost, 12, [lo, hi]);
        expect(r).toBeGreaterThanOrEqual(lo);
        expect(r).toBeLessThanOrEqual(hi);
      }
    }
    expect(bodySize(1_000_000_000, 12, DESK_SIZE)).toBe(13);
    expect(bodySize(100, 12, POCKET_SIZE)).toBe(5);
  });
  it("rounds to 0.1", () => {
    const r = bodySize(123456, 7, DESK_SIZE);
    expect(Math.abs(r * 10 - Math.round(r * 10))).toBeLessThan(1e-9);
  });
});

describe("urgency bands", () => {
  it("mirrors the chart key: overdue, due soon, upcoming, wide orbit", () => {
    expect(bandOf(-1)).toBe("overdue");
    expect(bandOf(0)).toBe("due-soon");
    expect(bandOf(30)).toBe("due-soon");
    expect(bandOf(31)).toBe("upcoming");
    expect(bandOf(90)).toBe("upcoming");
    expect(bandOf(91)).toBe("ok");
    expect(bandOf(null)).toBe("unscheduled");
  });
});

describe("the fixed galaxy (CON-13/#428)", () => {
  it("gives a household one absolute position, forever", () => {
    const a = constellationPosOf("55aaf11b-02c7-4654-b2e9-009d4917a8dd");
    const b = constellationPosOf("55aaf11b-02c7-4654-b2e9-009d4917a8dd");
    expect(a).toEqual(b);
    const dist = Math.hypot(a[0], a[1]);
    expect(dist).toBeGreaterThanOrEqual(600);
    expect(dist).toBeLessThanOrEqual(800);
  });

  it("scatters distinct households to distinct bearings", () => {
    const bearings = ["h-one", "h-two", "h-three"].map((id) => {
      const [x, y] = constellationPosOf(id);
      return Math.atan2(y, x).toFixed(2);
    });
    expect(new Set(bearings).size).toBe(3);
  });

  it("builds the galaxy from a workspace, capped at five", () => {
    const households = Array.from({ length: 7 }, (_, i) => ({
      id: `hh-${i}`,
      name: `House ${i}`,
      items: [
        { id: `it-${i}`, title: "t", dueDate: "2026-08-20", status: "active" },
      ],
    }));
    const galaxy = galaxyOf({ households }, TODAY);
    expect(Object.keys(galaxy).length).toBe(5);
    const first = galaxy["hh-0"];
    expect(first.name).toBe("House 0");
    expect(first.pos.length).toBe(2);
    expect(first.planets.length).toBeGreaterThan(0);
    const [, , r, tone] = first.planets[0];
    expect(r).toBeGreaterThan(1.5);
    expect(tone).toBe("--warm"); // due in 7 days = needs attention
  });
});

const HOUSEHOLD = {
  id: "hh-test",
  sections: [
    { id: "s-home", name: "Home" },
    { id: "s-vehicles", name: "Vehicles" },
  ],
  items: [
    { id: "i-a", title: "Overdue thing", sectionId: "s-home", status: "active", subtype: "service", scheduleKind: "service", dueDate: "2026-07-28", costMinor: 15000, costIsEstimate: true, currency: "GBP", recurrenceMonths: 12 },
    { id: "i-b", title: "Inspection", sectionId: "s-vehicles", status: "active", subtype: "inspection", scheduleKind: "service", dueDate: "2026-08-29", costMinor: 5485, currency: "GBP", recurrenceMonths: 12 },
    { id: "i-c", title: "Far out", sectionId: "s-home", status: "active", subtype: "service", scheduleKind: "service", dueDate: "2027-01-21", costMinor: 30000, costIsEstimate: true, currency: "GBP", recurrenceMonths: 12 },
    { id: "i-d", title: "Archived", sectionId: "s-home", status: "archived", subtype: "service", scheduleKind: "service", dueDate: "2026-08-20", costMinor: 1000, currency: "GBP", recurrenceMonths: 12 },
  ],
};
const SUGGESTION = { id: "sug-1", title: "Insurance", renewsOn: "2026-10-03", costMinor: 40000, currency: "GBP" };

describe("dialBodiesOf", () => {
  it("places active items and suggestions by the law, sorted by lead time", () => {
    const bodies = dialBodiesOf(HOUSEHOLD, { suggestions: [SUGGESTION], today: TODAY });
    expect(bodies.map((b) => b.id)).toEqual(["i-a", "i-b", "sug-1", "i-c"]);
    expect(bodies.find((b) => b.id === "i-d")).toBeUndefined();
    const inspection = bodies.find((b) => b.id === "i-b");
    expect(inspection.overdue).toBe(false);
    expect(inspection.paint).toBe("amber");
    expect(inspection.trail).toBe(true);
    expect(inspection.closest).toBe(true); // first future non-suggestion = the comet's anchor
    const suggestion = bodies.find((b) => b.suggestion);
    expect(suggestion.paint).toBe("accent");
    const far = bodies.find((b) => b.id === "i-c");
    expect(far.paint).toBe("jade");
    expect(far.trail).toBe(false);
    expect(bodies[0].overdue).toBe(true);
  });

  it("seats bodies two days apart so they never overlap at the desk size (#1464)", () => {
    const item = (id, dueDate) => ({ id, title: id, sectionId: "s-home", status: "active", subtype: "service", scheduleKind: "service", dueDate, costMinor: 5000000, currency: "GBP", recurrenceMonths: 12 });
    // 14 and 16 days out (2026-08-27, 2026-08-29): unseated they sit 3.7 units apart
    const hh = { ...HOUSEHOLD, items: [item("near", "2026-08-27"), item("nearer", "2026-08-29")] };
    const [a, b] = dialBodiesOf(hh, { today: TODAY });
    expect([a.size, b.size]).toEqual([13, 13]);
    expect(Math.hypot(a.placement.x - b.placement.x, a.placement.y - b.placement.y)).toBeGreaterThanOrEqual(29 - 0.2);
    expect(a.placement.angle).toBe(dialPlacement(14).angle); // the inner keeps its bearing
    expect(a.placement.radius).toBeCloseTo(83.9, 1); // radius is never changed
    expect(b.placement.radius).toBeCloseTo(86.0, 1);
  });

  it("seats bodies two days apart at the pocket size in pocketPlacement, radius unchanged (#1464)", () => {
    const item = (id, dueDate) => ({ id, title: id, sectionId: "s-home", status: "active", subtype: "service", scheduleKind: "service", dueDate, costMinor: 5000000, currency: "GBP", recurrenceMonths: 12 });
    const hh = { ...HOUSEHOLD, items: [item("near", "2026-08-27"), item("nearer", "2026-08-29")] };
    const [a, b] = dialBodiesOf(hh, { today: TODAY });
    expect([a.pocketSize, b.pocketSize]).toEqual([12, 12]);
    expect(a.pocketPlacement).toBeDefined();
    expect(Object.keys(a.pocketPlacement).sort()).toEqual(["angle", "radius", "x", "y"]);
    // 12 + 12 + 3 = 27 units, less 0.2 for x and y rounded to 0.1
    expect(Math.hypot(a.pocketPlacement.x - b.pocketPlacement.x, a.pocketPlacement.y - b.pocketPlacement.y)).toBeGreaterThanOrEqual(27 - 0.2);
    expect(a.pocketPlacement.angle).toBe(dialPlacement(14).angle); // inner keeps its bearing
    expect(a.pocketPlacement.radius).toBe(a.placement.radius);
    expect(b.pocketPlacement.radius).toBe(b.placement.radius);
  });

  it("carries pocketSize alongside size, both from yearly cost (#1460)", () => {
    const bodies = dialBodiesOf(HOUSEHOLD, { suggestions: [SUGGESTION], today: TODAY });
    const a = bodies.find((b) => b.id === "i-a"); // £150 every 12 months
    expect(a.size).toBe(bodySize(15000, 12, DESK_SIZE));
    expect(a.pocketSize).toBe(bodySize(15000, 12, POCKET_SIZE));
    const c = bodies.find((b) => b.id === "i-c"); // £300 every 12 months
    expect(c.size).toBe(bodySize(30000, 12, DESK_SIZE));
    expect(c.pocketSize).toBe(bodySize(30000, 12, POCKET_SIZE));
    // a suggestion has no recurrence: its cost counts once
    const s = bodies.find((b) => b.id === "sug-1");
    expect(s.size).toBe(bodySize(40000, undefined, DESK_SIZE));
    expect(s.pocketSize).toBe(bodySize(40000, undefined, POCKET_SIZE));
    for (const b of bodies) expect(typeof b.pocketSize).toBe("number");
  });
});

describe("manifestGroupsOf", () => {
  it("groups by urgency with sections joined and the closest approach named", () => {
    const groups = manifestGroupsOf(HOUSEHOLD, { suggestions: [SUGGESTION], today: TODAY });
    expect(groups.attention.map((r) => r.id)).toEqual(["i-a", "i-b"]);
    expect(groups.later.map((r) => r.id)).toEqual(["i-c"]);
    expect(groups.attention[1].section).toBe("Vehicles");
    expect(groups.closest.id).toBe("i-b");
    expect(groups.suggestions[0].id).toBe("sug-1");
    expect(groups.attention[0].costIsEstimate).toBe(true);
  });
});

// A brand-new user has no household at all (#453's journey; until it lands
// the transform must degrade, never throw).
describe("the empty workspace", () => {
  it("renders nothing rather than crashing", () => {
    expect(dialBodiesOf(null, { today: TODAY })).toEqual([]);
    const groups = manifestGroupsOf(null, { today: TODAY });
    expect(groups.attention).toEqual([]);
    expect(groups.later).toEqual([]);
    expect(groups.closest).toBe(null);
    expect(galaxyOf({ households: [] }, TODAY)).toEqual({});
  });
});

describe("daysUntil", () => {
  it("counts calendar days independent of clock time", () => {
    expect(daysUntil("2026-08-29", TODAY)).toBe(16);
    expect(daysUntil("2026-07-28", TODAY)).toBe(-16);
    expect(daysUntil(undefined, TODAY)).toBe(null);
  });
});

// #461: the approach corridor — every household's schedule unrolled onto one
// line of time. An order, not a scale: overdue above today, the current month
// headerless, then a rule per month with anything approaching.
describe("corridorOf", () => {
  const corridor = corridorOf(WORKSPACE_FIXTURE, TODAY);

  it("spans every system and counts honestly", () => {
    expect(corridor.total).toBe(16);
    expect(corridor.systems).toBe(5);
    expect(corridor.monthsSpanned).toBe(11);
    expect(corridor.horizon).toBe("June");
  });

  it("puts only the overdue in the red zone, and today's month headerless", () => {
    expect(corridor.overdue.map((row) => row.id)).toEqual(["i-gutter"]);
    expect(corridor.current.map((row) => row.id)).toEqual(["i-seaside-0", "i-grans-0", "i-mot"]);
  });

  it("rules exactly the months with something approaching, in date order", () => {
    expect(corridor.months.map((month) => [month.label, month.rows.length])).toEqual([
      ["SEP", 2], ["OCT", 1], ["NOV", 1], ["DEC", 2], ["JAN", 2], ["MAR", 1], ["APR", 1], ["MAY", 1], ["JUN", 1],
    ]);
    expect(corridor.months[0].rows.map((row) => row.id)).toEqual(["i-boiler", "i-narrow-1"]);
  });

  it("marks whose sky each entry belongs to, and keeps the dial's vocabulary", () => {
    const bss = corridor.months[0].rows[1];
    expect(bss.title).toBe("Boat Safety Scheme examination");
    expect(bss.away).toBe(true);
    expect(bss.band).toBe("upcoming");
    expect(bss.costIsEstimate).toBe(false);
    const mot = corridor.current[2];
    expect(mot.away).toBe(false);
    expect(mot.band).toBe("due-soon");
  });

  it("degrades to an empty corridor rather than throwing", () => {
    const empty = corridorOf(null, TODAY);
    expect(empty.total).toBe(0);
    expect(empty.overdue).toEqual([]);
    expect(empty.months).toEqual([]);
    expect(empty.horizon).toBe(null);
  });
});

// #1281: an active item kept without a key date has a seat at the corridor's
// foot (with the undated suggestions), so a desk save with no date opens on a
// row like any other. It is counted, but it is never overdue, never in this
// month and never under a month's rule: there is no date to put it there.
describe("corridorOf with an undated item", () => {
  const [harlow] = WORKSPACE_FIXTURE.households;
  const undatedItem = {
    id: "i-warranty", title: "Washing machine warranty", sectionId: "s-home",
    status: "active", dueDate: null, scheduleKind: "expiry",
  };
  const plain = corridorOf({ households: [harlow], activeHouseholdId: harlow.id }, TODAY);
  const corridor = corridorOf(
    { households: [{ ...harlow, items: [...harlow.items, undatedItem] }], activeHouseholdId: harlow.id },
    TODAY,
  );

  it("seats it in the undated bucket and counts it", () => {
    expect(corridor.undated.map((row) => row.id)).toEqual(["i-warranty"]);
    expect(corridor.total).toBe(plain.total + 1);
    const row = corridor.undated[0];
    expect(row.dueDate).toBe(null);
    expect(row.band).toBe("unscheduled");
    expect(row.section).toBe("Home");
  });

  it("keeps it out of the red zone, this month and every month's rule", () => {
    const ids = (/** @type {{ id: string }[]} */ rows) => rows.map((row) => row.id);
    expect(ids(corridor.overdue)).not.toContain("i-warranty");
    expect(ids(corridor.current)).not.toContain("i-warranty");
    for (const month of corridor.months) expect(ids(month.rows)).not.toContain("i-warranty");
    expect(corridor.months).toEqual(plain.months);
    expect(corridor.horizon).toBe(plain.horizon);
    expect(corridor.monthsSpanned).toBe(plain.monthsSpanned);
  });

  it("sorts after every dated row", () => {
    const dated = [...corridor.overdue, ...corridor.current, ...corridor.months.flatMap((month) => month.rows)];
    expect(dated.length).toBeGreaterThan(0);
    for (const row of dated) expect(row.days).toBeLessThan(corridor.undated[0].days);
  });
});

// §14 (#469): suggestions ride the corridor in date order — the manifest and
// the corridor are ONE surface now.
describe("corridorOf with suggestions", () => {
  const corridor = corridorOf(
    { households: WORKSPACE_FIXTURE.households.slice(0, 1), activeHouseholdId: "hh-harlow-1" },
    TODAY,
    { suggestions: [{ id: "r-insurance", receiptId: "r-insurance", title: "Home insurance renewal", renewsOn: "2026-10-03", costMinor: 40000, currency: "GBP", sourceDocument: "1 forwarded document" }] },
  );

  it("merges the suggestion at its renewal date, dashed and actionable", () => {
    const october = corridor.months.find((month) => month.label === "OCT");
    expect(october.rows.map((row) => row.id)).toEqual(["r-insurance", "i-chimney"]);
    const suggestion = october.rows[0];
    expect(suggestion.suggestion).toBe(true);
    expect(suggestion.band).toBe("suggestion");
    expect(suggestion.receiptId).toBe("r-insurance");
  });

  it("sits an undated catch at the very end rather than inventing a date", () => {
    const undatedCorridor = corridorOf(
      { households: [], activeHouseholdId: null },
      TODAY,
      { suggestions: [{ id: "r-x", receiptId: "r-x", title: "Forwarded email", renewsOn: null }] },
    );
    expect(undatedCorridor.undated.map((row) => row.id)).toEqual(["r-x"]);
    expect(undatedCorridor.months).toEqual([]);
  });
});
