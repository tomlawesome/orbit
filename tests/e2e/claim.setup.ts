import { dirname } from "node:path";
import { expect, test } from "@playwright/test";
import { claimInstanceAsAdministrator } from "./support/bootstrap";
import { assertEverySpecFileResets, captureDatabaseSeed } from "./support/database";
import { sessionHeaders } from "./support/households";

/**
 * Claims the stack once, ahead of every project's specs (#1039), so a spec
 * that only signs in -- v19-document-extraction.spec.ts is one -- means what
 * it says when run alone with --spec against a fresh stack, instead of dying
 * at the sign-in link with `bootstrap_required` (ADR-0022). Wired in as a
 * Playwright dependency project (tests/e2e/playwright.config.ts) rather than
 * called from scripts/test-e2e-local.sh, so `--project` and `--spec` filters
 * on the harness side never bypass it: Playwright always runs a project's
 * dependencies first, whatever file or project filter selected the run
 * (verified: `--project=desktop-chromium <single spec>` still lists this
 * project ahead of it).
 *
 * This project itself depends on "unclaimed" (#1039), the project holding
 * only tests/e2e/bootstrap-protection.spec.ts -- the one spec whose whole
 * subject is the state before any claim. That dependency is transitive
 * through the same mechanism: Playwright will not start this project until
 * "unclaimed" has finished, so the blanket claim below can never race ahead
 * of the one spec that needs to see an instance nobody has claimed yet.
 *
 * OIDC only. The local-only profile's claim is a different journey --
 * choosing the first administrator's own email and password off the claim
 * card, never signing in as a fixed identity -- and local-sign-in.spec.ts IS
 * that journey (tests/e2e/local-only-specs.txt runs it first, and it asserts
 * the instance is still unclaimed when it starts). A local-only stack has no
 * configured provider, so claimInstanceAsAdministrator's own sign-in step
 * would have no "Orbit Administrator" link to click -- skip rather than
 * claim ahead of it and break that journey's precondition.
 *
 * Idempotent for the same reason claimInstanceAsAdministrator is (its own
 * comment): the stack may already be claimed -- the --reuse path (#947) --
 * and a second claim is a no-op, not a failure.
 *
 * Since #1077 this also takes the seed every other spec file goes back to.
 * It is the right moment for it: the claim has just completed, so the seed
 * holds everything the suite assumes and nothing any spec has done yet.
 */
test("the stack is claimed before any spec depends on it", async ({ request, browser }) => {
  /* #1077, and before the profile check below so it is answered in every
     profile: a spec file that never puts the database back is the leak
     coming straight back, so it fails the run here, named, rather than as
     somebody else's tab-order test twenty minutes in. */
  assertEverySpecFileResets(dirname(test.info().file));

  const availability = (await (await request.get("/api/auth/availability")).json()) as {
    methods: { oidc: boolean };
  };
  test.skip(!availability.methods.oidc, "no OIDC provider configured: the local-only profile claims itself (tests/e2e/local-sign-in.spec.ts)");

  await claimInstanceAsAdministrator(browser, {
    /* #1077: the seed records the administrator as having already taken the
       first-run walk, through the route "take the walk again" writes.
       Without this the reset hands every spec file an administrator who has
       never seen it, so the tour card goes up over /home in file after file
       and covers the controls specs click -- v19-mail-review timed out twice
       that way. It is also the state the suite has always actually had:
       before the reset, the first file to reach /home skipped the walk and
       the remaining twenty-four inherited a reader who had taken it.
       The three files whose subject IS the walk are unaffected, because each
       puts the record into the state it needs through this same route rather
       than relying on it never having been written (v19-tour.spec.ts's own
       note, and v19-axe-sweep/v19-screen-reader do the same). */
    afterSignIn: async (page) => {
      const recorded = await page.request.put("/api/settings/tour", {
        headers: await sessionHeaders(page),
        data: { tourSeenAt: new Date().toISOString() },
      });
      expect(recorded.ok(), `the seed could not record the walk as taken (HTTP ${recorded.status()})`).toBe(true);
    },
  });

  /* #1077: with the instance claimed and the first administrator in place,
     this is the state every other spec expects to start from -- so copy it
     now, before any of them has run, and let each spec file come back to it
     (tests/e2e/support/database.ts). Taken here rather than in the harness
     because this is the moment the seed is complete and still clean, and
     because a Playwright dependency project runs whatever `--project` or
     `--spec` filter selected the run. */
  captureDatabaseSeed();
});
