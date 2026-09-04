import { defineConfig } from "@playwright/test";

/**
 * The visual gate. Deliberately separate from the repo-root Playwright config,
 * which drives the Next application's behavioural suite.
 */
const APP_PORT = process.env.FIDELITY_PORT ?? "4173";
const MOCKUP_PORT = process.env.FIDELITY_MOCKUP_PORT ?? "5174";

export default defineConfig({
  testDir: "./tests/fidelity",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    /*
     * 1600x1000 is the design's own SVG viewBox, so the artwork is judged at
     * its authored aspect ratio and nothing is being seen through a scale.
     */
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    /* Motion is the design's, not the machine's — see capture() in screens.spec.js. */
    reducedMotion: "no-preference",
    /* The maintenance screen shows wall-clock times in the viewer's zone. The
       mockup is static and says what it says; the gate views in UTC so the
       same fixture photographs the same on this machine and in CI. */
    timezoneId: "UTC",
  },
  /*
   * The two ports the gate stands up. Overridable, and defaulted to what they
   * have always been: a shared machine can be running a second app and a
   * second mockup host at once — another screen being built, an evidence
   * capture — and a run must be able to stand up its own pair instead of
   * quietly photographing someone else's build. FIDELITY_APP and
   * FIDELITY_MOCKUPS (screens.spec.js) point the tests at the same pair.
   */
  webServer: [
    {
      /*
       * The adapter-node output, not `vite preview` — the gate should judge
       * what actually ships, including its server rendering. Rebuilt each run
       * so a stale build can never pass for a current one.
       */
      command: "pnpm build && node build/index.js",
      /* ORBIT_FIXTURES turns on the fixture /api routes (#451) so the seam's
         real fetch path renders known data. Production never sets it, and
         since the cut (#735) that is the whole of the protection — the
         composite entry that used to keep /api away from this app is gone. */
      /* Since the cut (#735) this app runs the real boot sequence
         (`src/server/boot.ts` via `web/src/hooks.server.js`'s `init`), which
         calls `validateStartupConfiguration` and exits the process if it
         throws. The gate has no real deployment configuration, so it is
         handed a complete but entirely fake one below — obviously-placeholder
         values, never anything resembling a real credential — so the real
         boot path runs and passes rather than being bypassed. Startup itself
         opens no database connection (see the comment on
         `validateStartupConfiguration`), so a syntactically valid DATABASE_URL
         pointing at nothing is fine. MIGRATE_ON_START and WORKER_ENABLED stay
         off so nothing tries to run migrations or start the mail/document/IMAP
         workers, and IMAP_ENABLED=false and DOCUMENT_SCAN_MODE=disabled keep
         the running server from later trying to reach an IMAP host or a
         ClamAV scanner that don't exist here. */
      env: {
        PORT: APP_PORT,
        ORBIT_FIXTURES: "1",
        ORBIT_CONFIG_SCHEMA_VERSION: "1",
        APP_URL: `http://127.0.0.1:${APP_PORT}`,
        SESSION_SECRET: "ab".repeat(32),
        OIDC_ISSUER: "https://fidelity-gate.invalid/oidc",
        OIDC_CLIENT_ID: "fidelity-gate-placeholder-client-id",
        OIDC_CLIENT_SECRET: "fidelity-gate-placeholder-client-secret",
        DATABASE_URL: "postgres://fidelity-gate:fidelity-gate@127.0.0.1:5999/fidelity-gate",
        DOCUMENT_KEK: "cd".repeat(32),
        DOCUMENT_SCAN_MODE: "disabled",
        MIGRATE_ON_START: "false",
        WORKER_ENABLED: "false",
        IMAP_ENABLED: "false",
      },
      url: `http://127.0.0.1:${APP_PORT}/login`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
    },
    {
      /* Serves the ratified mockups so a screen being ported can be compared
         against its design before it earns a baseline. */
      command: `node tests/fidelity/serve.mjs ${MOCKUP_PORT}`,
      url: `http://127.0.0.1:${MOCKUP_PORT}/design/family/family.css`,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
    },
  ],
});
