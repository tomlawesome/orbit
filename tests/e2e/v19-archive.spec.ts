import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { settleArrival } from "./support/arrival";
import { cleanupHousehold, sessionHeaders } from "./support/households";
import { ensureLocalPassword } from "./support/local-credentials";
import { ensureWorkerAdministrator, workerAccount, workerFixturePassword } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * #1002 — the desk archive card: export, preview and import, built from
 * DeskArchive.svelte, which reuses PocketArchive.svelte's server calls
 * (#1122) under the desk's own card grammar.
 *
 * UNRUN, to the same pattern v19-section-marks.spec.ts's own UNRUN note
 * describes: this needs the docker-compose stack (a real Postgres and a
 * signed-in session) the way every other tests/e2e spec does, and standing
 * that up was out of scope for the session that wrote it. Written to the
 * same `signIn`/`seedHousehold`/cleanup pattern, so it should run unmodified
 * once the stack is available — `pnpm test:e2e -- v19-archive`.
 */

test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, "desktop archive card only; the pocket dialect is #1122's own file");
});

/* #1080: this worker's own administrator, resolved lazily (worker env only). */
const READER = () => workerAccount("administrator");
/* A passphrase Orbit's own floor (12 chars) accepts, for every archive this file writes. */
const PASSPHRASE = "correct-horse-battery-staple";
/* sign-in-methods.spec.ts's own fixed value for this account (#915/#1080):
   ensureLocalPassword is idempotent only while every caller sends the same
   password, so this file uses the same formula rather than inventing one. */
const READER_PASSWORD = () => workerFixturePassword(READER());

async function signIn(page: Page, returnTo: string) {
  await page.goto(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("link", { name: READER() }).click();
  /* #1183, #1096's race: the reader has no household yet, so this lands on
     the arrival, and the seed below turns its pending decision onward -- its
     location.replace to /home then aborted ensureLocalPassword's page.goto
     (NS_BINDING_ABORTED on desktop-firefox). Let the arrival land first. */
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
}

/**
 * fix/1132-archive-step-up (ancestor of this branch): writing or bringing in
 * an archive hands over the whole household, so DeskArchive.svelte always
 * re-challenges with recent-authentication before either act runs
 * (src/lib/auth/recent-auth.ts -- ADR-0023 §5 ships no freshness window, so a
 * signed-in-a-moment-ago session is not exempt). An OIDC-only account can
 * only answer that with a password set through a real step-up, so this
 * establishes one the same way sign-in-methods.spec.ts does, before either
 * archive act below hits the challenge.
 *
 * Called after seedHousehold, not from signIn: ensureLocalPassword's own
 * step-up comes back to /settings, which sends a reader with no household
 * anywhere to the arrival instead (#840) -- the worker's own administrator
 * identity is promoted by ensureWorkerAdministrator, not seated in a
 * household, so it needs the first household this file seeds before this can
 * round-trip successfully.
 */
async function ensureReaderCanAnswerTheChallenge(page: Page) {
  await ensureLocalPassword(page, READER(), READER_PASSWORD());
}

/**
 * Answers DeskArchive.svelte's inline "sign in again" challenge, opened by
 * the export or import act just fired, and waits for it to close.
 *
 * Scoped to `.c-archive`, not a bare `getByLabel`: PocketArchive.svelte's own
 * copy of this same challenge, on the same page (chosen by CSS, like
 * settings' two dialects), labels its password field "your password" too
 * (`#hh-proof`), and a page-wide `getByLabel("your password")` locks onto
 * whichever one it resolves first -- here, the hidden pocket one -- and then
 * only re-checks THAT element's own visibility, never re-querying the page,
 * so it retried forever waiting for an input that was never going to open
 * and ran out the clock in the test's own teardown instead of failing at the
 * point that was actually stuck.
 */
async function answerArchiveChallenge(page: Page) {
  const challenge = page.locator(".c-archive .challenge");
  await challenge.getByLabel("your password").fill(READER_PASSWORD());
  await challenge.getByRole("button", { name: "confirm and carry on" }).click();
  await expect(challenge).toHaveCount(0);
}

/**
 * A household with the real default section and the item titles this file
 * asks for, each carrying a genuine due date so `entries` is > 0 on the
 * archive card's manifest.
 */
async function seedHousehold(page: Page, itemTitles: string[]) {
  const name = `archive-${randomUUID()}`;
  const householdId = randomUUID();
  /* item.upsert's own sectionId must be a real UUID (workspace-access.ts's
     requireUuid) -- household.create silently swaps any non-UUID section id
     for a generated one (same file), so a literal "home" here would seed the
     section under one id and then have every item.upsert below refused
     (422 invalid_identifier) trying to address it by the id we asked for
     rather than the id it actually got. Every other spec's seed generates
     this id for the same reason (see v19-create.spec.ts and the rest). */
  const sectionId = randomUUID();
  const headers = { ...(await sessionHeaders(page)), "content-type": "application/json" };
  const created = await page.request.post("/api/workspace/commands", {
    headers,
    data: {
      type: "household.create",
      household: {
        id: householdId, name, timezone: "Europe/London", currency: "GBP",
        memberCount: 1, canManage: true, onboardingComplete: true,
        sections: [{ id: sectionId, name: "Home", icon: "home", accent: "sage", visible: true }],
        items: [],
      },
    },
  });
  if (!created.ok()) throw new Error(`#1002: could not seed household "${name}" (${created.status()})`);

  const dueDate = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  for (const title of itemTitles) {
    const itemId = randomUUID();
    const itemCreated = await page.request.post("/api/workspace/commands", {
      headers,
      data: {
        type: "item.upsert",
        householdId,
        item: {
          id: itemId, sectionId, title, currency: "GBP",
          scheduleKind: "service", dueDate, recurrenceMonths: 12, status: "active",
        },
        activity: { id: randomUUID(), itemId, kind: "created", occurredAt: new Date().toISOString() },
      },
    });
    if (!itemCreated.ok()) throw new Error(`#1002: could not seed item "${title}" (${itemCreated.status()})`);
  }
  return { id: householdId, name };
}

async function cleanup(page: Page, household: { id: string; name: string }) {
  await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
}

test("write an archive, then bring it into a second household — a clash stays out", async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page, "/home");
  const source = await seedHousehold(page, ["Boiler service", "Car insurance"]);
  await ensureReaderCanAnswerTheChallenge(page);
  /* The clash: a household that already holds an entry with the same title
     (case-insensitive, portable-archive-repository.ts's own rule). */
  const target = await seedHousehold(page, ["Boiler service"]);
  const scratch = mkdtempSync(path.join(tmpdir(), "orbit-archive-e2e-"));
  try {
    // ── write it ──────────────────────────────────────────────────────────
    await page.goto(`/household/${source.id}`);
    await expect(page.locator(".c-archive")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".c-archive .man li").first()).toContainText("2"); // 2 entries

    await page.getByRole("button", { name: "write an archive →" }).click();
    await page.getByLabel("a passphrase for the file").fill(PASSPHRASE);
    await page.getByLabel("the passphrase again").fill("a-different-phrase-entirely");
    await expect(page.locator(".c-archive .refuse")).toBeVisible();
    await page.getByLabel("the passphrase again").fill(PASSPHRASE);

    const writeButton = page.getByRole("button", { name: "write the archive" });
    await expect(writeButton).toBeEnabled();
    await writeButton.click(); // arm
    await page.getByRole("button", { name: "tap again to write the archive" }).click(); // fire
    await answerArchiveChallenge(page);
    await expect(page.locator(".c-archive .said.show")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".c-archive .said.show")).toContainText("written · orbit-archive.json");

    const downloadHref = await page.getByRole("link", { name: "download the file" }).getAttribute("href");
    expect(downloadHref).toBeTruthy();
    const downloaded = await page.request.get(downloadHref as string);
    expect(downloaded.ok()).toBe(true);
    const archivePath = path.join(scratch, "orbit-archive.json");
    writeFileSync(archivePath, await downloaded.body());

    // ── bring it in ──────────────────────────────────────────────────────
    await page.goto(`/household/${target.id}`);
    await expect(page.locator(".c-archive")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("tab", { name: "bring one in" }).click();
    await page.getByRole("button", { name: "bring in an archive →" }).click();
    await page.locator('.c-archive input[type="file"]').setInputFiles(archivePath);
    await page.getByLabel("the file's passphrase").fill(PASSPHRASE);
    await page.getByRole("button", { name: "look inside" }).click();

    const preview = page.locator(".c-archive .inside");
    await expect(preview).toBeVisible({ timeout: 15_000 });
    await expect(preview.locator(".dup li")).toContainText("Boiler service");
    await expect(preview.locator(".dup li")).toContainText("already here · stays out");

    const bringButton = page.getByRole("button", { name: "bring in 1 entry" });
    await bringButton.click(); // arm
    await page.getByRole("button", { name: "tap again to bring in 1 entry" }).click(); // fire
    /* A fresh challenge: archive_export's proof cannot pay for archive_import
       (recent-auth.ts binds a proof to the one intent it was taken for). */
    await answerArchiveChallenge(page);
    await expect(page.locator(".c-archive .said.show")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".c-archive .said.show")).toContainText(`brought in 1 entry from ${source.name}`);

    // ── the entry that was not a clash actually landed ──────────────────
    await page.goto("/home");
    await expect(page.locator(".item", { hasText: "Car insurance" })).toBeVisible({ timeout: 30_000 });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    await cleanup(page, source);
    await cleanup(page, target);
  }
});

