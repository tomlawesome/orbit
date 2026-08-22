import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The belt's arithmetic is plain ESM inside web/, which root vitest excludes
// from COLLECTION (#425: web's own suites are Playwright); importing a module
// from there is fine — only test files are excluded. The placement.js
// precedent: the geometry of a ratified screen is proved here rather than
// discovered in a browser.
import {
  BAND_MARGIN, BERTH_NARROW, BERTH_WIDE, DOC_OFF, J_H, J_PHI, J_RHO, MAX_GAP,
  MIN_GAP, RAD, bedOf, berthFor, bloomTargetsOf, bodiesOf, cardWidthOf, docSpread,
  geometryOf, itemOffsetsOf, lehmer, matchesOf, nearestMatchOf, reachableAt,
  rollRangeOf, seatOf, shortName, stepFrom, warpOf, AMBIENT_SEED,
} from "../../web/src/routes/item/[id]/band.js";
import { beltManifestOf, sizeLabel } from "../../web/src/lib/data/belt.js";
import { DOCUMENTS_FIXTURE, WORKSPACE_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";

const TODAY = WORKSPACE_FIXTURE.fixtureToday; // 2026-08-13, the date every mockup was drawn against
const LAWSON = WORKSPACE_FIXTURE.households[0];

const manifestOf = (options = {}) =>
  beltManifestOf({
    household: LAWSON,
    documentsByItem: DOCUMENTS_FIXTURE,
    today: TODAY,
    ...options,
  });

/* The gate's own frame, which is the frame every number below is pinned to. */
const DESK = geometryOf(1600, 1000);
const MANIFEST = manifestOf();
const BODIES = bodiesOf(MANIFEST, DESK.GAP_SCALE);
const at = (id) => BODIES.findIndex((body) => body.id === id);
const deg = (radians) => Math.round((radians / RAD) * 100) / 100;

/*
 * #458, and the owner's corrections of 2026-08-16: an ITEM belt — the whole
 * manifest laid out in time, all of it in one band, in strict order of when it
 * comes due, jumbled through the band's thickness but never out of order.
 */
describe("the belt's manifest", () => {
  it("is the household's items in date order, sooner first", () => {
    expect(MANIFEST.map((row) => row.id)).toEqual([
      "i-gutter", "i-mot", "i-boiler", "i-chimney", "i-smoke", "i-svc",
    ]);
    // Ascending, strictly: the belt IS this list, and it is never re-sorted.
    const days = MANIFEST.map((row) => row.days);
    expect(days).toEqual([...days].sort((a, b) => a - b));
    expect(days).toEqual([-16, 16, 22, 61, 122, 161]);
  });

  it("says what the rock says, in the manifest's own four tones", () => {
    // chart.js's bands, translated to the card and rim classes — not forked.
    expect(MANIFEST.map((row) => row.urg)).toEqual(["over", "soon", "soon", "up", "ok", "ok"]);
    expect(MANIFEST.map((row) => `${row.t} · ${row.when}`)).toEqual([
      "T+16d · 28 Jul", "T−16d · 29 Aug", "T−22d · 04 Sept",
      "T−61d · 13 Oct", "T−122d · 13 Dec", "T−161d · 21 Jan",
    ]);
  });

  it("reads the real documents, in the words the card shows", () => {
    const mot = MANIFEST.find((row) => row.id === "i-mot");
    expect(mot.docs).toEqual([
      {
        id: "d-mot-cert", name: "MOT certificate 2025", size: "240 KB",
        added: "12 June 2026", type: "PDF (application/pdf)", plate: "PDF",
        clean: true, scan: "clean", href: "/api/documents/d-mot-cert/download",
      },
      {
        id: "d-mot-history", name: "Service history", size: "88 KB",
        added: "12 June 2026", type: "PDF (application/pdf)", plate: "PDF",
        clean: true, scan: "clean", href: "/api/documents/d-mot-history/download",
      },
    ]);
    expect(sizeLabel(2_400_000)).toBe("2.3 MB");
    // A caption is an identifier: the extension survives the elision.
    expect(shortName("service-invoice-2026.pdf")).toBe("service-inv…2026.pdf");
    expect(shortName("Service history")).toBe("Service history");
  });

  it("keeps a retired item's seat only when it is the one being arrived at", () => {
    const retired = {
      ...LAWSON,
      items: [...LAWSON.items, {
        id: "i-old", title: "Gone", sectionId: "s-home", status: "archived",
        subtype: "service", scheduleKind: "service", dueDate: "2026-08-20",
        currency: "GBP", version: 1,
      }],
    };
    expect(manifestOf({ household: retired }).map((r) => r.id)).not.toContain("i-old");
    expect(manifestOf({ household: retired, keepId: "i-old" }).map((r) => r.id)).toContain("i-old");
  });
});

describe("the spacing law", () => {
  it("puts date order into band order and nothing else", () => {
    const items = BODIES.filter((body) => body.kind === "item");
    // date-ascending === band-ascending, the promise in one line
    expect(items.map((body) => body.id)).toEqual(MANIFEST.map((row) => row.id));
    for (let i = 1; i < items.length; i++) {
      expect(items[i].off).toBeGreaterThan(items[i - 1].off);
      expect(items[i].days).toBeGreaterThan(items[i - 1].days);
    }
    expect(itemOffsetsOf(MANIFEST, 1).map(deg)).toEqual([0, 14.55, 26.8, 41.78, 57.73, 72.71]);
  });

  it("breathes with the date gaps between a floor and a ceiling", () => {
    const offsets = itemOffsetsOf(MANIFEST, 1);
    const gaps = offsets.slice(1).map((off, i) => off - offsets[i]);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(MIN_GAP);
      expect(gap).toBeLessThan(MAX_GAP);
    }
    // Six days apart sits noticeably tighter than thirty-nine.
    const [gutterToMot, motToBoiler, boilerToChimney] = gaps;
    expect(motToBoiler).toBeLessThan(gutterToMot);
    expect(motToBoiler).toBeLessThan(boilerToChimney);
    // Same day is the floor exactly; a year is under the ceiling.
    const twins = [{ days: 0 }, { days: 0 }, { days: 365 }];
    const twinGaps = itemOffsetsOf(twins, 1);
    expect(twinGaps[1] - twinGaps[0]).toBeCloseTo(MIN_GAP, 12);
    expect(twinGaps[2] - twinGaps[1]).toBeLessThan(MAX_GAP);
  });

  it("cuts a document's seat out of the gap, never out of the sequence", () => {
    // The papers of the two items that carry them sit either side of them...
    expect(BODIES.map((body) => [body.id, deg(body.off)])).toEqual([
      ["i-gutter", 0],
      ["d-mot-cert", 8.55], ["i-mot", 14.55], ["d-mot-history", 20.55],
      ["i-boiler", 26.8], ["i-chimney", 41.78], ["i-smoke", 57.73],
      ["d-svc-invoice", 66.71], ["i-svc", 72.71], ["d-svc-checklist", 78.71],
    ]);
    // ...and the items' own offsets are the same whether papers exist or not.
    const bare = bodiesOf(manifestOf({ documentsByItem: {} }), DESK.GAP_SCALE);
    expect(bare.map((body) => body.off)).toEqual(
      BODIES.filter((body) => body.kind === "item").map((body) => body.off),
    );
    // Half before, half after, and never wider than two-thirds of the floor.
    expect(docSpread(2, 1).map(deg)).toEqual([-6, 6]);
    expect(docSpread(1, 1).map(deg)).toEqual([-6]);
    expect(DOC_OFF).toBeLessThan(MIN_GAP);
    for (const off of docSpread(6, 1)) {
      expect(Math.abs(off)).toBeLessThanOrEqual(MIN_GAP * 0.66 + 1e-12);
    }
  });
});

