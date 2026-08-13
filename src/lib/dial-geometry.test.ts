import { describe, expect, it } from "vitest";
import {
  angleForDays,
  bodyRadiusForCostBand,
  computeBodyGeometry,
  describeDaysRemaining,
  describeOrbitArc,
  isOverdueRadius,
  monthCompassLabels,
  polarPoint,
  radiusForDays,
  RING,
  YEAR_DAYS,
  DIAL_CENTER,
} from "./dial-geometry";

describe("angleForDays: month-angle mapping (angle = due month, 12 o'clock = current month, clockwise)", () => {
  it("places 'today' at 12 o'clock (0deg)", () => {
    expect(angleForDays(0)).toBe(0);
  });

  it("places a due date a quarter-year out at 3 o'clock (90deg)", () => {
    expect(angleForDays(YEAR_DAYS / 4)).toBeCloseTo(90, 5);
  });

  it("places a due date half a year out at 6 o'clock (180deg) — the far side of the compass", () => {
    expect(angleForDays(YEAR_DAYS / 2)).toBeCloseTo(180, 5);
  });

  it("places a due date three-quarters of a year out at 9 o'clock (270deg)", () => {
    expect(angleForDays((YEAR_DAYS * 3) / 4)).toBeCloseTo(270, 5);
  });

  it("wraps a full year back around to 12 o'clock (year wrap)", () => {
    expect(angleForDays(YEAR_DAYS)).toBeCloseTo(0, 5);
    expect(angleForDays(YEAR_DAYS + 10)).toBeCloseTo(angleForDays(10), 5);
  });

  it("wraps overdue (negative) days into the top of the compass, just behind 12 o'clock", () => {
    // 16 days overdue reproduces v19's gutter-clearing body at ~344.2deg.
    expect(angleForDays(-16)).toBeCloseTo(344.23, 1);
    expect(angleForDays(-1)).toBeCloseTo(359.01, 1);
  });

  it("matches v19's placed bodies within a fraction of a degree", () => {
    expect(angleForDays(16)).toBeCloseTo(15.75, 1); // Car MOT, T-16d
    expect(angleForDays(22)).toBeCloseTo(21.7, 1); // Boiler service, T-22d
    expect(angleForDays(61)).toBeCloseTo(60.24, 0); // Chimney sweep, T-61d
  });
});

describe("radiusForDays: radius banding across the three rings", () => {
  it("puts a body due today exactly on the perihelion threshold ring", () => {
    expect(radiusForDays(0)).toBe(RING.threshold);
  });

  it("puts a body due in exactly six months on the middle reference ring", () => {
    expect(radiusForDays(YEAR_DAYS / 2)).toBeCloseTo(RING.mid, 5);
  });

  it("puts a body due in exactly a year on the outer ring", () => {
    expect(radiusForDays(YEAR_DAYS)).toBeCloseTo(RING.outer, 5);
  });

  it("clamps radius at the outer ring for anything a year or further out", () => {
    expect(radiusForDays(YEAR_DAYS * 3)).toBe(RING.outer);
  });

  it("grows monotonically with days remaining", () => {
    const days = [0, 10, 50, 120, 200, 365];
    const radii = days.map(radiusForDays);
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]).toBeGreaterThan(radii[i - 1]);
    }
  });

  it("matches v19's placed scheduled bodies within a px or so", () => {
    expect(radiusForDays(16)).toBeCloseTo(65.8, 0); // Car MOT
    expect(radiusForDays(61)).toBeCloseTo(76.73, 0); // Chimney sweep
    expect(radiusForDays(122)).toBeCloseTo(91.4, 0); // Smoke alarm batteries
  });
});

describe("radiusForDays: threshold crossing and the overdue gravity well", () => {
  it("crosses inside the threshold ring the moment a body becomes overdue", () => {
    expect(isOverdueRadius(radiusForDays(-1))).toBe(true);
    expect(isOverdueRadius(radiusForDays(0))).toBe(false);
    expect(isOverdueRadius(radiusForDays(1))).toBe(false);
  });

  it("matches v19's one overdue body (gutter clearing, T+16d) within a couple of px", () => {
    expect(radiusForDays(-16)).toBeCloseTo(51.98, 0);
  });

  it("pulls harder toward the sun as a body gets more overdue, but never reaches it", () => {
    const near = radiusForDays(-1);
    const mid = radiusForDays(-50);
    const far = radiusForDays(-5000);
    expect(near).toBeLessThan(RING.threshold);
    expect(mid).toBeLessThan(near);
    expect(far).toBeLessThan(mid);
    expect(far).toBeGreaterThan(22); // clearance — asymptotic, never touches the sun
    expect(far).toBeCloseTo(22, 0);
  });
});

