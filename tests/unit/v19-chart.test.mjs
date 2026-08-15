import { describe, expect, it } from "vitest";

// The workspace→chart transform is plain ESM inside web/, which root vitest
// excludes from COLLECTION (#425: web's own suites are Playwright); importing
// a module from there is fine — only test files are excluded.
import {
  bandOf,
  bodySize,
  constellationPosOf,
  daysUntil,
  dialPlacement,
  galaxyOf,
} from "../../web/src/lib/data/chart.js";

const TODAY = "2026-08-13"; // DESIGN_TODAY: the date every mockup was drawn against

// #414/#451: the ratified mockup's dial follows one law — the dial is an
// orbital calendar. Today sits at 12 o'clock and each day of lead time is one
// degree clockwise (angle° = days − 90); distance grows linearly with time
// (radius = 62 + 0.242·days), and overdue bodies fall inward (62 − 0.625·|days|).
// Every hand-placed mockup body obeys it to ~2px except the T−161d body,
// which sits where 177 days would put it — the #414 defect.
describe("dial placement law", () => {
  it("places the mockup's bodies where the mockup drew them", () => {
    // [daysUntil, mockup cx, mockup cy] lifted from design/v19/home.html
    const bodies = [
      [16, 207.9, 126.7], // Car MOT, T−16d
      [22, 214.9, 127.5], // Boiler service, T−22d
      [51, 246.1, 141.7], // Home insurance suggestion, T−51d
      [61, 256.6, 151.9], // Chimney sweep, T−61d
      [122, 268.9, 236.2], // Smoke alarm batteries, T−122d
    ];
    for (const [days, cx, cy] of bodies) {
      const p = dialPlacement(days);
      expect(Math.hypot(p.x - cx, p.y - cy), `T−${days}d`).toBeLessThan(3);
    }
  });

  it("places overdue bodies inside the ring on the same clock", () => {
    // Gutter clearing, T+16d, mockup (175.8, 140)
    const p = dialPlacement(-16);
    expect(Math.hypot(p.x - 175.8, p.y - 140)).toBeLessThan(2);
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
});

describe("body size (bigger = costlier)", () => {
  it("matches the mockup's cost→size curve", () => {
    expect(bodySize(5485)).toBeCloseTo(5.2, 0.5); // £54.85 → r 5.2
    expect(bodySize(1200)).toBeCloseTo(3.5, 0.5); // £12 → r 3.5
    expect(bodySize(12000)).toBeCloseTo(6, 0.5); // £120 → r 6
  });
  it("is bounded and has a costless default", () => {
    expect(bodySize(99999999)).toBeLessThanOrEqual(8.5);
    expect(bodySize(1)).toBeGreaterThanOrEqual(3.5);
    expect(bodySize(undefined)).toBe(4);
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

describe("daysUntil", () => {
  it("counts calendar days independent of clock time", () => {
    expect(daysUntil("2026-08-29", TODAY)).toBe(16);
    expect(daysUntil("2026-07-28", TODAY)).toBe(-16);
    expect(daysUntil(undefined, TODAY)).toBe(null);
  });
});
