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
  /* The ceiling for a run. Each project below sets its own limit under it:
     `fidelity` stays at one, `pocket-measure` takes all four. */
  workers: 4,
  reporter: [["list"]],
  /*
   * Two projects, because this directory holds two different kinds of test
   * and they belong at different moments (#1048, owner 2026-09-18).
   *
   * `fidelity` guards an appearance: it photographs a screen and compares it
   * with a committed baseline, and it has to run on every merge request that
   * moves the front end, because that is when a screen breaks.
   *
   * `launch-timing` guards nothing. It measures frame intervals through the
   * launch hand-off, and on a shared machine the run-to-run noise is larger
   * than the effect being measured -- the same unchanged build differed by up
   * to 189 pixels, and a CSS-only phase nobody had touched moved as much as
   * the phase under test. So it runs once per promotion instead, on the
   * quietest lane this host has, from the `launch_timing` CI job.
   *
   * Selecting by project rather than by path keeps the split in one place:
   * `pnpm --filter orbit-web fidelity` and `pnpm --filter orbit-web
   * launch-timing` each name their own, and neither can pick up the other's
   * files by accident when a new spec lands in this directory.
   */
  projects: [
    { name: "fidelity", workers: 1,
      testIgnore: ["**/launch-timing.spec.js", "**/door-reveal-timing.spec.js", "**/pocket-measure.spec.js", "**/tour-pocket-webkit.spec.js"] },
    { name: "launch-timing", workers: 1, testMatch: "**/launch-timing.spec.js" },
    /* the door's first light, timed (2026-10-06 ruling: button by 2s,
       sunrise by 3.5s): a measurement like launch-timing, so outside the
       per-merge-request gate, in both engines the door is judged in */
    { name: "door-timing", workers: 1, testMatch: "**/door-reveal-timing.spec.js" },
    { name: "door-timing-firefox", workers: 1, testMatch: "**/door-reveal-timing.spec.js",
      use: { browserName: "firefox" } },
    /* `pocket-measure` guards the phone floors (#1120): 508 read-only layout
       measurements, each on its own page against the fixture app with its
       API answered per page, so no test can see another's state. It compares
       no pixels, so it does not need the one-at-a-time run `fidelity` keeps,
       and on one worker it outran the CI job's 20 minutes by itself (#1148).
       Four workers match the `light` runner's four CPUs. Its per-test limit
       is 60s, not the default 30s: with a sheet open on /administration,
       every control behind the sheet is scrolled into view and re-checked
       after the 450ms it may take a scroll's consequences to land, and that
       state measured ~29s on a quiet host. The 450ms is the check's own
       and stays: a shorter, event-based wait was tried and missed a blocker
       that appears a few frames after a scroll, which the fixed wait catches.

       `pnpm --filter orbit-web fidelity` runs it AFTER `fidelity`, as a
       second Playwright run, never beside it: sharing four CPUs with four
       measurement workers, `fidelity`'s timing-sensitive tests failed (an
       arrival animation, two administration waits) and the item screen's
       pixel diff read 0.1056% against a 0.1% budget, where alone it reads
       0.0417% and all 170 pass (#1148). Both runs always happen, and the
       command fails if either does. */
    { name: "pocket-measure", workers: 4, fullyParallel: true, timeout: 60_000,
      testMatch: "**/pocket-measure.spec.js" },
    /* `pocket-webkit` (#1174, #1175) is the phone in Safari's engine: the
       first-run film played through and every mark held at two phone widths
       (tour-pocket-webkit.spec.js), and the belong card's create drawer
       (pocket-belong-drawer.spec.js, #1263, which the Chromium `fidelity`
       run above also takes). Everything else here runs in Chromium, and the pocket
       film shipped green through all of it and broke on the owner's iPhone.
       Its own script, `pnpm --filter orbit-web fidelity:webkit`, run by CI's
       `fidelity` job after `fidelity`: WebKit's system libraries are in
       Playwright's image but not on every host, so it is not folded into
       the `fidelity` script that a host without them runs. One worker, one
       phone at a time, as `fidelity` itself; the played film is ~1:42 under
       reduced motion, so the per-test limit is set by the spec. */
    { name: "pocket-webkit", workers: 1,
      testMatch: ["**/tour-pocket-webkit.spec.js", "**/pocket-belong-drawer.spec.js"],
      use: { browserName: "webkit", isMobile: true, hasTouch: true, deviceScaleFactor: 2,
        viewport: { width: 390, height: 844 } } },
  ],
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
       * what actually ships, including its server rendering.
       *
       * It used to rebuild on every run, so that a stale build could never
       * pass for a current one. That guarantee is now the stamp's rather than
       * the rebuild's (#1061): `web-build-stamp.mjs check` succeeds only when
       * web/build was built from the same file contents this checkout has, so
       * anything else — no build, a build from another branch, one file edited
       * since — falls through to `pnpm build`. In CI the `fast` job has
       * already built it and hands web/build over as an artefact, so the
       * check passes and the gate serves those exact bytes; running this from
       * a clean checkout builds it here instead, with nothing to remember.
       *
       * `||` and `&&` bind equally and left to right, so this reads
       * (check || build) && serve: the server starts after whichever of the
       * first two answered, and not at all if the build failed.
       */
      command: "node ../scripts/web-build-stamp.mjs check || pnpm build && node build/index.js",
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
