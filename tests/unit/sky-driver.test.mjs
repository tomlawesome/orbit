import { describe, expect, it } from "vitest";

import { dialBodiesOf, dialPlacement, drivingDays } from "../../web/src/lib/data/chart.js";
import { namedPlanets, skyLabelsOf } from "../../web/src/lib/data/sky-labels.js";

/*
 * #1462: planets sit by the due date or by the user's warning date, a per-user
 * setting `skyDriver` ("due" | "warning", default "due").
 *
 * Names this file fixes for the build:
 *   drivingDays(item, { skyDriver, firstWarningDays }) -> number
 *     (web/src/lib/data/chart.js). `item` is { days, reminderDays? }: `days` is
 *     the days until due (a dial body will do), `reminderDays` the item's own
 *     reminder days (reminder_rules.days_before, the field home items carry).
 *     "due": days. "warning": days minus the warning offset, which is the
 *     largest of the item's own reminderDays where it has any, else
 *     firstWarningDays, else 0. The result may be negative.
 *   dialBodiesOf(household, { suggestions, today, skyDriver, firstWarningDays })
 *     places each item's `placement` and `pocketPlacement` by its driving days.
 *     Every body carries `drivingDays` (equal to `days` under "due"); `days`,
 *     `dueDate`, band/paint, `overdue`, `trail`, `closest` and the sort order
 *     stay those of the real due date.
 *   The name rule (namedPlanets, skyLabelsOf, sky-labels.js) reads
 *     `drivingDays` when a planet/body carries it, else `days`.
 */
const TODAY = "2026-08-13";

describe("drivingDays", () => {
  it("returns the days until due for \"due\", whatever else is known", () => {
    expect(drivingDays({ days: 22, reminderDays: [14] }, { skyDriver: "due", firstWarningDays: 30 })).toBe(22);
    expect(drivingDays({ days: -4 }, { skyDriver: "due", firstWarningDays: 30 })).toBe(-4);
  });

  it("subtracts firstWarningDays for \"warning\" when the item has no rule of its own", () => {
    expect(drivingDays({ days: 40 }, { skyDriver: "warning", firstWarningDays: 14 })).toBe(26);
    expect(drivingDays({ days: 40, reminderDays: [] }, { skyDriver: "warning", firstWarningDays: 14 })).toBe(26);
    expect(drivingDays({ days: 40, reminderDays: null }, { skyDriver: "warning", firstWarningDays: 14 })).toBe(26);
  });

  it("subtracts the largest of the item's own reminder days: [7, 21] takes 21", () => {
    expect(drivingDays({ days: 40, reminderDays: [7, 21] }, { skyDriver: "warning", firstWarningDays: 14 })).toBe(19);
    expect(drivingDays({ days: 40, reminderDays: [21, 7] }, { skyDriver: "warning", firstWarningDays: 3 })).toBe(19);
  });

  it("subtracts 0 when neither the item's rule nor the first-warning days are known", () => {
    expect(drivingDays({ days: 40 }, { skyDriver: "warning", firstWarningDays: null })).toBe(40);
    expect(drivingDays({ days: 40 }, { skyDriver: "warning" })).toBe(40);
    expect(drivingDays({ days: 40, reminderDays: [] }, { skyDriver: "warning", firstWarningDays: undefined })).toBe(40);
  });

  it("can come out negative: the warning date has passed", () => {
    expect(drivingDays({ days: 16, reminderDays: [21, 7] }, { skyDriver: "warning", firstWarningDays: 14 })).toBe(-5);
    expect(drivingDays({ days: -16, reminderDays: [21] }, { skyDriver: "warning", firstWarningDays: 14 })).toBe(-37);
  });
});

const item = (id, dueDate, extra = {}) => ({
  id, title: id, sectionId: "s-home", status: "active", subtype: "service", scheduleKind: "service",
  dueDate, costMinor: 15000, currency: "GBP", recurrenceMonths: 12, ...extra,
});
const household = (...items) => ({ id: "hh-test", sections: [{ id: "s-home", name: "Home" }], items });
const WARNING = { today: TODAY, skyDriver: "warning", firstWarningDays: 14 };

