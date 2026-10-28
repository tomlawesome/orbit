import { expect, test } from "@playwright/test";
import { APP, DOOR_STATES } from "./pocket-states.js";

/*
 * THE DOOR'S STATION AND THE WELL'S FIT ON A PHONE (#1127, #1120 step c;
 * design/v19/phone-vision/review-round.md §2.7, §2.8).
 *
 * The owner, on a real phone: the door's ring sat too high. It now stands at
 * the upper-middle, measured as its centre's share of the visible height:
 * 40% on the invite's outcome and other status pages, 30% where a card
 * stands under it. Over a card the ring is 240px under 760px of visible
 * height and 302.4px from there up.
 *
 * The bare door, the held dawn and the goodbye are orbit-site's lockup since
 * #1253, so they no longer have a share: the glyph is --R wide (68vw, 420px
 * and 46svh at most) with the ring .72R across inside it, and the lockup is
 * centred in the height less twice the lift (2svh), so it stands a little
 * above the middle. That is what they are measured against.
 *
 * The 404's well is fitted by its own box (the two 4s, x 440-1160 in scene
 * units, and the glow, y 130-770) rather than the whole 1600x1000 scene, so
 * at 390 the 4s span ~339px and at 360 ~318px, and the glow still ends above
 * the heading.
 *
 * Measured at the real floors (390x664, 360x640: the browser's bars take the
 * rest) and at a tall phone (390x844), with reduced motion so nothing is
 * mid-transition.
 */

