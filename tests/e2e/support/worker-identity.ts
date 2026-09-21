import type { Page } from "@playwright/test";
import { claimInstanceAsAdministrator } from "./bootstrap";
import { sessionHeaders } from "./households";

/**
 * #1080: one administrator per Playwright worker.
 *
 * The suite used to run on one worker because every spec signed in as the
 * same "Orbit Administrator" and so shared one sky: anything a spec left
 * behind joined the next spec's drawn set (#730, #711). The owner's ruling
 * is one administrator PER WORKER — not per spec, and no extra stacks — so
 * each worker signs in as its own identity and sees only what its own specs
 * made.
 *
 * The identities are ordinary accounts. tests/oidc/server.mjs carries a
 * fixed identity set per worker slot ("Orbit W3 Administrator", "Orbit W3
 * Member", ...), a first sign-in creates the account exactly as any OIDC
 * sign-in does, and `ensureWorkerAdministrator` below has the instance's
 * FIRST administrator — the one the claim made (ADR-0022) — grant
 * `isInstanceAdmin` through the administration API's own route
 * (PUT /api/admin/users, src/server/admin-repository.ts). No test-only hook
 * enters the shipped image.
 *
 * Keyed on TEST_PARALLEL_INDEX, not TEST_WORKER_INDEX: the worker index
 * grows every time Playwright replaces a worker (a crash, a serial-mode
 * retry), while the parallel index stays within 0..workers-1 — so a retried
 * file signs in as a real, already-provisioned identity rather than minting
 * a new account per attempt, and the account population stays bounded
 * (#1077).
 *
 * Promotion is LAZY and idempotent, on the households.ts principle that
 * failure must be loud: every helper here throws rather than falling back.
 * Lazy matters because the database may be reset between spec files
 * (#1077): whatever a reset removes, the next sign-in recreates the account
 * and the next `ensureWorkerAdministrator` restores the grant, through the
 * same two real routes.
 */

/** How many identity sets tests/oidc/server.mjs carries. Not the worker
 * count — playwright.config.ts decides that — but its ceiling. */
export const WORKER_IDENTITY_SETS = 8;

export type WorkerRole = "administrator" | "member" | "outsider" | "newcomer" | "doorstep";

function parallelIndex(): number {
  const raw = process.env.TEST_PARALLEL_INDEX;
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `#1080: TEST_PARALLEL_INDEX is "${raw}" — worker identities exist only inside Playwright's worker processes`,
    );
  }
  if (index >= WORKER_IDENTITY_SETS) {
    throw new Error(
      `#1080: parallel index ${index} has no identity set — tests/oidc/server.mjs carries ${WORKER_IDENTITY_SETS}; add sets there before raising the worker count`,
    );
  }
  return index;
}

/** This worker's name for a role, matching tests/oidc/server.mjs exactly.
 * No name here is a substring of any other identity's name, because
 * getByRole's `name` matches substrings by default and the provider's
 * chooser lists every identity at once. */
export function workerAccount(role: WorkerRole): string {
  const titles: Record<WorkerRole, string> = {
    administrator: "Administrator",
    member: "Member",
    outsider: "Outsider",
    newcomer: "Newcomer",
    doorstep: "Doorstep",
  };
  return `Orbit W${parallelIndex()} ${titles[role]}`;
}

/** This worker's email for a role, matching tests/oidc/server.mjs exactly —
 * the address invitation and verification mail for this identity lands on
 * in GreenMail, so per-worker identities also mean per-worker mailboxes. */
export function workerEmail(role: WorkerRole): string {
  return `w${parallelIndex()}-${role}@example.test`;
}

/**
 * An address for an account a SPEC makes, rather than one the provider
 * carries: the same `w<slot>-` namespace, so the administration roster -- the
 * one list per-worker identities cannot unshare -- says which worker each row
 * belongs to, and two workers minting the same fixture in the same
 * millisecond cannot collide on the unique address index.
 */
export function workerScopedAddress(local: string): string {
  return `w${parallelIndex()}-${local}@example.invalid`;
}

/**
 * THE ONE PASSWORD an account ever gets from a spec (the FIXTURE_PASSWORD
 * rule, support/local-credentials.ts): deterministic from the account name,
 * so every file that gives this worker's identity a password gives it the
 * same one and `ensureLocalPassword` stays idempotent.
 */
export function workerFixturePassword(account: string): string {
  return `e2e-${account.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}-fixture-1080`;
}

/**
 * Makes the signed-in reader on `page` an instance administrator, through
 * the real path: probe the administration API as them, and where it refuses,
 * have the claimed first administrator grant the flag from their own
 * signed-in context. The grant is per-request state (maintenance.ts reads
 * `isInstanceAdmin` uncached), so the page's existing session holds the
 * power the moment the PUT lands — no re-sign-in.
 *
 * Safe under concurrency: a parallel worker doing the same thing serialises
 * on admin-repository.ts's advisory lock, and a claim raced by another
 * worker is a 409 the claim path already treats as success.
 */