describe("dialBodiesOf by the driving date", () => {
  it("places a lone item at dialPlacement(days - offset), desk and pocket, its own rule over the first-warning days", () => {
    // due 2026-08-29 = 16 days; own reminder days [21, 7]: driving -5, past its warning date
    const [body] = dialBodiesOf(household(item("mot", "2026-08-29", { reminderDays: [21, 7] })), WARNING);
    expect(body.days).toBe(16);
    expect(body.drivingDays).toBe(-5);
    expect(body.placement).toEqual(dialPlacement(-5));
    expect(body.pocketPlacement).toEqual(dialPlacement(-5));
    expect(body.placement.radius).toBeLessThan(62); // the overdue side of the sun
  });

  it("uses the first-warning days for an item with no rule of its own", () => {
    const [body] = dialBodiesOf(household(item("boiler", "2026-09-04")), WARNING); // 22 days
    expect(body.drivingDays).toBe(8);
    expect(body.placement).toEqual(dialPlacement(8));
    expect(body.pocketPlacement).toEqual(dialPlacement(8));
  });

  it("sits nearer the sun by the warning date than by the due date", () => {
    const hh = household(item("boiler", "2026-09-04"));
    const [due] = dialBodiesOf(hh, { today: TODAY, skyDriver: "due", firstWarningDays: 14 });
    const [warning] = dialBodiesOf(hh, WARNING);
    expect(due.placement).toEqual(dialPlacement(22));
    expect(warning.placement.radius).toBeLessThan(due.placement.radius);
    expect(warning.pocketPlacement.radius).toBeLessThan(due.pocketPlacement.radius);
  });

  it("changes nothing under \"due\", and nothing when the driver is left out", () => {
    const hh = household(item("boiler", "2026-09-04", { reminderDays: [14] }), item("gutter", "2026-07-28"));
    const plain = dialBodiesOf(hh, { today: TODAY });
    const due = dialBodiesOf(hh, { today: TODAY, skyDriver: "due", firstWarningDays: 14 });
    expect(due).toEqual(plain);
    for (const b of plain) expect(b.drivingDays).toBe(b.days);
  });

  it("leaves every date, band, mark and sort order on the real due date", () => {
    const hh = household(
      item("a-overdue", "2026-07-28"),
      item("b-mot", "2026-08-29", { reminderDays: [21, 7] }),
      item("c-boiler", "2026-09-04", { reminderDays: [14] }),
      item("d-far", "2027-01-21"),
    );
    const strip = ({ placement, pocketPlacement, ...rest }) => rest;
    const due = dialBodiesOf(hh, { today: TODAY, skyDriver: "due", firstWarningDays: 14 });
    const warning = dialBodiesOf(hh, WARNING);
    expect(warning.map((b) => b.id)).toEqual(due.map((b) => b.id));
    expect(warning.map(strip).map(({ drivingDays, ...rest }) => rest)).toEqual(due.map(strip).map(({ drivingDays, ...rest }) => rest));
    const mot = warning.find((b) => b.id === "b-mot");
    expect(mot.placement).toEqual(dialPlacement(-5)); // it did move
    expect(mot.dueDate).toBe("2026-08-29");
    expect(mot.days).toBe(16);
    expect(mot.overdue).toBe(false); // its warning date has passed, it is not overdue
    expect(mot.closest).toBe(true);
  });

  it("puts every item's radius at its driving days, seating or not, on both dials", () => {
    const hh = household(
      item("a", "2026-07-28"), item("b", "2026-08-29", { reminderDays: [21, 7] }),
      item("c", "2026-09-04", { reminderDays: [7, 14] }), item("d", "2027-01-21"),
    );
    const bodies = dialBodiesOf(hh, WARNING);
    const expected = { a: -16 - 14, b: 16 - 21, c: 22 - 14, d: 161 - 14 };
    for (const b of bodies) {
      expect(b.drivingDays, b.id).toBe(expected[b.id]);
      expect(b.placement.radius, b.id).toBe(dialPlacement(expected[b.id]).radius);
      expect(b.pocketPlacement.radius, b.id).toBe(dialPlacement(expected[b.id]).radius);
    }
  });
});

describe("the name rule by the driving date", () => {
  const planet = (id, days, drivingDays) => ({ id, title: id, days, ...(drivingDays === undefined ? {} : { drivingDays }) });

  it("namedPlanets reads drivingDays when a planet has it, else days", () => {
    const planets = [planet("late-warning", 40, 26), planet("far", 40, 40), planet("plain", 20), planet("passed", 16, -5)];
    expect(namedPlanets(planets, 30).map((p) => p.id).sort()).toEqual(["late-warning", "passed", "plain"]);
    expect(namedPlanets(planets, 1).map((p) => p.id)).toEqual(["passed"]);
    expect(namedPlanets(planets, 0)).toEqual([]);
    expect(namedPlanets(planets, 365)).toHaveLength(4);
  });

  const measure = (text, px) => text.length * px * 0.5;
  const named = (hh, options, labelDays) => {
    const bodies = dialBodiesOf(hh, { today: TODAY, ...options });
    const { labels } = skyLabelsOf(
      bodies.map((b) => ({ id: b.id, title: b.title, days: b.days, drivingDays: b.drivingDays, place: b.pocketPlacement, radius: b.pocketSize })),
      { scene: "pocket", labelDays, name: "Harlow Home", measure },
    );
    return labels.map((l) => l.id).sort();
  };

  it("skyLabelsOf names a planet whose warning date is within N days though its due date is not", () => {
    const hh = household(item("later", "2026-09-22")); // 40 days, no rule: driving 26 with 14 first-warning days
    expect(named(hh, { skyDriver: "due", firstWarningDays: 14 }, 30)).toEqual([]);
    expect(named(hh, { skyDriver: "warning", firstWarningDays: 14 }, 30)).toEqual(["later"]);
  });

  it("skyLabelsOf names a planet whose warning date has passed at N = 1, and not one whose date is just far", () => {
    const hh = household(item("mot", "2026-08-29", { reminderDays: [21] }), item("far", "2027-01-21"));
    expect(named(hh, { skyDriver: "due", firstWarningDays: 14 }, 1)).toEqual([]);
    expect(named(hh, { skyDriver: "warning", firstWarningDays: 14 }, 1)).toEqual(["mot"]);
  });
});
