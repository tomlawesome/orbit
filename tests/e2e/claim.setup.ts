import { test } from "@playwright/test";
import { claimInstanceAsAdministrator } from "./support/bootstrap";

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
 * This project itself depends on "unclaimed" (#1046), the project holding
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
 * comment): the database is not reset between specs, so this may already be
 * claimed -- the --reuse path (#947) -- and a second claim is a no-op, not a
 * failure.
 */
test("the stack is claimed before any spec depends on it", async ({ request, browser }) => {
  const availability = (await (await request.get("/api/auth/availability")).json()) as {
    methods: { oidc: boolean };
  };
  test.skip(!availability.methods.oidc, "no OIDC provider configured: the local-only profile claims itself (tests/e2e/local-sign-in.spec.ts)");

  await claimInstanceAsAdministrator(browser);
});
