import { describe, expect, it, vi } from "vitest";

import {
  BLOOM_T0, BLOOM_DUR, DOWN, DOWNDUR, PROPS_DOWN, PROPS_UP, REV, SWEEP, UP, UPDUR,
  bloomAt, hexa, mirror,
} from "$lib/flight/engine.js";
import {
  D, T, ascentBeats, ascentBeatsReduced, descentBeats, descentBeatsReduced, runTimeline,
} from "$lib/flight/timeline.js";
import { LAUNCH_KEY, clearLaunch, consumeLaunch, markLaunch } from "$lib/flight/arrival.js";
import { DAWN_FAR, DAWN_NEAR, DUSK_FAR, DUSK_NEAR } from "$lib/flight/starfields.js";

/*
 * The login/logout flight (#410, §15), ported from design/v19/first-run.html
 * as committed at 159ec9f and ratified verbatim by the owner on 2026-08-16:
 * "Ship these in that exact form." These tests are the ratchet on "exact":
 * every number below is read off the mockup, so a later edit that quietly
 * retimes the climb, flattens a curve or un-mirrors the descent fails here
 * rather than being noticed by nobody.
 */

describe("the flight's profiles are the ratified ones", () => {
  it("keeps the mockup's two durations", () => {
    expect(UPDUR).toBe(4800);
    expect(DOWNDUR).toBe(4100);
    expect(REV).toBeCloseTo(4100 / 4800, 12);
  });

  it("climbs through ignition, hard acceleration, cruise and deceleration", () => {
    /* 0–300 ignition: barely moving */
    expect(UP.speed(0)).toBeCloseTo(0.02, 12);
    expect(UP.speed(299)).toBeLessThan(0.12);
    /* 300–1350 hard acceleration, ending at cruise */
    expect(UP.speed(300)).toBeCloseTo(0.12, 12);
    expect(UP.speed(1349)).toBeGreaterThan(0.99);
    /* 1350–2600 cruise */
    expect(UP.speed(1350)).toBe(1);
    expect(UP.speed(2599)).toBe(1);
    /* 2600–3500 deceleration onto the household's coordinates, then stopped */
    expect(UP.speed(2600)).toBe(1);
    expect(UP.speed(3499)).toBeLessThan(0.01);
    expect(UP.speed(3500)).toBe(0);
    expect(UP.speed(UPDUR)).toBe(0);
  });

  it("never goes backwards on the way up", () => {
    let last = -1;
    for (let t = 0; t <= 2600; t += 25) {
      const v = UP.speed(t);
      expect(v).toBeGreaterThanOrEqual(last - 1e-12);
      last = v;
    }
  });

  it("clears the dawn on the atmosphere curve, and only then", () => {
    expect(UP.atm(0)).toBe(0);
    expect(UP.atm(240)).toBe(0);
    expect(UP.atm(1690)).toBe(1);
    expect(UP.atm(4800)).toBe(1);
    expect(UP.atm(900)).toBeGreaterThan(0);
    expect(UP.atm(900)).toBeLessThan(1);
  });
});

describe("the descent is the climb played backwards, not a second animation", () => {
  it("maps descent time onto ascent time end for end", () => {
    expect(mirror(0)).toBe(UPDUR);
    expect(mirror(DOWNDUR)).toBe(0);
    expect(mirror(DOWNDUR / 2)).toBeCloseTo(UPDUR / 2, 10);
    /* clamped at both ends, so an overrun frame cannot read off the curve */
    expect(mirror(-500)).toBe(UPDUR);
    expect(mirror(DOWNDUR + 500)).toBe(0);
  });

  it("reads speed off the ascent through the mirror, negated", () => {
    for (const t of [0, 400, 1200, 2050, 3300, 4100]) {
      expect(DOWN.speed(t)).toBeCloseTo(-UP.speed(mirror(t)), 12);
    }
    /* negative speed is the whole trick: the field contracts on the way down */
    expect(DOWN.speed(DOWNDUR / 2)).toBeLessThan(0);
  });

  it("reads the atmosphere off the ascent too, so the limb rises back", () => {
    expect(DOWN.atm(0)).toBe(UP.atm(UPDUR));
    expect(DOWN.atm(DOWNDUR)).toBe(UP.atm(0));
  });

  it("cools the returning dawn into dusk over the last third", () => {
    expect(DOWN.duskMix(0)).toBe(0);
    expect(DOWN.duskMix(DOWNDUR * 0.64)).toBeCloseTo(0, 10);
    expect(DOWN.duskMix(DOWNDUR)).toBe(1);
    expect(DOWN.pal.hasSun).toBe(true);
    expect(DOWN.palTo.hasSun).toBe(false);
  });

  it("meets the same traffic in the opposite order, turning the other way", () => {
    expect(PROPS_DOWN).toHaveLength(PROPS_UP.length);
    for (let i = 0; i < PROPS_UP.length; i++) {
      const up = PROPS_UP[i], down = PROPS_DOWN[i];
      expect(down.kind).toBe(up.kind);
      expect(down.ang).toBe(up.ang);          /* bearings are sacred */
      expect(down.z).toBe(up.z);
      expect(down.spin).toBe(-up.spin);
      expect(down.dur).toBeCloseTo(up.dur * REV * SWEEP, 10);
      expect(down.t0).toBeCloseTo(Math.max(0, (UPDUR - (up.t0 + up.dur)) * REV), 10);
    }
    /* SWEEP exists so the sky is empty by the time the limb comes back up */
    for (const down of PROPS_DOWN) expect(down.t0 + down.dur).toBeLessThanOrEqual(DOWNDUR);
  });
});

