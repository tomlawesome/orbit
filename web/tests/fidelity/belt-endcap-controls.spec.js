import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * #1062: the belt's two end-caps are controls, not captions.
 *
 * They used to be inert SVG text. Stepping along the belt was ArrowLeft and
 * ArrowRight and nothing else, so a phone could not move along it at all — a
 * reader could only tap a body already on screen. The owner's ruling of
 * 2026-09-19 is that the affordance and its placement were ratified and it
 * should have been built as a control in the first place, so the positions
 * are untouched and only the behaviour is new.
 *
 * What is proved here: a press is the arrow key's press — same landing —
 * by pointer and by keyboard; both end-caps are reachable by Tab and wear a
 * focus ring; the target is the product's 44px floor even though the ink
 * stays 9.5px; a phone can traverse the whole belt with no keyboard; and the
 * end that has run out is disabled and says so rather than quietly doing
 * nothing.
 *
 * The same shape and harness as belt-chrome-viewport.spec.js, and here for
 * the same reason: it is real layout and real hit-testing, and this harness
 * already stands up the app the gate photographs, so it belongs beside the
 * pixel gate rather than in the e2e suite, which needs a live instance.
 */

/** The desk the gate itself judges at, and the phone #1035 was reported at. */
const VIEWPORTS = [
  { width: 1600, height: 1000 },
  { width: 390, height: 844 },
];

/** The roll: GLIDE is 420ms and the card lands 430ms after the press. */
const SETTLE = 500;

const SOONER = '#ends [data-step="-1"]';
const LATER = '#ends [data-step="1"]';

/** @param {import("@playwright/test").Page} page */
async function openBelt(page) {
  await page.goto(`${APP}/item/i-mot`, { waitUntil: "load" });
  /* The gate's own settle for this screen: the band has its seats and the
     apex has its card, both of which arrive client-side. */
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#seats .seat").length > 0
      && Boolean(document.querySelector(".item-card h2")),
  );
}

/** Whichever body is riding the apex, by the name on its card. */
/** @param {import("@playwright/test").Page} page */
const apex = (page) => page.locator(".item-card h2").innerText();

for (const { width, height } of VIEWPORTS) {
  test(`an end-cap press is the arrow key's press at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openBelt(page);

    /* Which cap is which, before anything is pressed. `dir` in buildEnds is
       the band's branch and is the OPPOSITE of the step at each end, so a
       press wired from it moves the belt the wrong way and every "something
       changed" assertion below still passes. Asserted against the painted
       words so that cannot happen quietly. */
    await expect(page.locator(SOONER)).toContainText("sooner");
    await expect(page.locator(SOONER)).toHaveAttribute("aria-label", /sooner/i);
    await expect(page.locator(LATER)).toContainText("later");
    await expect(page.locator(LATER)).toHaveAttribute("aria-label", /later/i);

    const start = await apex(page);

    /* Where the keyboard goes, recorded first so the pointer has something
       to be measured against rather than merely "something changed". */
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(SETTLE);
    const byKeySooner = await apex(page);
    expect(byKeySooner, "ArrowLeft did not move the belt").not.toBe(start);

    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(SETTLE);
    expect(await apex(page), "ArrowRight did not come back").toBe(start);

    /* One press, one step, same landing. */
    await page.locator(SOONER).click();
    await page.waitForTimeout(SETTLE);
    expect(await apex(page), "← sooner did not land where ArrowLeft lands").toBe(byKeySooner);

    await page.locator(LATER).click();
    await page.waitForTimeout(SETTLE);
    expect(await apex(page), "later → did not land where ArrowRight lands").toBe(start);
  });

  test(`both end-caps are reachable by Tab and answer Enter at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openBelt(page);

    /* Tabbed to rather than focused by script: the point of the issue is that
       a keyboard reader can FIND them. The belt seats are focusable too, and
       there are a dozen of them, so the walk is bounded generously and stops
       as soon as both have been seen. */
    /** @type {string[]} */
    const seen = [];
    for (let i = 0; i < 40 && seen.length < 2; i++) {
      await page.keyboard.press("Tab");
      const step = await page.evaluate(() =>
        document.activeElement?.closest?.("#ends [data-step]")?.getAttribute("data-step") ?? null);
      if (step && !seen.includes(step)) seen.push(step);
    }
    expect(seen.sort(), "Tab did not reach both end-caps").toEqual(["-1", "1"]);

    /* And the ring is really showing, read the way the e2e keyboard audit
       reads it: the computed style of THE ELEMENT THAT HAS FOCUS
       (tests/e2e/support/keyboard.ts's focusVisible — an outline, or a
       box-shadow). The first cut of this control drew the ring as a child
       rect and asserted the CHILD's opacity here, which passed while the
       focused <g> itself carried nothing, and the audit caught in CI what
       this test had waved through (pipeline 1281). Asserting the same
       property the audit does is the point. */
    const focused = await page.evaluate(() => {
      const cap = document.activeElement?.closest?.("#ends [data-step]");
      const cs = cap ? getComputedStyle(cap) : null;
      return {
        step: cap?.getAttribute("data-step") ?? null,
        name: cap?.getAttribute("aria-label") ?? "",
        outlineStyle: cs?.outlineStyle ?? "none",
        outlineWidth: cs?.outlineWidth ?? "0px",
        boxShadow: cs?.boxShadow ?? "none",
      };
    });
    const outlined = focused.outlineStyle !== "none" && focused.outlineWidth !== "0px";
    const shadowed = Boolean(focused.boxShadow) && focused.boxShadow !== "none";
    expect(outlined || shadowed,
      `the focused end-cap paints no indicator on itself: ${JSON.stringify(focused)}`).toBe(true);
    /* Not a hairline that merely satisfies the check: it has to be seen
       against the band. */
    if (outlined) expect(Number.parseFloat(focused.outlineWidth)).toBeGreaterThanOrEqual(2);
    /* The name says what it does, rather than reading the two painted words
       back to somebody who cannot see them. */
    expect(focused.name.toLowerCase()).toContain("along the belt");

    const before = await apex(page);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(SETTLE);
    expect(await apex(page), "Enter on a focused end-cap did not step the belt").not.toBe(before);
  });

  test(`the end-cap target meets the product's 44px floor at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openBelt(page);

    const boxes = await page.evaluate(() =>
      [...document.querySelectorAll("#ends [data-step]")].map((cap) => {
        const target = cap.getBoundingClientRect();
        const ink = cap.querySelector(".endcap");
        return {
          step: cap.getAttribute("data-step"),
          w: target.width, h: target.height,
          /* The painted words are NOT allowed to have grown with the target. */
          ink: ink ? getComputedStyle(ink).fontSize : "none",
        };
      }));

    expect(boxes.length, "the belt has no end-caps to measure").toBe(2);
    for (const box of boxes) {
      expect(box.w, `end-cap ${box.step} is too narrow to press`).toBeGreaterThanOrEqual(44);
      expect(box.h, `end-cap ${box.step} is too short to press`).toBeGreaterThanOrEqual(44);
      expect(box.ink, `end-cap ${box.step}'s ink changed size`).toBe("9.5px");
    }
  });
}

