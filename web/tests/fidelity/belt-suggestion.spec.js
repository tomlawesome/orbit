import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * #1145 (owner, 2026-09-27): "the same familiar item belt just with a similar
 * card to the suggested item screen, but on the belt instead". A mail-in
 * receipt arrived at by its own address (`/item/<receiptId>`) is the belt
 * with the suggestion seated at the date the relay read -- a hollow rock
 * among its neighbours in time, its forwarded paper staged beside it -- and
 * its card is the amend-then-accept card (#434) in the belt's card position.
 * Accepted, it becomes the new item's seat in place; dismissed, it leaves
 * and the apex moves to the neighbour it sat beside.
 *
 * The desk half; the phone's is in pocket-inbox.spec.js beside the review
 * card it shares with the inbox. The same shape and harness as
 * belt-endcap-controls.spec.js: real layout, real hit-testing, against the
 * app the gate photographs.
 */
test.use({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });

/** The roll: GLIDE is 420ms and the card lands 430ms after the press;
    reduced motion makes it instant, and this is the margin. */
const SETTLE = 500;

/** @param {import("@playwright/test").Page} page */
async function openSuggestion(page) {
  await page.goto(`${APP}/item/r-insurance`, { waitUntil: "load" });
  /* The gate's own settle for this screen: the band has its seats and the
     apex has its card, both of which arrive client-side. */
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#seats .seat").length > 0
      && Boolean(document.querySelector(".item-card h2, .item-card .name-title")),
  );
}

/** Whichever body is riding the apex, by the name on its card: a filed
    item's heading, or the suggestion's editable name. */
/** @param {import("@playwright/test").Page} page */
const apex = (page) => page.evaluate(() => {
  const name = /** @type {HTMLInputElement | null} */ (document.querySelector(".item-card .name-title"));
  return name ? name.value : document.querySelector(".item-card h2")?.textContent ?? "";
});

/**
 * Answers the calls the two decisions make and records them.
 * @param {import("@playwright/test").Page} page
 */
async function answerDecisions(page) {
  /** @type {{ approvals: any[], discards: string[] }} */
  const seen = { approvals: [], discards: [] };
  await page.route("**/api/imap-inbox/r-*", async (route) => {
    const request = route.request();
    const id = new URL(request.url()).pathname.split("/").pop() ?? "";
    if (request.method() === "DELETE") {
      seen.discards.push(id);
      return route.fulfill({ json: { ok: true } });
    }
    if (request.method() === "PUT") return route.fulfill({ json: { ok: true } });
    return route.fulfill({
      json: {
        receipt: { id, draftVersion: 3, proposal: { title: "Home insurance renewal" } },
        sections: [{ id: "s-home" }, { id: "s-dates" }],
        attachments: [{ id: "a-1" }],
      },
    });
  });
  await page.route("**/api/reviewed-intake/approve", async (route) => {
    seen.approvals.push(route.request().postDataJSON());
    /* The fixture workspace cannot grow, so the approval answers with a real
       fixture item's id: what matters is that the belt re-reads and seats
       the item the server named. */
    await route.fulfill({ json: { outcome: "approved", itemId: "i-chimney" } });
  });
  return seen;
}

test("the receipt address is the belt, with the suggestion seated hollow at the relay's date", async ({ page }) => {
  await openSuggestion(page);
  /* The card in the belt's card position: the old page's card, in the belt's grammar. */
  const card = page.locator(".item-card.sug-card");
  await expect(card).toBeVisible();
  await expect(card.locator(".name-title")).toHaveValue("Home insurance renewal");
  await expect(card.locator(".name-title")).toHaveClass(/sugg/);
  await expect(card.locator(".sub")).toHaveText("suggested from your documents · 1 forwarded document · burns up in 43d");
  await expect(card.locator("#s-provider")).toHaveValue("Harbour Mutual");
  await expect(card.locator("#s-due")).toHaveValue("2026-10-03");
  await expect(card.locator("#s-cost")).toHaveValue("400.00");
  await expect(card.locator(".note").first()).toContainText("policy-schedule.pdf");
  await expect(card.locator(".note").first()).toContainText("attached on acceptance");
  await expect(card.getByRole("button", { name: "accept into orbit" })).toBeEnabled();
  await expect(card.getByRole("button", { name: "dismiss" })).toBeVisible();
  /* Gone with the page it was on: the way back is the chrome's, and the
     promise line is cut (owner's 10b) -- the sub line says when it burns up. */
  await expect(page.getByText("back to your orbit")).toHaveCount(0);
  await expect(page.getByText("nothing is created without your acceptance")).toHaveCount(0);

  /* The belt around it is the household's, the suggestion counted apart. */
  await expect(page.locator("#findnote")).toHaveText("6 items · 1 suggested · in date order, sooner to later");
  /* #1147: the longer line stays one line under the find field. */
  expect(await page.locator("#findnote").evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
  })).toBe(1);
  /* ...and centred under the field, spilling evenly rather than to one side. */
  const [text, field] = await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(/** @type {Element} */ (document.getElementById("findnote")));
    const t = range.getBoundingClientRect();
    const f = /** @type {Element} */ (document.getElementById("find")).getBoundingClientRect();
    return [t.left + t.width / 2, f.left + f.width / 2];
  });
  expect(Math.abs(text - field)).toBeLessThan(2);
  /* Its own seat is hollow stone in the accent, and says what it is. */
  const seat = page.locator('#seats .hit.sug[aria-label^="Home insurance renewal"]');
  await expect(seat).toHaveCount(1);
  await expect(seat).toHaveAttribute("aria-label", /suggested from your documents, not yet in orbit, renews 3 October 2026/);
  await expect(seat.locator("polygon.hollow")).toHaveCount(1);
  /* Every other seat is solid stone, as before. */
  expect(await page.locator("#seats .hit:not(.sug) polygon.hollow").count()).toBe(0);
});