describe("the reveal is the slow one the owner asked for", () => {
  it("runs 3200 → 4500 and then holds, so the handoff is in full light", () => {
    expect(BLOOM_T0).toBe(3200);
    expect(BLOOM_DUR).toBe(1300);
    expect(bloomAt(3199)).toBe(0);
    expect(bloomAt(3200)).toBe(0);
    expect(bloomAt(3850)).toBeCloseTo(0.5, 10);
    expect(bloomAt(4500)).toBe(1);
    expect(bloomAt(UPDUR)).toBe(1);          /* still full at the handoff */
  });

  it("is one function, read forwards by the climb and backwards by the descent", () => {
    /* the descent opens at full bloom and contracts to nothing */
    expect(bloomAt(mirror(0))).toBe(1);
    expect(bloomAt(mirror(DOWNDUR))).toBe(0);
    const early = bloomAt(mirror(400));
    const later = bloomAt(mirror(1400));
    expect(early).toBeGreaterThan(later);
  });

  it("writes colours the canvas can take", () => {
    expect(hexa("#d8b45a", 0.5)).toBe("rgba(216,180,90,0.5)");
    expect(hexa("#ffffff", 0)).toBe("rgba(255,255,255,0)");
  });
});

describe("the wall clock", () => {
  it("is the mockup's own", () => {
    expect(T.warp).toBe(200);
    expect(T.mark).toBe(260);
    expect(T.release).toBe(430);
    expect(T.markOut).toBe(1340);
    expect(T.nameOn).toBe(1560);
    expect(T.nameOff).toBe(2600);
    expect(T.land).toBe(4800);
    expect(T.condensed).toBe(6400);
    /* The owner's 2026-08-16 amendment (ledger 7f7d813): the dwell is 1s too
       long and the dial's draw-in slightly too fast — "a DELIBERATE WAIT, not
       a slow load". Everything either side of it is still the sheet's own. */
    expect(T.dwell).toBe(2000);
    expect(T.instrument).toBe(1700);
    /* the dwell comes BEFORE the instrument (§15 second pass, ruling 3) */
    expect(T.instrumentAt).toBe(8400);
    expect(T.instrumentAt - T.condensed).toBe(T.dwell);
  });

  it("mirrors the name's window on the way down", () => {
    expect(D.warp).toBe(700);
    expect(D.nameOn - D.warp).toBe(1880);
    expect(D.nameOff - D.warp).toBe(2767);
    expect(D.farewell).toBe(5350);
    /* the instrument leaves first, because it arrived last */
    expect(D.withdraw).toBeLessThan(D.disperse);
    expect(D.disperse).toBeLessThan(D.warp);
  });

  it("orders every beat", () => {
    for (const beats of [ascentBeats(), descentBeats()]) {
      const times = beats.map((beat) => beat.at);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
  });
});

describe("running the timeline", () => {
  it("pins to a beat: everything up to that millisecond, in order, and no timers", () => {
    const seen = [];
    const schedule = vi.fn();
    const cancel = runTimeline(ascentBeats(), (act) => seen.push(act), { at: 2000, schedule });
    expect(seen).toEqual(["arming", "warp", "mark", "release", "markOut", "nameOn"]);
    expect(schedule).not.toHaveBeenCalled();
    expect(cancel()).toBeUndefined();
  });

  it("pinned at zero still arms, and pinned past the end plays the lot", () => {
    const first = [];
    runTimeline(ascentBeats(), (act) => first.push(act), { at: 0 });
    expect(first).toEqual(["arming"]);
    const all = [];
    runTimeline(ascentBeats(), (act) => all.push(act), { at: 99_000 });
    expect(all).toHaveLength(ascentBeats().length);
    expect(all.at(-1)).toBe("instrument");
  });

  it("live: one timer per beat, at the beat's own millisecond, all cancellable", () => {
    const delays = [];
    let nextId = 0;
    const cleared = [];
    const cancel = runTimeline(
      descentBeats(),
      () => {},
      {
        schedule: (fn, ms) => { delays.push(ms); return ++nextId; },
        cancel: (id) => cleared.push(id),
      },
    );
    expect(delays).toEqual(descentBeats().map((beat) => beat.at));
    cancel();
    expect(cleared).toHaveLength(descentBeats().length);
  });

  it("reduced motion keeps the staging and drops only the movement", () => {
    const up = ascentBeatsReduced().map((beat) => beat.act);
    /* the sky still lands bare, the three seconds still pass, the instrument
       still arrives after them — and nothing ever asks the canvas to run */
    expect(up).toEqual(["land", "instrument"]);
    expect(ascentBeatsReduced()[1].at).toBe(700 + T.dwell);   /* 2700 */
    expect(up).not.toContain("warp");
    const down = descentBeatsReduced().map((beat) => beat.act);
    /* `disperse` takes the landing off the screen — without it the dusk
       arrives on top of a home that is still there. */
    expect(down).toEqual(["withdraw", "disperse", "dusk", "farewell"]);
    expect(down).not.toContain("warp");
  });
});

describe("did this reader just sign in?", () => {
  const fakeStorage = () => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
      size: () => map.size,
    };
  };

  it("fires exactly once per departure", () => {
    const storage = fakeStorage();
    expect(consumeLaunch(storage)).toBe(false);        /* nobody departed */
    expect(markLaunch(storage)).toBe(true);
    expect(storage.getItem(LAUNCH_KEY)).toBe("departed");
    expect(consumeLaunch(storage)).toBe(true);         /* the arrival flies */
    expect(consumeLaunch(storage)).toBe(false);        /* a refresh does not */
    expect(consumeLaunch(storage)).toBe(false);        /* nor does Back */
    expect(storage.size()).toBe(0);
  });

  it("forgets an abandoned sign-in rather than firing later", () => {
    const storage = fakeStorage();
    markLaunch(storage);
    clearLaunch(storage);
    expect(consumeLaunch(storage)).toBe(false);
  });

  it("treats a storage that refuses as no marker at all, never as an error", () => {
    const hostile = {
      getItem() { throw new Error("denied"); },
      setItem() { throw new Error("denied"); },
      removeItem() { throw new Error("denied"); },
    };
    expect(markLaunch(hostile)).toBe(false);
    expect(consumeLaunch(hostile)).toBe(false);
    expect(() => clearLaunch(hostile)).not.toThrow();
  });
});

describe("the flight's skies are seeded, never rolled", () => {
  it("draws the mockup's own field from one stream, in the mockup's order", () => {
    expect(DAWN_FAR).toHaveLength(100);
    expect(DAWN_NEAR).toHaveLength(44);
    expect(DUSK_FAR).toHaveLength(100);
    expect(DUSK_NEAR).toHaveLength(48);
    /* the first star of the sign-in's sky, as design/v19/first-run.html's own
       generator produces it from seed 17170812 */
    expect(DAWN_FAR[0]).toEqual({ cx: "1543.1", cy: "198.1", r: "0.67", opacity: "0.25", delay: "2.1" });
    expect(DAWN_NEAR[0]).toEqual({ cx: "289.2", cy: "798.8", r: "1.25", opacity: "0.35", delay: null });
  });

  it("twinkles every sixth far star and no near ones", () => {
    for (const [index, star] of DAWN_FAR.entries()) {
      expect(Boolean(star.delay)).toBe(index % 6 === 0);
    }
    for (const star of DAWN_NEAR) expect(star.delay).toBeNull();
  });
});