const SIZES = [
  { width: 390, height: 664 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
];

/** The site's lockup on a phone (flight.css): the glyph's width and the lift, from the visible height. */
const lockupMeasure = (/** @type {number} */ width, /** @type {number} */ visible) => ({
  R: Math.min(420, 0.68 * width, 0.46 * visible),
  lift: 0.02 * visible,
});

/** How near the measured centre must be to its station, in px. */
const TOLERANCE = 2;

/**
 * Each state names what draws its ring and where the ring's centre belongs.
 * `lockup` names the box the site centres, for the states that stand as its lockup.
 * @type {{ slug: string, state: string, ring: string, share?: number, lockup?: string, card?: boolean }[]}
 */
const STATIONS = [
  { slug: "door", state: "rest", ring: "#dawn .glyph svg", lockup: "#dawn .lockup" },
  { slug: "login", state: "starting", ring: "#dawn .glyph svg", lockup: "#dawn .lockup" },
  { slug: "logout", state: "rest", ring: "#dusk .glyph svg", lockup: "#dusk .lockup" },
  { slug: "invite", state: "used", ring: ".invite-card .invite-ring", share: 0.4 },
  { slug: "login", state: "local-card", ring: ".ringcard .bigring", share: 0.3, card: true },
  { slug: "login", state: "first-administrator", ring: ".ringcard .bigring", share: 0.3, card: true },
  { slug: "setup", state: "rest", ring: ".ringcard .bigring", share: 0.3, card: true },
  { slug: "approve", state: "open", ring: ".ringcard .bigring", share: 0.3, card: true },
];

for (const size of SIZES) {
  test.describe(`the door's station at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size, hasTouch: true, isMobile: true, reducedMotion: "reduce" });

    for (const station of STATIONS) {
      const door = DOOR_STATES.find((s) => s.slug === station.slug && s.state === station.state);
      if (!door) throw new Error(`no door state ${station.slug} · ${station.state} in pocket-states.js`);

      test(station.lockup
        ? `${door.name}: the ring .72R across, the lockup centred in the height less the lift`
        : `${door.name}: the ring's centre at ${(station.share ?? 0) * 100}% of the visible height`, async ({ page }) => {
        await door.reach(page);
        await page.evaluate(() => document.fonts.ready);
        /* reduced motion still crossfades the card in over .7s (ringcard.css):
           read the ring once every finite animation has finished and its box
           has held still for two frames running -- an end state, not a delay */
        await page.waitForFunction((selector) => {
          const finished = document.getAnimations()
            .filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
            .every((a) => a.playState === "finished");
          const ring = document.querySelector(selector);
          const w = /** @type {Window & { __stationBox?: string }} */ (window);
          if (!finished || !ring) { w.__stationBox = undefined; return false; }
          const r = ring.getBoundingClientRect();
          const box = `${r.x},${r.y},${r.width},${r.height}`;
          const held = w.__stationBox === box;
          w.__stationBox = box;
          return held;
        }, station.ring, { timeout: 20_000 });

        const rect = await page.locator(station.ring).first().boundingBox();
        expect(rect, `${station.ring} has no box`).toBeTruthy();
        const r = /** @type {{x:number,y:number,width:number,height:number}} */ (rect);
        const visible = await page.evaluate(() => window.innerHeight);
        const centre = r.y + r.height / 2;
        console.log(`${size.width}x${size.height} ${door.name}: ring centre ${centre.toFixed(1)}px = ${(centre / visible * 100).toFixed(1)}% of ${visible}, ${r.width.toFixed(1)}px across`);

        if (station.lockup) {
          const { R, lift } = lockupMeasure(size.width, visible);
          expect(r.width, "the glyph is --R wide").toBeCloseTo(R, 0);
          const box = await page.locator(station.lockup).first().boundingBox();
          expect(box, `${station.lockup} has no box`).toBeTruthy();
          const l = /** @type {{y:number,height:number}} */ (box);
          const want = (visible - 2 * lift) / 2;
          console.log(`${size.width}x${size.height} ${door.name}: R ${R.toFixed(1)}, lockup centre ${(l.y + l.height / 2).toFixed(1)}px, wanted ${want.toFixed(1)}px`);
          expect(Math.abs(l.y + l.height / 2 - want), `lockup centre ${(l.y + l.height / 2).toFixed(1)}px, wanted ${want.toFixed(1)}px`)
            .toBeLessThanOrEqual(TOLERANCE);
        } else {
          const share = /** @type {number} */ (station.share);
          expect(Math.abs(centre - share * visible), `centre ${centre.toFixed(1)}px, wanted ${(share * visible).toFixed(1)}px`)
            .toBeLessThanOrEqual(TOLERANCE);
        }
        if (station.card) {
          expect(r.width, "the ring over a card").toBeCloseTo(visible < 760 ? 240 : 302.4, 0);
        }
        /* §5.1: the goodbye's second line and its pill are one column under
           the ring -- the pill at least 24px under the line, and clear of the
           ember rim (the limb burns at 92% of the frame). */
        if (station.slug === "logout") {
          const sub = await page.locator("#dusk .farewell .sub").boundingBox();
          const gate = await page.locator("#dusk .gate-wrap a").boundingBox();
          expect(sub && gate, "the farewell's line or the pill has no box").toBeTruthy();
          const s = /** @type {{y:number,height:number}} */ (sub);
          const g = /** @type {{y:number,height:number}} */ (gate);
          console.log(`${size.width}x${size.height} /logout: line ${s.y.toFixed(1)}-${(s.y + s.height).toFixed(1)}px, pill ${g.y.toFixed(1)}-${(g.y + g.height).toFixed(1)}px`);
          expect(g.y, "the pill is under the line by 24px").toBeGreaterThanOrEqual(s.y + s.height + 24 - 0.5);
          expect(g.y + g.height, "the pill is above 92% of the height").toBeLessThanOrEqual(0.92 * visible);
        }
      });
    }
  });
}

/*
 * §5.4: the ring travels between the stations rather than jumping. On the
 * door with `local login`, opening the card starts the column's ring at the
 * bare door's station (40%, 302.4px) and carries it over .5s to the card's
 * (30%, 240px at 664). With reduced motion it simply stands at the card's.
 */
