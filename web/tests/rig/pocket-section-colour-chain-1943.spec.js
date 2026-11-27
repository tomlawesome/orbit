import { expect, test } from "@playwright/test";

import { APP, RIG_EXPECT_MS, onPhone, signedIn } from "./a11y-support.js";
import { useFixtureScenes } from "../fidelity/pocket-states.js";

/*
 * #1943 W-R1 (a gap left by #1930): the phone household screen saves colour
 * picks in order and the last pick wins, as the desk's pickColour chain does.
 * On the phone an arrow key on a swatch picks the neighbour and saves at once,
 * so two quick arrows are two picks. The first save is held at the network so
 * the second pick is made while it is in flight; the held save is then let go.
 * If the saves run unchained, the second pick's save lands first and the held
 * first one lands last, so the stored colour is the earlier pick. End states
 * only: what the server holds after a reload, and the order saves were sent in.
 */
test.use({ baseURL: APP });

const HOUSEHOLD = "/household/hh-harlow-1";

test("household editor (phone): two quick colour picks save in order and the last pick wins", async ({ page }, testInfo) => {
  test.skip(!onPhone(testInfo), "the desk chains in +page.svelte; this is the phone's screen (pocket.svelte)");
  await useFixtureScenes(page, "keep-saves");
  await signedIn(HOUSEHOLD, "saves-kept")(page);

  const isWrite = (/** @type {import("@playwright/test").Request} */ request) => request.url().endsWith("/api/workspace/commands")
    && request.method() === "POST" && request.postDataJSON()?.type === "sections.replace" && !request.postDataJSON()?.dryRun;
  const homeColourOf = (/** @type {import("@playwright/test").Request} */ request) =>
    request.postDataJSON().sections.find((/** @type {{ id: string }} */ one) => one.id === "s-home")?.colour;

  /** @type {string[]} */
  const sent = [];
  /** @type {() => void} */
  let releaseFirst = () => {};
  const firstHeld = new Promise((resolve) => { releaseFirst = () => resolve(undefined); });
  let writes = 0;
  /** @type {(value?: unknown) => void} */
  let secondSeen = () => {};
  const second = new Promise((resolve) => { secondSeen = resolve; });
  await page.route("**/api/workspace/commands", async (route) => {
    const request = route.request();
    if (!isWrite(request)) return route.fallback();
    writes += 1;
    sent.push(homeColourOf(request));
    if (writes === 1) await firstHeld;
    else secondSeen();
    return route.fallback();
  });

  const group = page.getByRole("radiogroup", { name: "Colour for Home", exact: true });
  const radio = (/** @type {string} */ name) => group.getByRole("radio", { name, exact: true });
  await expect(group).toBeVisible({ timeout: RIG_EXPECT_MS });
  await radio("home").focus();
  await page.keyboard.press("ArrowRight"); // picks vehicles; its save is held
  await expect.poll(() => sent.length, { timeout: RIG_EXPECT_MS }).toBe(1);
  await page.keyboard.press("ArrowRight"); // picks devices while the first save is in flight
  // Unchained, the second save is sent at once and `second` settles; chained, it waits for the first.
  await Promise.race([second, page.waitForTimeout(1_000)]);
  releaseFirst();
  await expect.poll(() => sent.length, { timeout: RIG_EXPECT_MS }).toBe(2);

  expect(sent, "saves are sent in pick order").toEqual(["vehicles", "devices"]);
  await page.unroute("**/api/workspace/commands");
  await page.reload();
  await expect(radio("devices")).toHaveAttribute("aria-checked", "true", { timeout: RIG_EXPECT_MS });
  await expect(group.locator('[role="radio"][aria-checked="true"]')).toHaveCount(1);
});