describe("the jumble", () => {
  it("throws every body a seeded distance and never reorders them", () => {
    for (const body of BODIES) {
      const soft = body.kind === "doc" ? 0.55 : 1;
      expect(Math.abs(body.jp)).toBeLessThanOrEqual(J_PHI * soft);
      expect(Math.abs(body.jr)).toBeLessThanOrEqual(J_RHO * soft);
      expect(Math.abs(body.jh)).toBeLessThanOrEqual(J_H * soft);
    }
    // The along-band throw cannot close two seats: a tenth of the floor.
    expect(J_PHI * MIN_GAP).toBeLessThan(MIN_GAP / 2);
    // Seeded: the same rock is the same rock, in the same place, every load.
    const again = bodiesOf(MANIFEST, DESK.GAP_SCALE);
    expect(again.map((b) => [b.jp, b.jr, b.jh])).toEqual(BODIES.map((b) => [b.jp, b.jr, b.jh]));
    // ...and it is a throw, not a line: no two bodies share one.
    expect(new Set(BODIES.map((b) => b.jr)).size).toBe(BODIES.length);
  });

  it("eases to exactly zero at the apex, so the card seats on the pin", () => {
    const sel = at("i-mot");
    const seat = seatOf(BODIES, sel, { roll: BODIES[sel].off, berth: BERTH_WIDE, geom: DESK });
    expect(seat.phi).toBe(DESK.PHI_APEX);
    expect(seat.rho).toBe(DESK.A);
    expect(Math.abs(seat.h)).toBe(0);
    const point = DESK.project(seat.phi, seat.rho, seat.h);
    expect(point.x).toBeCloseTo(800, 9);
    expect(point.y).toBeCloseTo(350, 9);
    // A neighbour, by contrast, is thrown off the ring.
    const neighbour = seatOf(BODIES, at("i-boiler"), {
      roll: BODIES[sel].off, berth: BERTH_WIDE, geom: DESK,
    });
    expect(neighbour.rho).not.toBe(DESK.A);
    expect(neighbour.h).not.toBe(0);
  });

  it("warps the berth without ever moving the apex or crossing seats", () => {
    for (const berth of [BERTH_NARROW, BERTH_WIDE]) {
      const warp = warpOf(berth);
      expect(warp(0)).toBe(0);
      let last = -Infinity;
      for (let u = -1; u <= 1.0001; u += 0.01) {
        const value = warp(u);
        expect(value).toBeGreaterThan(last);
        last = value;
      }
      expect(warp(-0.4)).toBeCloseTo(-warp(0.4), 12);
    }
    // The wide berth stands the neighbours further off than the narrow one.
    expect(warpOf(BERTH_WIDE)(MIN_GAP)).toBeGreaterThan(warpOf(BERTH_NARROW)(MIN_GAP));
  });
});

