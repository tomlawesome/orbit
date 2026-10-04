import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { sessionHeaders } from "./support/households";
import { settleArrival } from "./support/arrival";
import { claimInstanceAsAdministrator } from "./support/bootstrap";
import { workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";

/* #1077: this file's own copy of the seed-restore discipline every spec
   under tests/e2e/ follows -- see support/database.ts for why. */
resetDatabaseBetweenSpecFiles();

/**
 * #1003: the Reminders card's second tab, on both dialects -- the signed-in
 * member's own last five attempted `notification_deliveries`. Sign-in and
 * the household/item are the real pipe, the same as every other spec under
 * tests/e2e/; the deliveries themselves are seeded with raw SQL because
 * nothing in the product writes them except the dispatch worker, which this
 * spec has no reason to run for real (#1077's stack is not the worker's own
 * suite).
 */

/**
 * Schedules the household for deletion so its deliveries stop answering
 * "sent to you lately" (src/server/notification-history.ts filters to
 * sent/retry/failed, and requestHouseholdDeletion cancels every delivery a
 * household holds) -- household.create makes the seeding reader its OWNER,
 * never an instance administrator, and household-lifecycle.ts's
 * requireHardDeleteAuthority refuses hard_delete to anyone but one (403).
 * support/households.ts's own sweep() always attempts hard_delete next, so
 * it cannot be reused by an ordinary member's own household; this is that
 * file's schedule-only half, which requireScheduleAuthority does allow an
 * owner to do.
 */
async function scheduleHouseholdDeletion(page: Page, householdId: string, name: string) {
  const response = await page.request.post(`/api/households/${householdId}/lifecycle`, {
    headers: await sessionHeaders(page),
    data: { action: "delete", confirmation: name },
  });
  if (response.status() === 404 || response.status() === 409) return;
  if (!response.ok()) throw new Error(`#1003: could not schedule cleanup of "${name}" (${response.status()})`);
}

/** The stack's own database container, reached the way support/database.ts does. */
function databaseContainer(): string {
  const project = process.env.COMPOSE_PROJECT_NAME;
  return execFileSync(
    "docker",
    [
      "compose", ...(project ? ["-p", project] : []),
      "--env-file", ".env-orbit", "-f", "docker-compose.yml", "ps", "-q", "orbit-db",
    ],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, ORBIT_IMAGE: process.env.ORBIT_IMAGE ?? "orbit-local:000000000000" } },
  ).trim().split("\n")[0]?.trim() ?? "";
}

function runSql(statements: string): string {
  const container = databaseContainer();
  if (!container) throw new Error("#1003 spec: no orbit-db container for this stack -- is it up?");
  return execFileSync(
    "docker",
    ["exec", "-i", container, "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q -t -A -f -'],
    { input: statements, encoding: "utf8", timeout: 60_000 },
  );
}

async function signInAs(page: Page, account: string) {
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: account }).click();
  await settleArrival(page);
}

/**
 * The settings screen, loaded — every card is gated on the screen's own
 * fetch. `.helm-page .cards` is the desk dialect's own loaded signal; below
 * the CSS switch (pocket.svelte's `.st-pocket` media query) `.page` itself
 * is `display:none`, so a mobile project waiting on `.cards` times out on a
 * container that is hidden by design rather than one that never loaded.
 * `.st-id` is the pocket dialect's own `{#if view}`-gated element, the same
 * signal one step earlier in the same fetch.
 */
async function openSettings(page: Page) {
  await answerPushWithoutAService(page);
  await page.goto("/settings");
  const isMobile = test.info().project.name.startsWith("mobile");
  const loaded = isMobile ? page.locator(".st-id") : page.locator(".cards");
  await expect(loaded).toBeVisible({ timeout: 30_000 });
}

/**
 * A household, one item, and the signed-in member's own database id — the
 * three things the seeded deliveries below are foreign-keyed to.
 */
async function seedHouseholdAndItem(page: Page, name: string, itemTitle: string) {
  const householdId = randomUUID();
  const sectionId = randomUUID();
  const itemId = randomUUID();
  const { userId } = await page.evaluate(async ({ householdId, sectionId, itemId, householdName, itemTitle }) => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { user: { id: string }, csrfToken: string };
    const command = async (body: Record<string, unknown>) => {
      const response = await fetch("/api/workspace/commands", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`${String(body.type)} failed: ${response.status}`);
    };
    await command({
      type: "household.create",
      household: {
        id: householdId, name: householdName, timezone: "Europe/London", currency: "GBP",
        memberCount: 1, canManage: true, onboardingComplete: true,
        sections: [{ id: sectionId, name: "Home", icon: "home", accent: "sage", visible: true }],
        items: [],
      },
    });
    await command({
      type: "item.upsert",
      householdId,
      item: {
        id: itemId, sectionId, title: itemTitle, currency: "GBP",
        scheduleKind: "service", dueDate: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10),
        status: "active",
      },
      activity: { id: crypto.randomUUID(), itemId, kind: "created", occurredAt: new Date().toISOString() },
    });
    return { userId: session.user.id };
  }, { householdId, sectionId, itemId, householdName: name, itemTitle });
  return { householdId, itemId, userId };
}

