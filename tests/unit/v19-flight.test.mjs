import { describe, expect, it } from "vitest";

import { homeProps } from "$lib/door/index.js";
import { othersOf, passingHomes } from "$lib/flight/homes.js";
import { LAUNCH_KEY, clearLaunch, consumeLaunch, markLaunch } from "$lib/flight/arrival.js";
import { DAWN_FAR, DAWN_NEAR, DUSK_FAR, DUSK_NEAR } from "$lib/flight/starfields.js";

/*
 * The login/logout flight (#410, §15), ratified verbatim by the owner on
 * 2026-08-16: "Ship these in that exact form."
 *
 * The flight itself (its profiles, its engine, its timeline) is the shared
 * door's since #1371: orbit-site's folder, copied in unchanged and held to
 * its recorded tree hash (scripts/ci/check-door-unchanged.sh), so the numbers
 * the owner ratified cannot move in Orbit without an import that says so, and
 * orbit-site's own tests are the ratchet on them. What stays here is what is
 * Orbit's own: the one-shot launch marker, the seeded skies Orbit's newcomer
 * draws, and which other households pass on the climb.
 */

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

describe("the climb passes the reader's real other households (#1253 ruling 3)", () => {
  const galaxy = {
    mine: { name: "Mine", role: "owner", pos: [0, 0], planets: [[18, 0, 2, "--ok"]] },
    near: { name: "Near", role: "member", pos: [40, 90], planets: [[0, 30, 2, "--warm"], [-18, 0, 2.5, "--ok"]] },
  };
  it("passes everyone but the household in the middle, each planet on its own bearing", () => {
    const others = othersOf(galaxy, "mine");
    expect(others.map((h) => h.name)).toEqual(["Near"]);
    const [[x0, y0, t0, r0], [x1, y1]] = others[0].bodies;
    expect([Math.round(x0), Math.round(y0), t0, r0]).toEqual([0, 80, "--warm", 3.2]);
    expect([Math.round(x1), Math.round(y1)]).toEqual([-22, 0]);
  });
  it("passes nothing for a reader with one household", () => {
    expect(othersOf({ mine: galaxy.mine }, "mine")).toEqual([]);
    expect(passingHomes([])).toEqual([]);
  });
  it("flies them as the folder's homeProps does: one \"home\" prop each, carrying the household's name and bodies", () => {
    const homes = [{ name: "A", bodies: [[1, 2, "#fff", 3.2]] }, { name: "B", bodies: [] }];
    expect(passingHomes(homes)).toEqual(homeProps(homes));
    expect(passingHomes(homes).map(({ kind, name }) => ({ kind, name }))).toEqual([
      { kind: "home", name: "A" },
      { kind: "home", name: "B" },
    ]);
  });
});
