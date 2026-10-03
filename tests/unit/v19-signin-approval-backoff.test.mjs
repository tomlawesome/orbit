import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-R1 (covers Low row A1-R8 too): the email-approval poll in
 * SignIn.svelte used to recurse every 2s on ANY non-terminal answer,
 * including a failing fetch, with no deadline at all — unlike the STARTING
 * poll a few hundred lines below it, which already carries a backstop
 * (door-state.js's `applyStartingBackstop`). A backend outage during a
 * sign-in approval wait therefore polled forever and never told the reader
 * anything was wrong.
 *
 * `SignIn.svelte` is not import-tested here — a `.svelte` file needs the
 * compiler this suite does not pull in for a source check — so this pins
 * the fix the same way `v19-flight-mark-ride.test.mjs` and
 * `v19-ring-close-split.test.mjs` pin a `.svelte`/`.css` file's own text.
 */

const SIGNIN = readFileSync(
  resolve(import.meta.dirname, "../../web/src/lib/flight/SignIn.svelte"),
  "utf8",
);

describe("#1151 W1-R1: the approval poll backs off and gives up", () => {
  it("reads a deadline set from the STARTING poll's own backstop constant", () => {
    expect(SIGNIN).toMatch(/approvalDeadlineAt\s*=\s*Date\.now\(\)\s*\+\s*STARTING_BACKSTOP_MS/u);
  });

  it("stops polling, visibly, once the deadline has passed", () => {
    // askAgain must check the deadline before scheduling another round, and
    // land on the waiting card's own "lapsed" words rather than a silent
    // stop (ADR-0027 §4's Waiting.svelte already has that copy for
    // `phase === "lapsed"`).
    expect(SIGNIN).toMatch(/Date\.now\(\)\s*>=\s*approvalDeadlineAt/u);
    const askAgain = SIGNIN.slice(SIGNIN.indexOf("function askAgain"));
    expect(askAgain.slice(0, 200)).toMatch(/pendingState = "lapsed"/u);
  });

  it("backs off on an unreadable answer instead of a flat 2s retry", () => {
    expect(SIGNIN).toMatch(/approvalFailures\s*=\s*answer === null \? approvalFailures \+ 1 : 0/u);
    // the delay grows with consecutive failures and is capped well under
    // the deadline, rather than hammering the same 2000ms forever
    expect(SIGNIN).toMatch(/2000 \* 2 \*\* approvalFailures/u);
  });
});
