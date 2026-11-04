import { expect, test } from "@playwright/test";

import { APP, onPhone } from "./a11y-support.js";

/*
 * G-B4-3 (#1671): the desk's administration screen reads the last mail-test
 * answers from the server's `operations.mailProbes` on load, so the pill and
 * its reason survive a reload (owner, 2026-09-19; +page.svelte testPill and
 * testMetaOf). The operations answer is the test's own; nothing is clicked.
 */
test.use({ baseURL: APP, serviceWorkers: "block" });

const NOW = Date.parse("2026-08-13T12:00:00.000Z");

test("the desk shows the relay test's pill and reason from the server's last answer on load", async ({ page }, testInfo) => {
  test.skip(onPhone(testInfo), "the desk's mail rows; the phone's mail card reads the same probes (pocket.svelte)");
  await page.route("**/api/admin/operations", (route) => route.fulfill({
    json: {
      operations: {
        documentJobs: [], documentJobCounts: {},
        mailProbes: {
          mailbox: { result: "available", at: new Date(NOW - 5 * 60000).toISOString() },
          relay: { result: "smtp_rejected", at: new Date(NOW - 2 * 60000).toISOString() },
        },
      },
    },
  }));
  await page.goto("/administration");

  const relay = page.locator(".person", { hasText: "outgoing mail test" });
  await expect(relay).toContainText("the outgoing mail server refused the sign-in");
  await expect(relay.locator(".role")).toContainText("failed");
  const mailbox = page.locator(".person", { hasText: "mailbox test" }).first();
  await expect(mailbox.locator(".role")).toContainText("passed");
});