test("a phone traverses the whole belt with no keyboard, and a spent end says so", async ({ page }) => {
  test.slow();   /* one roll per press, the length of the belt, twice */
  await page.setViewportSize({ width: 390, height: 844 });
  await openBelt(page);

  /**
   * Presses one end-cap until it refuses, and reports what it passed through.
   *
   * @param {string} which the end-cap's selector
   */
  async function walk(which) {
    const cap = page.locator(which);
    /** @type {string[]} */
    const landed = [];
    for (let i = 0; i < 25; i++) {
      if (await cap.getAttribute("aria-disabled") === "true") return landed;
      const before = await apex(page);
      await cap.click();
      await page.waitForTimeout(SETTLE);
      const after = await apex(page);
      expect(after, `a press of ${which} did not move the belt`).not.toBe(before);
      landed.push(after);
    }
    throw new Error(`${which} never ran out in 25 presses`);
  }

  const soonerWay = await walk(SOONER);
  expect(soonerWay.length, "the sooner end was already exhausted").toBeGreaterThan(0);
  /* At the sooner end the control that cannot move says so — and keeps its
     place in the Tab order, so a reader can still find it and be told. */
  await expect(page.locator(SOONER)).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator(SOONER)).toHaveAttribute("tabindex", "0");
  await expect(page.locator(LATER)).toHaveAttribute("aria-disabled", "false");

  /* A disabled end-cap takes the press and does nothing, deliberately. The
     click is dispatched rather than performed because Playwright's own
     actionability check already refuses it — "element is not enabled" — which
     is the state being asserted; dispatching goes past that and proves the
     handler refuses it too. */
  const parked = await apex(page);
  await page.locator(SOONER).dispatchEvent("click");
  await page.waitForTimeout(SETTLE);
  expect(await apex(page), "a spent end-cap still moved the belt").toBe(parked);

  const laterWay = await walk(LATER);
  /* The whole belt, by pointer alone: everything the sooner walk passed
     through is passed again on the way back, and then some. */
  expect(laterWay.length, "the later walk was shorter than the sooner one")
    .toBeGreaterThan(soonerWay.length);
  await expect(page.locator(LATER)).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator(SOONER)).toHaveAttribute("aria-disabled", "false");
});