for (const motion of /** @type {const} */ (["no-preference", "reduce"])) {
  test.describe(`the ring's hand-over to a card at 390x664, motion ${motion}`, () => {
    test.use({ viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true, reducedMotion: motion });

    /* The hand-over is a CSS transition (door-phone.css: margin-top, width and
       height over .5s, started from @starting-style). This used to sample the
       ring on every animation frame and bound the jump between frames, which
       measured how fast a loaded runner paints rather than the hand-over
       (#1306, #1447, agent-infra#30). What that
       guarded is a ring that teleports to the card's station instead of
       travelling, and that is a fact about the transition, not about frames:
       the ring's own transitions are paused the moment the card creates it,
       then stepped by hand to fixed points in their .5s, and the ring is
       measured at each. No frame rate or wall-clock time is involved. */
    test(motion === "reduce" ? "the ring stands at the card's station at once" : "the ring travels from the door's station to the card's", async ({ page }) => {
      const door = DOOR_STATES.find((s) => s.slug === "login" && s.state === "mixed");
      if (!door) throw new Error("no door state login · mixed in pocket-states.js");
      await door.reach(page);
      await page.locator("#localopen").waitFor();
      await page.evaluate(() => document.fonts.ready);

      if (motion === "reduce") {
        /* sampled in the page, frame by frame, from the tap that opens the card */
        const samples = await page.evaluate(async () => {
          /** @type {{t:number,centre:number,width:number}[]} */
          const out = [];
          const start = performance.now();
          /** @type {HTMLElement} */ (document.querySelector("#localopen")).click();
          while (performance.now() - start < 800) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const ring = document.querySelector(".ringcard .bigring");
            if (!ring) continue;
            const r = ring.getBoundingClientRect();
            out.push({ t: performance.now() - start, centre: r.top + r.height / 2, width: r.width });
          }
          return out;
        });
        expect(samples.length, "the card's ring never appeared").toBeGreaterThan(2);
        const first = samples[0];
        const last = samples[samples.length - 1];
        console.log(`390x664 motion ${motion}: ring first seen at ${first.centre.toFixed(1)}px, ${first.width.toFixed(1)}px across; after ${last.t.toFixed(0)}ms at ${last.centre.toFixed(1)}px, ${last.width.toFixed(1)}px across`);

        expect(Math.abs(last.centre - 0.3 * 664)).toBeLessThanOrEqual(TOLERANCE);
        expect(last.width).toBeCloseTo(240, 0);
        expect(Math.abs(first.centre - 0.3 * 664), "the ring travelled under reduced motion").toBeLessThanOrEqual(TOLERANCE);
        return;
      }

      /* where the bare door's glyph stands, read before the tap (SignIn.svelte
         seeds the card's ring from this same rect: .72R across, same centre) */
      const doorRing = await page.locator("#login-glyph svg").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { centre: r.top + r.height / 2, width: r.width };
      });

      const run = await page.evaluate(async () => {
        const travelling = ["margin-top", "width", "height"];
        /** @param {Element} ring */
        const transitionsOf = (ring) => ring.getAnimations().filter((a) =>
          a instanceof CSSTransition && travelling.includes(a.transitionProperty));
        /* The card creates the ring on the tap, and the observer runs before the
           next frame, so its transitions are caught and held. They are stepped by
           hand below, so a late catch changes nothing. A ring with none (placed,
           not travelling) is given three frames to show one, then reported as
           it is rather than waited for. */
        const held = new Promise((resolve) => {
          const watch = new MutationObserver(async () => {
            const ring = document.querySelector(".ringcard .bigring");
            if (!ring) return;
            watch.disconnect();
            let found = transitionsOf(ring);
            for (let i = 0; i < 3 && !found.length; i++) {
              await new Promise((next) => requestAnimationFrame(next));
              found = transitionsOf(ring);
            }
            for (const a of found) a.pause();
            resolve({ ring, found });
          });
          watch.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
        });
        /** @type {HTMLElement} */ (document.querySelector("#localopen")).click();
        const { ring, found } = /** @type {{ring: Element, found: CSSTransition[]}} */ (await held);
        if (!found.length) return { properties: [], samples: [] };
        const properties = found.map((a) => ({
          property: a.transitionProperty,
          duration: Number(a.effect?.getComputedTiming().duration),
        }));
        const duration = Math.max(...properties.map((p) => p.duration));
        const steps = 10;
        /** @type {{at:number,centre:number,width:number}[]} */
        const samples = [];
        for (let i = 0; i <= steps; i++) {
          const at = duration * i / steps;
          for (const a of found) a.currentTime = at;
          const r = ring.getBoundingClientRect();
          samples.push({ at, centre: r.top + r.height / 2, width: r.width });
        }
        for (const a of found) a.finish();
        return { properties, samples };
      });
      /* everything finite on the page finished, then the end is read */
      await page.waitForFunction(() => document.getAnimations()
        .filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
        .every((a) => a.playState === "finished"), undefined, { timeout: 20_000 });
      const landed = await page.locator(".ringcard .bigring").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { centre: r.top + r.height / 2, width: r.width };
      });

      const { properties, samples } = run;
      /* the ring carries its position and size over .5s, rather than being placed */
      expect(properties.map((p) => p.property).sort(), "the ring's margin-top, width and height do not all transition").toEqual(["height", "margin-top", "width"]);
      for (const p of properties) expect(p.duration, `${p.property} travels over .5s`).toBe(500);
      const first = samples[0];
      const last = samples[samples.length - 1];
      console.log(`390x664 motion ${motion}: door's ring at ${doorRing.centre.toFixed(1)}px, ${doorRing.width.toFixed(1)}px across; hand-over ${properties.map((p) => `${p.property} ${p.duration}ms`).join(", ")}; stepped from ${first.centre.toFixed(1)}px (${first.width.toFixed(1)} across) to ${last.centre.toFixed(1)}px (${last.width.toFixed(1)} across); landed at ${landed.centre.toFixed(1)}px, ${landed.width.toFixed(1)}px across`);

      /* it starts at the door's station... */
      expect(first.centre, "the ring did not start from the door's station").toBeGreaterThan(0.36 * 664);
      expect(Math.abs(first.centre - doorRing.centre), "the ring did not start where the door's ring stands").toBeLessThanOrEqual(TOLERANCE);
      expect(first.width, "the ring did not start at the door's ring size (.72R of the glyph)").toBeCloseTo(0.72 * doorRing.width, 0);
      /* ...ends at the card's, 30% down and 240 across... */
      expect(Math.abs(last.centre - 0.3 * 664)).toBeLessThanOrEqual(TOLERANCE);
      expect(last.width).toBeCloseTo(240, 0);
      expect(Math.abs(landed.centre - 0.3 * 664), "the ring did not stay at the card's station").toBeLessThanOrEqual(TOLERANCE);
      expect(landed.width).toBeCloseTo(240, 0);
      /* ...and in between it is neither: every step lies between the two, in order */
      for (let i = 1; i < samples.length - 1; i++) {
        expect(samples[i].centre, `step ${i} of ${samples.length - 1}: the ring went back towards the door's station`).toBeLessThan(samples[i - 1].centre + 0.001);
        expect(samples[i].centre, `step ${i} of ${samples.length - 1}: the ring is already at the card's station`).toBeGreaterThan(last.centre + 0.01);
        expect(samples[i].centre, `step ${i} of ${samples.length - 1}: the ring is still at the door's station`).toBeLessThan(first.centre - 0.01);
      }
      expect(samples[Math.floor(samples.length / 2)].centre, "the ring never left the door's station on its way").toBeLessThan(first.centre - 5);
    });
  });
}