describe("the ring, seen at an angle", () => {
  it("pins the apex to the middle of every sky, at 35% of its height", () => {
    for (const [w, h] of [[1600, 1000], [1280, 800], [1112, 1000], [900, 700], [400, 850]]) {
      const geom = geometryOf(w, h);
      const apex = geom.project(geom.PHI_APEX, geom.A, 0);
      expect(apex.x).toBeCloseTo(w / 2, 9);
      expect(apex.y).toBeCloseTo(Math.round(h * 0.35), 9);
      expect(geom.APEX_Y).toBe(Math.round(h * 0.35));
    }
  });

  it("is not a semicircle: the two flanks fall by different amounts", () => {
    const yAtX = (geom, targetX) => {
      let best = null, bestD = Infinity;
      for (let phi = geom.PHI_R; phi <= geom.PHI_L; phi += 0.0005) {
        const point = geom.project(phi, geom.A, 0);
        if (Math.abs(point.x - targetX) < bestD) { bestD = Math.abs(point.x - targetX); best = point; }
      }
      return best.y - geom.APEX_Y;
    };
    const left = yAtX(DESK, 0), right = yAtX(DESK, 1600);
    expect(left).toBeGreaterThan(right);          // the node roll drops the left flank
    expect(left).toBeCloseTo(281, 0);
    expect(right).toBeCloseTo(228, 0);
    expect(DESK.DIP_L).toBeGreaterThan(DESK.DIP_R);
  });

  it("squeezes the gaps rather than rolling items off a narrow world", () => {
    expect(geometryOf(1600, 1000).GAP_SCALE).toBe(1);
    expect(geometryOf(1280, 800).GAP_SCALE).toBe(1);
    expect(geometryOf(1112, 1000).GAP_SCALE).toBeCloseTo(0.92, 2);
    expect(geometryOf(900, 700).GAP_SCALE).toBeCloseTo(0.64, 2);
    expect(geometryOf(360, 640).GAP_SCALE).toBeGreaterThanOrEqual(0.55);
    // The date law survives the squeeze: every gap scales together, so a
    // cluster is still a cluster.
    const wide = itemOffsetsOf(MANIFEST, 1);
    const tight = itemOffsetsOf(MANIFEST, 0.64);
    const ratios = wide.slice(1).map((off, i) => (tight[i + 1] - tight[i]) / (off - wide[i]));
    for (const ratio of ratios) expect(ratio).toBeCloseTo(0.64, 12);
  });

  it("sizes the card to the berth its own bulk has cleared", () => {
    expect(cardWidthOf(DESK)).toBeCloseTo(410.6, 1);
    expect(cardWidthOf(geometryOf(1280, 800))).toBeCloseTo(392.8, 1);
    // Never below the floor, never above the ceiling, never wider than the sky.
    for (const [w, h] of [[400, 850], [900, 700], [2560, 1440]]) {
      const width = cardWidthOf(geometryOf(w, h));
      expect(width).toBeGreaterThanOrEqual(340 - 1e-9);
      expect(width).toBeLessThanOrEqual(480);
      expect(width).toBeLessThanOrEqual(Math.max(340, w - 56));
    }
  });
});