test("a wrong passphrase is refused, and nothing is read", async ({ page }) => {
  test.setTimeout(60_000);
  await signIn(page, "/home");
  const source = await seedHousehold(page, ["Boiler service"]);
  await ensureReaderCanAnswerTheChallenge(page);
  const scratch = mkdtempSync(path.join(tmpdir(), "orbit-archive-e2e-"));
  try {
    await page.goto(`/household/${source.id}`);
    await expect(page.locator(".c-archive")).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "write an archive →" }).click();
    await page.getByLabel("a passphrase for the file").fill(PASSPHRASE);
    await page.getByLabel("the passphrase again").fill(PASSPHRASE);
    await page.getByRole("button", { name: "write the archive" }).click();
    await page.getByRole("button", { name: "tap again to write the archive" }).click();
    await answerArchiveChallenge(page);
    await expect(page.locator(".c-archive .said.show")).toBeVisible({ timeout: 15_000 });

    const downloadHref = await page.getByRole("link", { name: "download the file" }).getAttribute("href");
    const downloaded = await page.request.get(downloadHref as string);
    const archivePath = path.join(scratch, "orbit-archive.json");
    writeFileSync(archivePath, await downloaded.body());

    await page.getByRole("tab", { name: "bring one in" }).click();
    await page.getByRole("button", { name: "bring in an archive →" }).click();
    await page.locator('.c-archive input[type="file"]').setInputFiles(archivePath);
    await page.getByLabel("the file's passphrase").fill("not-the-right-phrase-at-all");
    await page.getByRole("button", { name: "look inside" }).click();

    await expect(page.locator(".c-archive .refuse")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".c-archive .refuse")).toContainText("The passphrase or archive is invalid");
    // Refused, not merely unread: the preview never appears.
    await expect(page.locator(".c-archive .inside")).toHaveCount(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    await cleanup(page, source);
  }
});