test.describe.configure({ mode: "serial" });

test("a member sees their own last sent reminders, plainly, on both dialects", async ({ page, browser }) => {
  test.setTimeout(120_000);

  await claimInstanceAsAdministrator(browser);
  await signInAs(page, workerAccount("member"));
  const name = `Sent lately ${Date.now()}`;
  /* Named for this run alone, so the rows counted below can only be the
     ones this run seeded, whatever an earlier run on a reused stack left. */
  const itemTitle = `Boiler service ${Date.now().toString(36)}`;
  const { householdId, itemId, userId } = await seedHouseholdAndItem(page, name, itemTitle);

  /* #730: the panel shows a member's newest five attempted sends across
     every household, and scheduling a household for deletion leaves its
     sent and failed rows in place, so rows a run leaves behind push the
     next run's own rows out of that five. The rows this run inserts by SQL
     are removed by SQL, and in `finally`, so a failed run cleans up too. */
  try {
    const dueEventId = runSql(`select id from due_events where item_id = '${itemId}' order by due_date desc limit 1;`).trim();
    expect(dueEventId, "the item.upsert above should have raised its own due event").not.toBe("");

    const sentId = randomUUID();
    const failedId = randomUUID();
    const now = new Date();
    const scheduledFor = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();

    /* A clean send by email, and a failed one by push whose stored `lastError`
       is the worker's own category code (#1003: the row must never show that
       code, or any raw provider text, only the plain sentence it maps to). */
    runSql(`
      insert into notification_deliveries (id, household_id, event_id, user_id, channel, scheduled_for, status, attempts, sent_at, created_at, updated_at)
      values ('${sentId}', '${householdId}', '${dueEventId}', '${userId}', 'email', '${scheduledFor(2)}', 'sent', 1, '${scheduledFor(2)}', now(), now());
      insert into notification_deliveries (id, household_id, event_id, user_id, channel, scheduled_for, status, attempts, last_error, created_at, updated_at)
      values ('${failedId}', '${householdId}', '${dueEventId}', '${userId}', 'web_push', '${scheduledFor(1)}', 'failed', 5, 'smtp_unconfigured', now(), now());
    `);

    await openSettings(page);
    const isMobile = test.info().project.name.startsWith("mobile");
    const scope = isMobile ? page.locator(".st-pocket") : page.locator(".helm-page");
    const sentTab = scope.getByRole("tab", { name: "sent to you lately" });
    await sentTab.click();
    const panel = scope.getByRole("tabpanel", { name: "sent to you lately" });
    await expect(panel).toBeVisible();

    /* Newest first: the failed push send (1 day ago) leads the clean email
       send (2 days ago). */
    const rows = panel.locator("a", { hasText: itemTitle });
    await expect(rows).toHaveCount(2);
    /* Where a row says how its send went: inside the row's link on the desk;
       on the pocket dialect, in the line the kit draws under the row
       (Row.svelte's `below`), which is the next sibling of the row, not part
       of its link. */
    const outcome = (index: number) => isMobile
      ? panel.locator(".p-row", { hasText: itemTitle }).nth(index)
        .locator("xpath=following-sibling::*[1][contains(concat(' ', normalize-space(@class), ' '), ' p-row-below ')]")
      : rows.nth(index);
    await expect(outcome(0)).toContainText("couldn’t send");
    /* The plain sentence, never the raw category the row was stored with. */
    await expect(outcome(0)).toContainText("mail not set up");
    await expect(outcome(0)).not.toContainText("smtp_unconfigured");
    await expect(rows.nth(0)).not.toContainText("smtp_unconfigured");
    await expect(outcome(1)).not.toContainText("couldn’t send");

    /* The row leads to the item on the belt. */
    await rows.nth(1).click();
    await expect(page).toHaveURL(new RegExp(`/item/${itemId}`));
  } finally {
    runSql(`delete from notification_deliveries where household_id = '${householdId}';`);
    await scheduleHouseholdDeletion(page, householdId, name);
  }
});
