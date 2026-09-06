import type { Page } from "@playwright/test";

/**
 * #840: wait for the arrival at `/` to finish deciding before doing anything
 * else.
 *
 * The arrival decides asynchronously (Arrival.svelte's `decide()`): it reads
 * the session, and where that is not answer enough it reads the workspace,
 * and a reader with somewhere onward is handed to /home with
 * `location.replace`. Since #840 an administrator with no household of their
 * own lands here rather than on the returnTo they asked for, so a spec that
 * signs in and immediately seeds a household is racing that read -- the seed
 * turns the decision ONWARD while it is still in flight, and the redirect
 * that follows aborts whatever the spec navigated to in the meantime. It
 * surfaces as `net::ERR_ABORTED` on an ordinary `goto`, which names the
 * navigation rather than the redirect that cancelled it.
 *
 * Waiting for the decision to land first removes the race: either the
 * arrival has already left for /home, or it is showing one of its two stages
 * -- CREATE (`#gobtn`) or NEWCOMER ("where do you belong?") -- and from
 * there it never navigates again without the reader.
 *
 * Sign-in that lands somewhere else entirely is left alone: a spec whose
 * account already has a household never meets the arrival, and this returns
 * as soon as that page is up.
 */
export async function settleArrival(page: Page, timeout = 20_000) {
  await Promise.any([
    page.waitForURL(/\/home$/, { timeout }),
    page.locator("#gobtn").waitFor({ state: "visible", timeout }),
    page.getByRole("heading", { name: "where do you belong?" }).waitFor({ state: "visible", timeout }),
  ]);
}