describe("the ambient bed", () => {
  const { base, reach } = rollRangeOf(BODIES);
  const sow = () => bedOf({ rng: lehmer(AMBIENT_SEED), geom: DESK, bodies: BODIES, base, reach });

  it("is the same bed every time it is sown, and dust before rubble", () => {
    expect(JSON.stringify(sow())).toBe(JSON.stringify(sow()));
    const bed = sow();
    expect(bed.length).toBe(3278);
    // Overwhelmingly dust with a scattering of real rubble: that ratio, not
    // the count, is what makes a belt look like a belt. 2.3px is the size at
    // which a body is given a silhouette at all.
    const sizes = bed.map((rock) => rock.size).sort((a, b) => a - b);
    const dust = bed.filter((rock) => rock.size < 2.3).length;
    expect(dust / bed.length).toBeGreaterThan(0.6);
    expect(sizes[Math.floor(sizes.length / 2)]).toBeLessThan(1.6);
    expect(sizes[sizes.length - 1]).toBeGreaterThan(6);
    expect(bed.every((rock) => rock.size <= 0.42 + 7.6)).toBe(true);
    // Inner bodies run faster than outer ones — Keplerian shear.
    const inner = bed.filter((r) => r.rho < DESK.A), outer = bed.filter((r) => r.rho > DESK.A);
    const mean = (list) => list.reduce((sum, r) => sum + r.rate, 0) / list.length;
    expect(mean(inner)).toBeGreaterThan(mean(outer));
  });

  it("is sown across every skyful the roll can reach, so no roll runs out", () => {
    const bed = sow();
    const window = DESK.PHI_L - DESK.PHI_R + BAND_MARGIN * 2;
    // The ground is over 2.5x the screen's own window...
    expect(reach).toBeGreaterThan(1.3);
    expect(bed.length).toBeGreaterThan((2100 / window) * window);
    // ...and every seat the belt can roll to looks out on a full skyful.
    const seen = (roll) => bed.filter((rock) => {
      const phi = rock.phi + base * rock.rate + (roll - base) * rock.rate;
      return phi >= DESK.PHI_R - BAND_MARGIN && phi <= DESK.PHI_L + BAND_MARGIN;
    }).length;
    for (const body of BODIES) expect(seen(body.off)).toBeGreaterThan(1800);
    expect(Math.abs(seen(BODIES[0].off) - seen(BODIES[BODIES.length - 1].off))).toBeLessThan(200);
  });

  it("thins to a bare belt when the household is empty, and still has one", () => {
    const bed = bedOf({ rng: lehmer(AMBIENT_SEED), geom: DESK, bodies: [], base: 0, reach: 0 });
    expect(bed.length).toBeGreaterThan(700);
    expect(bed.length).toBeLessThan(sow().length);
  });
});

