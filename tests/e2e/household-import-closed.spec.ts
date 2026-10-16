import { execFileSync } from "node:child_process";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { claimInstanceAsAdministrator } from "./support/bootstrap";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { sessionHeaders } from "./support/households";
import { waitForInvitationLink } from "./support/mail";
import { cleanup, seedHousehold, signIn, type Household } from "./support/signed-in";
import { answerPushWithoutAService } from "./support/webkit-push";
import { workerAccount, workerEmail } from "./support/worker-identity";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * #1316 (owner, 2026-10-14, question 13, answer 13a): while a household owner
 * brings an archive into a household, only THAT household is closed. Its other
 * members see a plain "closed for a moment" screen, every route of that
 * household answers 409 `household_import_in_progress`, and the household
 * they belong to besides stay open. The importer is not locked out of their
 * own import, and the closing is lifted the moment the import's start record
 * (portable_archive_imports) is closed.
 *
 * The import itself takes minutes on a large archive, so this spec does not
 * run one: it writes the start record the import writes, with the same SQL
 * helper tests/e2e/settings-notification-history.spec.ts uses, and holds the
 * state still while the member's screens are read. The administrator's own
 * archive round trip in v19-archive.spec.ts is the guard that a real import
 * still completes.
 *
 * Runs on both layouts (desktop-chromium and mobile-chromium): the closed
 * screen is a screen people see, and the pocket has its own dialect.
 */

const CLOSED_CODE = "household_import_in_progress";
const CLOSED_MESSAGE = "This household's owner is bringing in an archive. Come back when it's finished.";

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
  if (!container) throw new Error("#1316 spec: no orbit-db container for this stack -- is it up?");
  return execFileSync(
    "docker",
    ["exec", "-i", container, "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q -t -A -f -'],
    { input: statements, encoding: "utf8", timeout: 60_000 },
  );
}

let adminContext: BrowserContext | undefined;
let adminPage: Page;
let memberContext: BrowserContext | undefined;
let memberPage: Page;
let household: Household | undefined;

/** The member accepts the mailed invitation in their own browser context. */
async function inviteMember(browser: Browser, owner: Page, target: Household) {
  const headers = await sessionHeaders(owner);
  const sent = await owner.request.post(`/api/households/${target.id}/invitations`, {
    headers,
    data: { email: workerEmail("member") },
  });
  expect(sent.ok(), `invitation send failed: ${sent.status()}`).toBe(true);
  const link = await waitForInvitationLink(workerEmail("member"), target.name);
  expect(link).toMatch(/\/invite\//u);

  memberContext = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: "reduce" });
  memberPage = await memberContext.newPage();
  await answerPushWithoutAService(memberPage);
  await memberPage.goto(link);
  await memberPage.getByRole("link", { name: workerAccount("member") }).click();
  await expect(memberPage).toHaveURL(/\/home$/, { timeout: 30_000 });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  await claimInstanceAsAdministrator(browser);

  adminContext = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: "reduce" });
  adminPage = await adminContext.newPage();
  await signIn(adminPage, "/home");
  household = await seedHousehold(adminPage, "import-closed", { withItem: true });
  await inviteMember(browser, adminPage, household);

  /* The administrator's user id, as the session itself reports it. */
  const session = await adminPage.request.get("/api/auth/session");
  expect(session.ok()).toBe(true);
  const { user } = (await session.json()) as { user: { id: string } };

  /* The start record an import writes when its metadata commits: this
     household, the importer, now, not finished. */
  runSql(`
    insert into portable_archive_imports (household_id, actor_user_id, started_at, finished_at, created_section_ids, created_item_ids)
    values ('${household.id}', '${user.id}', now(), null, '{}', '{}');
  `);
});

test.afterAll(async () => {
  try {
    if (household) {
      runSql(`delete from portable_archive_imports where household_id = '${household.id}';`);
      await cleanup(adminPage, household);
    }
  } finally {
    await memberContext?.close();
    await adminContext?.close();
  }
});

test("a. the member's home says the household is closed for a moment and shows none of it", async () => {
  const target = household!;
  await memberPage.goto("/home");
  await expect(memberPage.getByRole("heading", { name: `${target.name} is closed for a moment` })).toBeVisible({ timeout: 30_000 });
  /* Home draws both layouts and CSS shows one, so the notice is in the page twice. */
  await expect(memberPage.getByText("Its owner is bringing an archive in.").filter({ visible: true })).toBeVisible();
  await expect(memberPage.getByText(target.itemTitle!)).toHaveCount(0);
  /* This household is the member's only one, so nothing is open beside it to point at. */
  await expect(memberPage.getByText("Your other households are open as usual.")).toHaveCount(0);
});

test("b. the household's API refuses the member with 409 and the plain words, no retry-after", async () => {
  const target = household!;
  const response = await memberPage.request.get(`/api/households/${target.id}/members`);
  expect(response.status()).toBe(409);
  const body = (await response.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe(CLOSED_CODE);
  expect(body.error.message).toBe(CLOSED_MESSAGE);
  expect(response.headers()["retry-after"]).toBeUndefined();
});

test("c. the household's own screen shows the same heading and a back-to-home link that fits the phone", async ({ isMobile }) => {
  const target = household!;
  await memberPage.goto(`/household/${target.id}`);
  await expect(memberPage.getByRole("heading", { name: `${target.name} is closed for a moment` })).toBeVisible({ timeout: 30_000 });
  const back = memberPage.getByRole("link", { name: /back to home/i });
  await expect(back).toBeVisible();
  await expect(memberPage.getByText(target.itemTitle!)).toHaveCount(0);

  if (isMobile) {
    const box = await back.boundingBox();
    expect(box?.height ?? 0, "the back-to-home link is at least 44px tall on the phone").toBeGreaterThanOrEqual(44);
    const viewport = await memberPage.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(viewport.scrollWidth).toBe(viewport.clientWidth);
  }
});

test("d. the importer is not shut out: the administrator's API answers 200 and their home still shows the item", async () => {
  const target = household!;
  const response = await adminPage.request.get(`/api/households/${target.id}/members`);
  expect(response.status()).toBe(200);
  await adminPage.goto("/home");
  await expect(adminPage.getByText(target.itemTitle!).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
});

test("e. when the start record is closed the household opens again for the member", async () => {
  const target = household!;
  runSql(`update portable_archive_imports set finished_at = now(), outcome = 'rolled_back' where household_id = '${target.id}' and finished_at is null;`);

  const response = await memberPage.request.get(`/api/households/${target.id}/members`);
  expect(response.status()).toBe(200);
  await memberPage.goto("/home");
  await expect(memberPage.getByText(target.itemTitle!).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(memberPage.getByRole("heading", { name: `${target.name} is closed for a moment` })).toHaveCount(0);
});
