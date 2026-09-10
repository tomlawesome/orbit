import { defineConfig, devices } from "@playwright/test";

// Every path below is resolved relative to THIS file's directory, which is
// tests/e2e/ since #442. The suite is this directory, and both output trees
// stay at the repository root, where .gitignore lists them and CI collects
// playwright-report/ as the job's artifact.
export default defineConfig({
  testDir: ".",
  fullyParallel: true,
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
  // One worker EVERYWHERE, not just in CI (#730). These specs share one Orbit
  // instance -- one database, one set of identities, one sky -- so running
  // files concurrently means they crowd each other's skies while they run.
  // v19-arrival passed alone and failed in a local suite for exactly this
  // reason, and CI never showed it because CI already pinned this to 1. A
  // local run that disagrees with CI is worse than a slow one.
  //
  // The cost is real: the v19 subset takes ~10s across twelve workers and
  // ~50s on one. The way back to parallel is to remove the sharing rather
  // than queue around it -- stub the workspace read per spec, the way
  // v19-hit-routing.spec.ts already does, which is why that spec is immune.
  workers: 1,
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
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  outputDir: "../../test-results",
});
