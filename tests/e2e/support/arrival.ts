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
export async function settleArrival(page: Page, timeout = 20_000, returnTo?: string) {
  /* #1233: a sign-in that asked for somewhere other than /home lands there
     instead, and that landing is as much "settled" as /home is. */
  const asked = returnTo ? new URL(returnTo, "http://orbit.invalid").pathname : null;
  await Promise.any([
    page.waitForURL(/\/home$/, { timeout }),
    ...(asked && asked !== "/home" ? [page.waitForURL((url) => url.pathname === asked, { timeout })] : []),
    page.locator("#gobtn").waitFor({ state: "visible", timeout }),
    page.getByRole("heading", { name: "where do you belong?" }).waitFor({ state: "visible", timeout }),
  ]);
}

/**
 * #1233: every class <body> ever wears, recorded from inside the page.
 *
 * The climb is a 4.6 s window of `showwarp` (web/src/lib/flight/timeline.js:
 * warp at 200 ms, land at 4800 ms), and an assertion polling from outside the
 * page can miss the whole of it: on desktop-webkit the page went quiet for
 * longer than that between two polls, and the next poll saw "bare" (pipeline
 * 2203, job 32546, v19-arrival.spec.ts:166). A MutationObserver runs as a
 * microtask after each change, so it sees every state however the polls fall.
 * Install before the document that flies; read with `bodyClassSeen`.
 */
export async function witnessBodyClasses(page: Page) {
  await page.addInitScript(() => {
    const seen = new Set<string>();
    (window as unknown as { __orbitBodyClasses: Set<string> }).__orbitBodyClasses = seen;
    const note = () => document.body?.classList.forEach((name) => seen.add(name));
    const start = () => {
      note();
      new MutationObserver(note).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    };
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  });
}

/** Whether `witnessBodyClasses` has seen <body> wear `name` in this document. */
export async function bodyClassSeen(page: Page, name: string) {
  return page.evaluate(
    (wanted) => Boolean((window as unknown as { __orbitBodyClasses?: Set<string> }).__orbitBodyClasses?.has(wanted)),
    name,
  );
}
