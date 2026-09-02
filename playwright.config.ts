import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
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
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "on-first-retry",
    // The acceptance-only OIDC sidecar rotates a self-signed loopback
    // certificate on every run. Orbit itself remains served over the normal
    // configured application URL.
    ignoreHTTPSErrors: process.env.ORBIT_ACCEPTANCE_OIDC === "true",
    // The container-side OIDC_ISSUER/TEST_OIDC_ISSUER URLs are fixed to
    // https://orbit-oidc:4443/ (docker-compose.acceptance.yml) and must stay
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
  outputDir: "test-results",
});