describe("the search box", () => {
  const sel = at("i-mot");
  const bloom = bloomTargetsOf(BODIES, sel, MANIFEST.length);

  it("matches title, section, kind, provider and document name", () => {
    const ids = (query) => [...matchesOf(BODIES, query)].map((i) => BODIES[i].id);
    expect(ids("gutter")).toEqual(["i-gutter"]);                 // title
    expect(ids("vehicles")).toEqual(["i-mot", "i-svc"]);         // section
    expect(ids("inspection")).toEqual(["i-mot"]);                // kind
    expect(ids("british gas")).toEqual(["i-boiler"]);            // provider
    // A document's name lights ITS ITEM — the item is how you get to the paper
    // — and lights the paper too, because it is already out.
    expect(ids("service history")).toEqual(["i-mot", "d-mot-history"]);
    expect(ids("nothing by that name")).toEqual([]);
  });

  it("dims, it does not hide: the belt keeps its shape", () => {
    const found = matchesOf(BODIES, "gutter");
    expect(found.size).toBe(1);
    // Every body is still seated, and the band's order is untouched.
    expect(bodiesOf(MANIFEST, DESK.GAP_SCALE).map((b) => b.off)).toEqual(BODIES.map((b) => b.off));
    expect(BODIES.length).toBe(10);
  });

  it("centres the nearest hit ALONG THE BELT, not the first in the list", () => {
    // Both ends match "e"; the one nearer in time to the MOT must win.
    const twoWays = new Set([at("i-boiler"), at("i-gutter")]);
    expect(nearestMatchOf(BODIES, twoWays, sel, bloom)).toBe(at("i-boiler"));
    // A paper still folded inside its item is not somewhere you can be sent.
    expect(reachableAt(BODIES, at("d-svc-invoice"), bloom)).toBe(false);
    expect(reachableAt(BODIES, at("d-mot-cert"), bloom)).toBe(true);
    expect(nearestMatchOf(BODIES, new Set([at("d-svc-invoice")]), sel, bloom)).toBe(-1);
    // Never the body already at the apex.
    expect(nearestMatchOf(BODIES, new Set([sel]), sel, bloom)).toBe(-1);
  });
});

describe("stepping and arriving", () => {
  const sel = at("i-mot");
  const bloom = bloomTargetsOf(BODIES, sel, MANIFEST.length);

  it("steps in date order, over the papers that are out", () => {
    expect(BODIES[stepFrom(BODIES, sel, bloom, -1)].id).toBe("d-mot-cert");
    expect(BODIES[stepFrom(BODIES, sel, bloom, 1)].id).toBe("d-mot-history");
    // The far end's papers are folded away, so the step passes over them.
    expect(BODIES[stepFrom(BODIES, at("i-smoke"), bloom, 1)].id).toBe("i-svc");
    // And the ends of the belt are ends: there is nowhere further to go.
    expect(stepFrom(BODIES, 0, bloom, -1)).toBe(-1);
    expect(stepFrom(BODIES, at("i-svc"), bloom, 1)).toBe(-1);
  });

  it("lands a deep arrival on its item, papers out, berth wide", () => {
    // /item/i-mot: the seat list is built, the roll is that seat's own offset,
    // and the card is on the pin — which is the whole of "arriving at an item
    // from anywhere lands you HERE with it centred".
    expect(sel).toBeGreaterThan(-1);
    const roll = BODIES[sel].off;
    expect(roll).toBe(itemOffsetsOf(MANIFEST, DESK.GAP_SCALE)[1]);
    expect(bloom).toEqual([0, 1, 0, 0, 0, 0]);
    expect(berthFor(BODIES, sel, MANIFEST.length)).toBe(BERTH_WIDE);
    const seat = seatOf(BODIES, sel, { roll, berth: BERTH_WIDE, geom: DESK });
    expect(DESK.project(seat.phi, seat.rho, seat.h).x).toBeCloseTo(800, 9);

    // Arriving at an item with no papers opens none, and keeps the narrow berth.
    const plain = at("i-boiler");
    expect(bloomTargetsOf(BODIES, plain, MANIFEST.length)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(berthFor(BODIES, plain, MANIFEST.length)).toBe(BERTH_NARROW);

    // Arriving at a DOCUMENT opens its own item's papers, so the way back is
    // the ringed body one step away.
    const paper = at("d-svc-checklist");
    expect(bloomTargetsOf(BODIES, paper, MANIFEST.length)).toEqual([0, 0, 0, 0, 0, 1]);
    expect(berthFor(BODIES, paper, MANIFEST.length)).toBe(BERTH_WIDE);
  });
});

describe("the belt reads no clock and rolls no dice", () => {
  it("has no Math.random, Date.now or bare new Date in anything the gate sees", () => {
    const sources = [
      "web/src/routes/item/[id]/band.js",
      "web/src/routes/item/[id]/belt.behaviour.js",
      "web/src/lib/data/belt.js",
    ];
    for (const path of sources) {
      const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
      /* Calls, not the words: these modules TALK about not reading a clock. */
      expect(source, path).not.toMatch(/Math\.random\s*\(/);
      expect(source, path).not.toMatch(/Date\.now\s*\(/);
      expect(source, path).not.toMatch(/new Date\(\s*\)/);
    }
  });
});
