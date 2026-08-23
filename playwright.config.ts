import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
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
