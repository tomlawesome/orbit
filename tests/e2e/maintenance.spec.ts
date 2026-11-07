import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { sessionHeaders } from "./support/households";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { signIn } from "./support/signed-in";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/*
 * The maintenance page people actually see (#526; ADR-0013 decisions 2, 3, 4
 * and 8).
 *
 * One window is opened for the whole file by the instance administrator and
 * ended again at the end, whatever happened in between: these specs share one
 * instance, and a window left open would close every screen for every spec
 * that runs after this one. Serial, so the shared window's state is the one
 * each test expects.
 */
test.describe.configure({ mode: "serial" });

const STARTED = "We are moving Orbit to new storage. Documents and mail are paused while everything copies across.";

async function signInAs(page: Page, account: string) {
  /* settle: false -- this file's sign-in may land on a maintenance window an
     earlier run left up, which settleArrival would wait on for ever. */
  await signIn(page, { account, settle: false, holdAdministrator: false });
  /* Not a fixed destination: #840 sends a session with no household of its
     own to the arrival at `/` instead of /home, and this file's very first
     sign-in is the instance's first-ever administrator on what may still be
     a genuinely empty database -- exactly that reader. Every caller here
     only needs an authenticated session (the API calls below carry it
     regardless of which page is showing); the maintenance-screen assertions
     that DO care what is on screen check for their own heading, not a URL. */
  const session = await page.request.get("/api/auth/session", { maxRetries: 2 });
  expect(session.ok(), `sign-in as ${account} did not establish a session`).toBe(true);
}

type MaintenanceState = { version: number; effectivelyActive: boolean };

async function readState(page: Page): Promise<MaintenanceState> {
  const response = await page.request.get("/api/admin/maintenance", { maxRetries: 2 });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { maintenance: MaintenanceState }).maintenance;
}

async function command(page: Page, body: Record<string, unknown>) {
  const { version } = await readState(page);
  const response = await page.request.post("/api/admin/maintenance", {
    headers: await sessionHeaders(page),
    data: { ...body, expectedVersion: version },
  });
  expect(response.status(), await response.text()).toBe(200);
}

let admin: BrowserContext;
let adminPage: Page;

async function openWindow(browser: Browser) {
  admin = await browser.newContext({ ignoreHTTPSErrors: true });
  adminPage = await admin.newPage();
  await signInAs(adminPage, workerAccount("administrator"));
  /* #1080: the maintenance commands are an instance-admin power. */
  await ensureWorkerAdministrator(adminPage);
  if ((await readState(adminPage)).effectivelyActive) {
    await command(adminPage, { action: "end" });
  }
  await command(adminPage, {
    action: "activate",
    message: STARTED,
    expectedEndAt: new Date(Date.now() + 45 * 60_000).toISOString(),
  });
}

test.beforeAll(async ({ browser }) => {
  await openWindow(browser);
});

test.afterAll(async () => {
  if ((await readState(adminPage)).effectivelyActive) {
    await command(adminPage, { action: "end" });
  }
  await admin.close();
});

/* What the screen shows (one entry with no drawer, newest first with the
   earlier ones opening from the keyboard, axe, the phone's width) moved to the
   rig (ADR-0039, #1610): web/tests/rig/maintenance.spec.js, against the fixture
   window. What the server answers while the window is open -- the screen at the
   asked-for URL with 503 and no-store, the arrival closed, /login and /logout
   open, /maintenance itself, the administrator passing, a member shown the
   screen -- moved to tests/unit/hooks-server-maintenance-screens.test.mjs
   (#1612); the API's 503 envelope is proved in
   tests/integration/maintenance-guard.test.ts. What is left here is the window
   itself, end to end: ending it through the admin command against the real
   server. */

test("ending the window reopens the instance at the same URL", async ({ request }) => {
  await command(adminPage, { action: "end", message: "Back." });
  const response = await request.get("/home", { maxRetries: 2, maxRedirects: 0 });
  // Signed out, so the ordinary gate takes over: the door, not the eclipse.
  expect(response.status()).toBe(303);
  expect(response.headers()["location"]).toBe("/login?returnTo=%2Fhome");
});