describe("bodyRadiusForCostBand: cost-band sizing", () => {
  it("grows monotonically with cost band", () => {
    const sizes = ([1, 2, 3, 4] as const).map((band) => bodyRadiusForCostBand(band, false));
    expect(sizes[0]).toBeLessThan(sizes[1]);
    expect(sizes[1]).toBeLessThan(sizes[2]);
    expect(sizes[2]).toBeLessThan(sizes[3]);
  });

  it("widens a hollow suggestion ring relative to the same cost band filled", () => {
    for (const band of [1, 2, 3, 4] as const) {
      expect(bodyRadiusForCostBand(band, true)).toBeGreaterThan(bodyRadiusForCostBand(band, false));
    }
  });
});

describe("polarPoint", () => {
  it("places 12 o'clock directly above the centre", () => {
    const point = polarPoint(100, 0);
    expect(point.x).toBeCloseTo(DIAL_CENTER, 5);
    expect(point.y).toBeCloseTo(DIAL_CENTER - 100, 5);
  });

  it("places 3 o'clock directly right of the centre", () => {
    const point = polarPoint(100, 90);
    expect(point.x).toBeCloseTo(DIAL_CENTER + 100, 5);
    expect(point.y).toBeCloseTo(DIAL_CENTER, 5);
  });

  it("places 6 o'clock directly below the centre", () => {
    const point = polarPoint(100, 180);
    expect(point.x).toBeCloseTo(DIAL_CENTER, 5);
    expect(point.y).toBeCloseTo(DIAL_CENTER + 100, 5);
  });
});

describe("describeOrbitArc", () => {
  it("produces an SVG arc command referencing the given radius", () => {
    const d = describeOrbitArc(80, 10, 20);
    expect(d).toMatch(/^M .+ A 80 80 0 \d \d .+$/);
  });

  it("picks the large-arc flag for sweeps over 180deg", () => {
    expect(describeOrbitArc(80, 0, 200)).toMatch(/A 80 80 0 1 1/);
    expect(describeOrbitArc(80, 0, 20)).toMatch(/A 80 80 0 0 1/);
  });
});

describe("monthCompassLabels", () => {
  it("starts the compass at the current month and wraps clockwise through the year", () => {
    expect(monthCompassLabels("2026-08-13")).toEqual([
      "AUG", "SEP", "OCT", "NOV", "DEC", "JAN",
      "FEB", "MAR", "APR", "MAY", "JUN", "JUL",
    ]);
  });

  it("wraps December back to January", () => {
    expect(monthCompassLabels("2026-12-01")[1]).toBe("JAN");
  });
});

describe("describeDaysRemaining", () => {
  it("phrases today, future and overdue distinctly", () => {
    expect(describeDaysRemaining(0)).toBe("due today");
    expect(describeDaysRemaining(1)).toBe("due in 1 day");
    expect(describeDaysRemaining(16)).toBe("due in 16 days");
    expect(describeDaysRemaining(-1)).toBe("1 day overdue");
    expect(describeDaysRemaining(-16)).toBe("16 days overdue");
  });
});

describe("computeBodyGeometry", () => {
  it("combines angle, radius and cost sizing into a position inside the viewBox", () => {
    const geometry = computeBodyGeometry(
      { dueDate: "2026-08-29", costBand: 2, type: "service" },
      "2026-08-13",
    );
    expect(geometry.daysRemaining).toBe(16);
    expect(geometry.isOverdue).toBe(false);
    expect(geometry.x).toBeGreaterThan(0);
    expect(geometry.x).toBeLessThan(380);
    expect(geometry.y).toBeGreaterThan(0);
    expect(geometry.y).toBeLessThan(380);
  });

  it("widens the body for suggestion items (CON-3: hollow bodies read larger)", () => {
    const base = { dueDate: "2026-10-02", costBand: 3 as const };
    const suggestion = computeBodyGeometry({ ...base, type: "suggestion" }, "2026-08-13");
    const service = computeBodyGeometry({ ...base, type: "service" }, "2026-08-13");
    expect(suggestion.bodyRadius).toBeGreaterThan(service.bodyRadius);
  });

  it("flags overdue bodies as inside the threshold", () => {
    const geometry = computeBodyGeometry(
      { dueDate: "2026-07-28", costBand: 1, type: "service" },
      "2026-08-13",
    );
    expect(geometry.daysRemaining).toBeLessThan(0);
    expect(geometry.isOverdue).toBe(true);
  });
});
