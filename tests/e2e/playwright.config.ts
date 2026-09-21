import { defineConfig, devices } from "@playwright/test";

// Every path below is resolved relative to THIS file's directory, which is
// tests/e2e/ since #442. The suite is this directory, and both output trees
// stay at the repository root, where .gitignore lists them and CI collects
// playwright-report/ as the job's artifact.
// #1080: how many workers run when the stack has the OIDC sidecar, which is
// where the per-worker identity sets live (tests/oidc/server.mjs, at most
// WORKER_IDENTITY_SETS of them — tests/e2e/support/worker-identity.ts).
//
// TWO, from the measured curve and not from the host's cores. The whole
// suite, under the CI cpu cap (compose/docker-compose.ci-cap.yml), on a host
// with twelve of them:
//
//     workers   suite      result
//        1      11.8m      green, 198 passed
//        2       6.5m      green, 198 passed (6.3m on a second run, also green)
//        4       6.2m      v19-arrival's newcomer journey failed
//        8       5.8m      the same test failed again
//
// Nearly all of the saving is at two, and there is almost nothing after it:
// the app is allowed six tenths of one core however many browsers ask it
// things, and the workers that are not waiting on the app are waiting at the
// reset gate (tests/e2e/support/reset-gate.ts) — 36s of gate waiting across
// the whole run at two workers, 450s at four, 1324s at eight. Raising the
// count past two buys single-digit percentages and spends them on queueing.
//
// The failures at four and eight are not the reason for the number — the flat
// curve is — but they are the second reason not to reach for a bigger one
// until they are understood.
//
// ORBIT_E2E_WORKERS exists to MEASURE that curve and for nothing else: it is
// set by hand around `scripts/test-e2e-local.sh --ci-cap` and is unset in CI
// and in the harness, so #730's surviving rule still holds -- a local run and
// a CI run agree on the worker count unless somebody deliberately asked
// otherwise for a measurement.
const PARALLEL_WORKERS = Number(process.env.ORBIT_E2E_WORKERS ?? 2);

