import { expect, test, type Page } from "@playwright/test";

/**
 * #479: the settings screen's reminder pair is dispatch truth, not only
 * displayed truth (src/server/reminder-settings.ts's own docstring) — since
 * #479 the notification worker schedules an item's reminders from the
 * recipient's own stored firstWarningDays/finalWarningDays whenever the item
 * carries no offsets of its own (effectiveReminderOffsets in
 * src/server/notification-worker.ts). Proving delivery TIMING itself needs a
 * clock and a mailbox, which is the integration suite's job and is already
 * green; this browser journey's honest claim is narrower and is exactly what
 * a browser can prove: the signed-in reader's write lands in the same place
 * the API read — and the screen — both answer from.
 *
 * The ratified settings screen (design/v19/settings.html, §13) draws the
 * pair as two VALUES with no day-picker (a timing editor is undrawn by
 * design — see reminder-settings.ts and web/src/routes/settings/+page.svelte)
 * and, at this commit, that screen is not yet the one the composite entry
 * serves at /settings (scripts/v19-dispatch.mjs keeps /settings on the
 * retiring engine until those journeys exist v19-side, #453). So this
 * journey writes the pair through the same route the settings screen itself
 * calls (PUT /api/settings/reminders) and proves a fresh GET reads back the
 * exact pair just written.
 *
 * The one workspace assertion ties emailEnabled — the half of the pair a
 * control actually exists for — to GET /api/auth/session, the same
 * authenticated-identity read the workspace shell makes on every load
 * (src/lib/auth/session.ts queries userPreferences.emailNotifications fresh
 * each time; PUT /api/preferences writes the identical column). It
 * deliberately does not read the dashboard's own "Email reminders" toggle:
 * that control is fed through usePersistedThemePreference
 * (src/components/appearance-preference.ts), which mirrors the appearance
 * columns into localStorage once per browser session and, found in writing
 * this journey, does not get invalidated by a write through the reminders
 * route — a real seam between two write paths to one column, worth its own
 * issue, but not one a settings-pair journey should paper over by reaching
 * into that cache's storage keys to force it to agree.
 */

async function signIn(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("link", { name: "Sign in securely" }).click();
  await page.getByRole("link", { name: "Orbit Administrator" }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:3000\/workspace$/);
}

async function csrfHeaders(page: Page) {
  const sessionResponse = await page.request.get("/api/auth/session");
  expect(sessionResponse.ok()).toBeTruthy();
  const session = (await sessionResponse.json()) as { csrfToken: string };
  return { Origin: new URL(page.url()).origin, "X-CSRF-Token": session.csrfToken };
}

interface ReminderPair {
  emailEnabled: boolean;
  firstWarningDays: number;
  finalWarningDays: number;
}

test.describe("reminder timing settings", () => {
  test("the pair the settings screen stores is the pair the API reads back (#479)", async ({ page, isMobile }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");
    test.skip(isMobile, "The write path has no device-specific behaviour; one project proves it.");

    await signIn(page);
    const headers = await csrfHeaders(page);

    // A pair unmistakably not the column defaults (14/3), so a stale read
    // could never be confused for the one this journey just wrote.
    const pair: ReminderPair = { emailEnabled: true, firstWarningDays: 21, finalWarningDays: 5 };

    const writeResponse = await page.request.put("/api/settings/reminders", { headers, data: pair });
    expect(writeResponse.ok()).toBeTruthy();
    const written = (await writeResponse.json()) as { reminders: ReminderPair };
    expect(written.reminders).toMatchObject(pair);

    // The round trip: a fresh GET, not the write's own echo, reads back the
    // same pair — proof that it is stored, not only accepted.
    const readResponse = await page.request.get("/api/settings/reminders");
    expect(readResponse.ok()).toBeTruthy();
    const read = (await readResponse.json()) as { reminders: ReminderPair };
    expect(read.reminders).toMatchObject(pair);

    // One workspace assertion: the authenticated-identity read the workspace
    // shell makes on every load agrees with the half of the pair a reader
    // can see anywhere today.
    const sessionResponse = await page.request.get("/api/auth/session");
    expect(sessionResponse.ok()).toBeTruthy();
    const session = (await sessionResponse.json()) as { user: { emailNotifications: boolean } };
    expect(session.user.emailNotifications).toBe(pair.emailEnabled);

    // Flip the shared column off through the reminders route and require
    // that same identity read, fetched fresh rather than cached, to agree —
    // closing the loop the other direction too.
    const offResponse = await page.request.put("/api/settings/reminders", {
      headers,
      data: { ...pair, emailEnabled: false },
    });
    expect(offResponse.ok()).toBeTruthy();
    const sessionAfterOff = (await (await page.request.get("/api/auth/session")).json()) as { user: { emailNotifications: boolean } };
    expect(sessionAfterOff.user.emailNotifications).toBe(false);
  });

  test("rejects a final warning that is not closer than the first (#479)", async ({ page, isMobile }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");
    test.skip(isMobile, "The validation boundary does not vary by viewport.");

    await signIn(page);
    const headers = await csrfHeaders(page);

    const response = await page.request.put("/api/settings/reminders", {
      headers,
      data: { emailEnabled: true, firstWarningDays: 5, finalWarningDays: 5 },
    });
    expect(response.status()).toBe(422);
  });
});