for (const size of SIZES) {
  test.describe(`the well's fit at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size, hasTouch: true, isMobile: true });

    test("the 4s span the width inside the gutters and the glow ends above the heading", async ({ page }) => {
      await page.goto(`${APP}/door-station-no-such-page`, { waitUntil: "load" });
      await page.waitForSelector(".world[data-rasterised=ready]");

      const m = await page.evaluate(() => {
        const svg = /** @type {SVGSVGElement} */ (document.querySelector(".world > svg"));
        const box = svg.getBoundingClientRect();
        const k = box.width / 1600;
        const gutter = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--p-gutter"));
        const heading = /** @type {HTMLElement} */ (document.querySelector("h1.offchart")).getBoundingClientRect();
        return {
          k,
          fours: 720 * k,
          left: box.left + 440 * k,
          right: box.left + 1160 * k,
          glowBottom: box.top + 770 * k,
          headingTop: heading.top,
          gutter,
          vw: document.documentElement.clientWidth,
          vh: window.innerHeight,
        };
      });
      console.log(`${size.width}x${size.height} 404: 4s span ${m.fours.toFixed(1)}px (x ${m.left.toFixed(1)}-${m.right.toFixed(1)}), glow bottom ${m.glowBottom.toFixed(1)}px, heading top ${m.headingTop.toFixed(1)}px`);

      /* the fit: --kw = min((100cqw - 2 gutters) / 760, 58cqh / 640) */
      const k = Math.min((m.vw - 2 * m.gutter) / 760, (0.58 * m.vh) / 640);
      expect(m.k).toBeCloseTo(k, 3);
      expect(Math.abs(m.fours - 720 * k)).toBeLessThanOrEqual(1);
      /* the 4s stand inside the screen, centred */
      expect(m.left).toBeGreaterThanOrEqual(0);
      expect(m.right).toBeLessThanOrEqual(m.vw);
      expect(Math.abs((m.left + m.right) / 2 - m.vw / 2)).toBeLessThanOrEqual(1);
      expect(m.glowBottom, "the glow runs into the heading").toBeLessThan(m.headingTop);
    });
  });
}
