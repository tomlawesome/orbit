import { expect, test } from "@playwright/test";
import { DOOR_STATES } from "./pocket-states.js";

/*
 * #1136: `/invite/<token>` never reset the browser's default 8px body
 * margin above a phone width, so at a desk size the invite stage sat 8px in
 * on every side and the page could scroll by 16px — the margin's own gutter,
 * nothing else. The phone media query in invite.css already carried
 * `body:has(.invite-card){margin:0}`; the fix moves that reset out to every
 * width instead of just the phone's.
 *
 * The same harness as door-station.spec.js: DOOR_STATES' "used" invite entry
 * already knows how to reach this screen without a real invitation (it mocks
 * the SvelteKit `__data.json` node), so it is reused rather than rebuilt.
 */

const door = DOOR_STATES.find((s) => s.slug === "invite" && s.state === "used");
if (!door) throw new Error("no door state invite · used in pocket-states.js");

/** A desk viewport: the one the fidelity gate itself judges screens at. */
const WIDTH = 1600;
const HEIGHT = 1000;

test(`the invite outcome carries no browser margin at ${WIDTH}x${HEIGHT}`, async ({ page }) => {
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  await door.reach(page);

  const info = await page.evaluate(() => ({
    marginTop: getComputedStyle(document.body).marginTop,
    marginLeft: getComputedStyle(document.body).marginLeft,
    scrollable: document.documentElement.scrollHeight > window.innerHeight,
  }));

  expect(info.marginTop, "the body still carries the browser's default top margin").toBe("0px");
  expect(info.marginLeft, "the body still carries the browser's default left margin").toBe("0px");
  expect(info.scrollable, "the desk invite page scrolls even though its content fits the viewport")
    .toBe(false);
});