test("the suggestion sits between its neighbours in time, and stepping lands on them", async ({ page }) => {
  await openSuggestion(page);
  expect(await apex(page)).toBe("Home insurance renewal");
  /* 03 Oct sits after Boiler service (04 Sept) and before Chimney sweep (13 Oct). */
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(SETTLE);
  expect(await apex(page)).toBe("Boiler service");
  await expect(page).toHaveURL(/\/item\/i-boiler$/);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(SETTLE);
  expect(await apex(page)).toBe("Home insurance renewal");
  await expect(page).toHaveURL(/\/item\/r-insurance$/);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(SETTLE);
  expect(await apex(page)).toBe("Chimney sweep");
});

test("the staged paper rides beside the card and opens the reading card's honest state", async ({ page }) => {
  await openSuggestion(page);
  /* The seat carries the paper's name and says it is staged. `force`: a
     paper's mark breathes forever (document-preview.spec.js). */
  const paper = page.locator('#seats .seat .hit[aria-label^="policy-schedule.pdf"]');
  await expect(paper).toHaveAttribute("aria-label", /a forwarded document staged with Home insurance renewal/);
  await paper.click({ force: true });
  const readcard = page.locator("#readcard");
  await expect(readcard).toBeVisible();
  await expect(readcard.locator(".focusline")).toHaveText("Not yet in orbit.");
  await expect(readcard.locator(".plate")).toHaveText("PDF");
  /* Nothing to do with it yet: no foot, no page, no download. */
  await expect(readcard.locator(".rcfoot")).toHaveCount(0);
  await expect(readcard.locator("img")).toHaveCount(0);
  /* Esc closes it, the belt's own dead-space law (§18). */
  await page.keyboard.press("Escape");
  await expect(page.locator("#readcard")).toHaveCount(0);
});

test("accept sends the amended fields and the belt re-seats on the item the server named", async ({ page }) => {
  const seen = await answerDecisions(page);
  await openSuggestion(page);
  const card = page.locator(".item-card.sug-card");
  await card.locator(".name-title").fill("Home insurance, corrected");
  await card.locator("#s-cost").fill("199.99");
  await card.getByRole("button", { name: "accept into orbit" }).click();
  await expect.poll(() => seen.approvals.length).toBe(1);
  expect(seen.approvals[0]).toMatchObject({
    action: "create_separate", attachmentIds: ["a-1"],
    source: { kind: "mailbox_draft", receiptId: "r-insurance", draftVersion: 3 },
    item: { title: "Home insurance, corrected", provider: "Harbour Mutual", costMinor: 19999, currency: "GBP",
      dueDate: "2026-10-03", scheduleKind: "renewal", recurrenceMonths: 12 },
  });
  /* Accepted: an ordinary seat, in place -- the belt re-reads with that item
     at the apex and nothing hollow left in it. */
  await expect(page).toHaveURL(/\/item\/i-chimney$/);
  await expect(page.locator(".item-card h2")).toHaveText("Chimney sweep");
  await expect(page.locator(".item-card.sug-card")).toHaveCount(0);
  await expect(page.locator("#seats .hit.sug")).toHaveCount(0);
});

test("dismiss takes two presses, then the apex moves to the neighbour it sat beside", async ({ page }) => {
  const seen = await answerDecisions(page);
  await openSuggestion(page);
  const card = page.locator(".item-card.sug-card");
  await card.getByRole("button", { name: "dismiss" }).click();
  await expect(card.getByRole("button", { name: "tap again to dismiss" })).toBeVisible();
  expect(seen.discards).toHaveLength(0);
  await card.getByRole("button", { name: "tap again to dismiss" }).click();
  await expect.poll(() => seen.discards).toEqual(["r-insurance"]);
  /* The later neighbour: Chimney sweep, 13 Oct. */
  await expect(page).toHaveURL(/\/item\/i-chimney$/);
  await expect(page.locator(".item-card h2")).toHaveText("Chimney sweep");
  await expect(page.locator("#seats .hit.sug")).toHaveCount(0);
});

test("a filed item's belt seats no suggestion", async ({ page }) => {
  await page.goto(`${APP}/item/i-mot`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll("#seats .seat").length > 0);
  await expect(page.locator("#seats .hit.sug")).toHaveCount(0);
  await expect(page.locator("#findnote")).toHaveText("6 items · in date order, sooner to later");
});