/**
 * The chooser click starts a redirect chain through the provider and back
 * through /api/auth/callback, which is what actually sets the session
 * cookie — a probe fired straight after the click races it
 * (v19-screen-reader.spec.ts documents the same race). Wait for the session
 * to say `authenticated` before asking anything that needs it.
 */
async function waitForAuthenticatedSession(page: Page, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await page.request.get("/api/auth/session");
    if (response.ok()) {
      const session = (await response.json()) as { authenticated?: boolean };
      if (session.authenticated) return;
    }
    if (Date.now() > deadline) {
      throw new Error(`#1080: no authenticated session within ${timeoutMs}ms of the sign-in click`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Records this worker's reader as having already taken the first-run walk,
 * through the route "take the walk again" writes.
 *
 * #1077 does exactly this for the instance's FIRST administrator, before it
 * takes the seed, and its commit says why: without it the tour card goes up
 * over /home in file after file and covers the controls specs click --
 * v19-mail-review timed out twice that way. The worker identities are not in
 * that seed. They are made by their own first sign-in and taken away again by
 * the next reset, so each one meets /home as a reader who has never seen the
 * walk unless this puts the record back.
 *
 * The three files whose subject IS the walk are unaffected: each sets the
 * record to null itself after signing in (v19-tour.spec.ts, and
 * v19-axe-sweep/v19-screen-reader do the same), rather than relying on it
 * never having been written.
 *
 * ONLY WHEN THERE IS NOTHING THERE, which is not an optimisation. The record
 * is a timestamp, and v19-tour journey 2 proves a skip holds across a new
 * sign-in by asserting the SAME timestamp comes back in a second browser --
 * so writing a fresh one on every sign-in fails that journey, as it did the
 * first time this was written. The seed writes it once for the first
 * administrator; this writes it once for each worker's.
 */
async function recordWalkTaken(page: Page): Promise<void> {
  const current = await page.request.get("/api/settings/tour");
  if (!current.ok()) {
    throw new Error(`#1080: this worker's reader could not read the walk record (HTTP ${current.status()})`);
  }
  const { tour } = (await current.json()) as { tour?: { tourSeenAt: string | null } };
  if (tour?.tourSeenAt) return;

  const recorded = await page.request.put("/api/settings/tour", {
    headers: await sessionHeaders(page),
    data: { tourSeenAt: new Date().toISOString() },
  });
  if (!recorded.ok()) {
    throw new Error(`#1080: this worker's reader could not record the walk as taken (HTTP ${recorded.status()})`);
  }
}

export async function ensureWorkerAdministrator(page: Page): Promise<void> {
  await waitForAuthenticatedSession(page);
  await recordWalkTaken(page);
  const probe = await page.request.get("/api/admin/users");
  if (probe.ok()) return;
  if (probe.status() !== 403) {
    throw new Error(`#1080: the administration probe answered HTTP ${probe.status()}, not 200 or 403`);
  }

  const browser = page.context().browser();
  if (!browser) throw new Error("#1080: this page has no browser to open the first administrator's context from");
  const email = workerEmail("administrator");

  await claimInstanceAsAdministrator(browser, {
    afterSignIn: async (primary) => {
      const listed = await primary.request.get("/api/admin/users");
      if (!listed.ok()) {
        throw new Error(`#1080: the first administrator could not list accounts (HTTP ${listed.status()})`);
      }
      const { users } = (await listed.json()) as {
        users: { id: string; email: string | null; isInstanceAdmin: boolean }[];
      };
      const target = users.find((one) => one.email === email);
      if (!target) {
        throw new Error(`#1080: no account for ${email} — the worker administrator must sign in before promotion`);
      }
      if (!target.isInstanceAdmin) {
        const granted = await primary.request.put("/api/admin/users", {
          headers: await sessionHeaders(primary),
          data: { userId: target.id, administrator: true },
        });
        if (!granted.ok()) {
          throw new Error(`#1080: promoting ${email} was refused (HTTP ${granted.status()})`);
        }
      }
    },
  });

  const again = await page.request.get("/api/admin/users");
  if (!again.ok()) {
    throw new Error(`#1080: ${email} is still not an administrator after promotion (HTTP ${again.status()})`);
  }
}

/**
 * The whole journey most specs need: sign in as this worker's administrator
 * through the provider's chooser, prove the session, and hold administrator
 * access. Callers that need the arrival settled or a particular landing
 * still do that themselves — this establishes identity, not location.
 */
export async function signInAsWorkerAdministrator(page: Page, returnTo = "/home"): Promise<string> {
  const account = workerAccount("administrator");
  await page.goto(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("link", { name: account }).click();
  /* Waits for the session itself before anything needs it. */
  await ensureWorkerAdministrator(page);
  return account;
}
