import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * #1051: settings/mail/relay.css declared its own .dish, .alias, .kv and
 * .note with no route wrapper at all, unlike every other route stylesheet in
 * this family. SvelteKit does not unload a visited route's CSS chunk on
 * client-side navigation, so once /settings/mail had been visited, relay's
 * bare .alias{font,color,background,border:1px dashed,border-radius,padding,
 * text-align,margin} kept matching inbox's own <div class="alias"> in its
 * empty-queue "your relay" summary (inbox/+page.svelte's .relaybar .alias) --
 * inbox's own scoped rule only sets flex/min-width there, so none of relay's
 * declarations were shadowed. The address a member forwards mail to would
 * grow a dashed box, a panel background and centred text it was never drawn
 * with -- worse than the already-known collisions, which only added stray
 * sizing or ink (see #1050's own history).
 *
 * As with #1050's own reproduction, the walk matters as much as the
 * assertion: land on /settings/mail first, follow real in-app links to
 * /inbox (client-side, not page.goto), and only then read the computed
 * style. A direct load of /inbox never loads the relay's chunk, so that path
 * always passed and proved nothing.
 *
 * The empty-queue view (where .alias renders) is not the fixture's default
 * state, so /api/imap-inbox is stubbed empty for this test alone -- nothing
 * about the CSS bug depends on that choice, it only makes the reachable view
 * deterministic without touching shared fixture data.
 */
test("inbox's own relay summary keeps its own layout after a client-side navigation from /settings/mail", async ({
  page,
}) => {
  await page.goto(`${APP}/settings/mail`, { waitUntil: "load" });
  /* The relay card has rendered and its own .alias/.dish are on the page --
     the chunk that must not follow the reader onward is now loaded. */
  await page.waitForFunction(() => Boolean(document.querySelector(".relay-card .alias")));

  /* Force the empty-queue branch of /inbox deterministically, whatever the
     fixture's default receipt list holds -- see the file comment above. */
  await page.route("**/api/imap-inbox", (route) =>
    route.fulfill({ json: { receipts: [], filed: [] } }),
  );

  /* The shared chrome's account panel carries the only in-app link to
     /inbox from this screen -- open it, then follow the link, so SvelteKit
     takes the navigation client-side rather than issuing a fresh load. */
  await page.locator("button.orb").click();
  const inboxLink = page.locator(".account nav a", { hasText: "Inbox" });
  await expect(inboxLink).toBeVisible();
  await inboxLink.click();
  await page.waitForURL("**/inbox");

  /* Inbox's own settle: the empty-queue summary has rendered. */
  await page.waitForFunction(() => Boolean(document.querySelector(".relaybar .alias")));

  const alias = page.locator(".relaybar .alias");
  await expect(
    alias,
    "#1051: inbox's own .relaybar .alias must not inherit relay.css's bare .alias box",
  ).toHaveCSS("border-style", "none");
  await expect(alias).toHaveCSS("padding", "0px");
});