export default defineConfig({
  testDir: ".",
  // #1080: the spec FILE is the parallel unit, not the test. Specs assume
  // in-file order everywhere — beforeAll fixtures, serial groups, per-file
  // cleanup (#730) — and fullyParallel would scatter a file's tests across
  // workers, each signed in as a DIFFERENT worker identity.
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  // One retry, not two (#923 finding 3, owner ruling 2026-09-09): a genuinely
  // broken test used to run three times before it reported, and ten spec files
  // are test.describe.configure({ mode: "serial" }), where one failure re-runs
  // the whole group -- v19-tour cost 41s that way in a single job.
  retries: process.env.CI ? 1 : 0,
  // Failures cluster: past the fifth, the rest of the run is noise paid for at
  // ~2s a test on one worker. In pipeline 822's smoke, two keyboard tests each
  // failed three times and the run continued through all 282 tests. Local runs
  // keep no limit, so a full local sweep still reports everything.
  maxFailures: process.env.CI ? 5 : 0,
  // #1080 (was #730's "one worker everywhere"): the sharing that forced one
  // worker was the single administrator identity, and it is gone — each
  // worker signs in as its own (tests/e2e/support/worker-identity.ts), so
  // each sees only its own sky. The count is the SAME locally and in CI,
  // #730's surviving rule: a local run that disagrees with CI is worse than
  // a slow one.
  //
  // The local-only profile stays on one worker, deliberately: it has no
  // OIDC sidecar and so no per-worker identities, and its spec list depends
  // on file order (tests/e2e/local-only-specs.txt — local-sign-in claims the
  // instance, signed-out then needs it claimed). ORBIT_ACCEPTANCE_OIDC is
  // exactly the flag both harnesses set when the sidecar is present.
  workers: process.env.ORBIT_ACCEPTANCE_OIDC === "true" ? PARALLEL_WORKERS : 1,
  // #1080: 60s per test, not Playwright's 30s default. The acceptance app is
  // capped at 0.6 cpu (compose/docker-compose.ci-cap.yml) and now serves
  // several workers at once, so a test's latency envelope is set by its
  // neighbours as well as itself: v19-mail-review's ~4s tests crossed 30s
  // under a keyboard walk on the other worker. A ceiling, not a wait — fast
  // tests stay fast; specs that declare their own longer budget keep it.
  timeout: 60_000,
  reporter: process.env.CI
    ? [["html", { open: "never", outputFolder: "../../playwright-report" }], ["list"]]
    : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "on-first-retry",
    // The acceptance-only OIDC sidecar rotates a self-signed loopback
    // certificate on every run. Orbit itself remains served over the normal
    // configured application URL.
    ignoreHTTPSErrors: process.env.ORBIT_ACCEPTANCE_OIDC === "true",
    // The container-side OIDC_ISSUER/TEST_OIDC_ISSUER URLs are fixed to
    // https://orbit-oidc:4443/ (compose/docker-compose.acceptance.yml) and must stay
    // that way -- orbit-app and orbit-oidc talk to each other over the
    // docker network using that literal URL. The browser follows the same
    // URL for the authorize redirect, so it must be sent to wherever the
    // host actually published that container's port. The resolver rule
    // rewrites both the host and the port, so TEST_OIDC_PORT
    // (scripts/test-e2e-local.sh) can move the host binding without
    // touching the fixed in-container issuer URL.
    launchOptions: process.env.ORBIT_ACCEPTANCE_OIDC === "true"
      ? { args: [`--host-resolver-rules=MAP orbit-oidc 127.0.0.1:${process.env.TEST_OIDC_PORT ?? "4443"}`] }
      : undefined,
  },
  projects: [
    // #1039: bootstrap-protection.spec.ts's whole subject is the state an
    // instance is in before anything claims it, so it cannot share a project
    // with "setup" below -- it needs to run and finish BEFORE the claim, not
    // merely outside "setup"'s own dependents. Giving it its own project and
    // making "setup" depend on it (not the other way around) puts that
    // ordering in the project graph itself: Playwright will not start a
    // project's tests until every project in its `dependencies` has finished
    // all of its own, so "setup" cannot claim until this project's one spec
    // is done, whatever worker count or --project/--spec filter selected the
    // run. Two projects with no dependency edge between them have no such
    // guarantee and may be scheduled concurrently -- that laxer arrangement
    // (just leaving the spec out of "setup"'s dependents) is what raced here.
    { name: "unclaimed", testMatch: /bootstrap-protection\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    // #1039: claims the stack once "unclaimed" above has finished, so any
    // other spec means what it says run alone with --spec against a fresh
    // stack instead of relying on an earlier spec in the same run having
    // claimed it first. See tests/e2e/claim.setup.ts for what it does and
    // does not cover (OIDC only) and why.
    { name: "setup", testMatch: /.*\.setup\.ts/, dependencies: ["unclaimed"] },
    {
      name: "desktop-chromium",
      testIgnore: [/bootstrap-protection\.spec\.ts/, /maintenance\.spec\.ts/],
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
    {
      name: "mobile-chromium",
      testIgnore: [/bootstrap-protection\.spec\.ts/, /maintenance\.spec\.ts/],
      use: { ...devices["Pixel 7"] },
      dependencies: ["setup"],
    },
    // #1080: maintenance.spec.ts opens an INSTANCE-WIDE maintenance window —
    // the one piece of state per-worker identities cannot unshare, because a
    // window deliberately closes every screen for every reader. It runs
    // after the parallel bulk has finished, one project at a time (the two
    // device projects would otherwise open two windows over each other).
    // Tail rather than head so a red spec in the bulk never runs UNDER a
    // maintenance window; the cost is that a red bulk skips these two
    // projects, which that run's rerun covers.
    {
      name: "maintenance-desktop",
      testMatch: /maintenance\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["desktop-chromium", "mobile-chromium"],
    },
    {
      name: "maintenance-mobile",
      testMatch: /maintenance\.spec\.ts/,
      use: { ...devices["Pixel 7"] },
      dependencies: ["maintenance-desktop"],
    },
  ],
  outputDir: "../../test-results",
});
