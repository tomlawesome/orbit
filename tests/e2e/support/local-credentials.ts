import { expect, type Page } from "@playwright/test";
import { sessionHeaders } from "./households";

/**
 * Giving the signed-in reader a password, through the API, because no screen
 * can yet do it for them (#915, ADR-0023 §5).
 *
 * Everything sensitive in M7 re-challenges the person in front of the screen,
 * and which challenge they get depends on what they already have: a password
 * answers with itself, and an account with only a provider identity has to go
 * back to that provider and be authenticated again. So the very first password
 * on an OIDC account can only be set from the far side of a step-up — which is
 * why a spec that wants to exercise the ordinary, password-challenged journeys
 * has to walk one first.
 *
 * A browser cannot start that step-up on its own yet: `POST
 * /api/auth/step-up/start` needs the per-session CSRF header, which only
 * `fetch` can set, and answers a bare 302 to the provider, which `fetch`
 * cannot read. Playwright's own request context is under no such rule — it
 * shares this browser's cookies and will hand back the `Location` — so the
 * helper below drives the operator's real path with it: start the step-up,
 * follow it to the provider, authenticate, come back, and set the password.
 * Nothing here is a test-only hook in the shipped image; every route it
 * touches is the one a screen will call.
 *
 * IDEMPOTENT, because CI retries whole files and the specs share one instance.
 * `password` is sent as BOTH the new password and the current one, so the
 * guard is satisfied whichever challenge it chooses: the step-up proof for an
 * account with no credential yet, that same password for one that already has
 * it. Calling this twice leaves exactly the state calling it once does.
 *
 * The page must already be on an Orbit URL: the CSRF pair is read from the
 * session this browser is holding, and its Origin from where the page is.
 */
export async function ensureLocalPassword(page: Page, account: string, password: string): Promise<void> {
  const started = await page.request.post("/api/auth/step-up/start", {
    headers: await sessionHeaders(page),
    maxRedirects: 0,
    data: { intent: "password_set", returnTo: "/settings" },
  });
  expect(started.status(), "the step-up did not start").toBe(302);
  const provider = started.headers()["location"];
  expect(provider, "the step-up named no provider to go to").toBeTruthy();

  await page.goto(provider);
  await page.getByRole("link", { name: account }).click();
  /* The callback mints the proof and sends the browser back to `returnTo`. */
  await page.waitForURL(/\/settings/, { timeout: 20_000 });

  const set = await page.request.post("/api/auth/local/password", {
    /* Read again, not reused: setting a password that REPLACES one revokes
       every session and re-issues this browser's, so the token from before
       the call is a dead letter by the time the next request needs one. */
    headers: await sessionHeaders(page),
    data: { password, currentPassword: password },
  });
  expect(set.ok(), `the password was refused (HTTP ${set.status()})`).toBe(true);
}
