import { defineConfig, devices, type Project } from "@playwright/test";

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
// with twelve of them. Re-measured 2026-09-23 on this branch rebased onto
// dev's 1e2883ae, one run per count, sequentially, Playwright's own summary:
//
//     workers   suite      result
//        1      15.4m      green, 198 passed (2026-09-22, at 4fc18a27)
//        2       9.2m      green, 204 passed, 79 skipped
//        4       6.8m      3 failed, 177 passed, 78 skipped, 25 did not run
//
// Nearly all of the saving is at two, and what is left past it is bought with
// queueing: the app is allowed six tenths of one core however many browsers
// ask it things, and the workers that are not waiting on the app are waiting
// at the reset gate (tests/e2e/support/reset-gate.ts) — 45s of gate waiting
// across the whole run at two workers, 480s at four. Four is 26% quicker than
// two in wall-clock and spends eight times as long at the gate to get it.
//
// The failures at four are the second reason not to reach for a bigger
// number. None of them is one spec reading another's data — the three were
// v19-arrival spending its whole 180s budget before the door answered,
// v19-entry's /home dial missing inside 5s on mobile, and a chromium page
// that crashed outright in v19-item-actions. They are what a stack capped at
// 0.6 cpu does when four browsers ask it things at once, so the answer is a
// smaller number rather than a longer timeout. docs/flakes.md has them.
//
// ORBIT_E2E_WORKERS exists to MEASURE that curve and for nothing else: it is
// set by hand around `scripts/test-e2e-local.sh --ci-cap` and is unset in CI
// and in the harness, so #730's surviving rule still holds -- a local run and
// a CI run agree on the worker count unless somebody deliberately asked
// otherwise for a measurement.
const PARALLEL_WORKERS = Number(process.env.ORBIT_E2E_WORKERS ?? 2);

// #1150: scripts/test-e2e-local.sh sets this when running against a stack
// named by --reuse (#947). Such a stack is by definition already claimed,
// so the "unclaimed" project below -- whose one spec,
// bootstrap-protection.spec.ts, asserts the instance is NOT yet claimed --
// would fail loudly on a precondition that no longer holds, and "setup"
// depends on it, so nothing else would run either. tests/e2e/claim.setup.ts
// is already idempotent against an already-claimed stack (its own header
// comment), so only the "unclaimed" project and "setup"'s dependency on it
// are dropped here; a fresh run (this unset) keeps exactly the graph it has
// today.
const reuseKeptStack = process.env.ORBIT_E2E_REUSE === "true";

// #1183: Firefox has no --host-resolver-rules (the Chromium switch `use`
// passes below), so the same redirect of `orbit-oidc` is made with two
// Firefox prefs: localDomains resolves the name to loopback, and forcePort
// moves the fixed in-container 4443 to wherever TEST_OIDC_PORT published it.
// forcePort is global to the browser, which is safe here because nothing
// else the suite opens uses 4443. In CI the port is 4443 and no remap is set.
//
// #1192: WebKit has neither switch, and Playwright exposes no third way to
// do this from inside a browser's own launch options. Its redirect happens
// outside this file instead, in CI: smoke_webkit/smoke_webkit_mobile add
// orbit-oidc to the job container's /etc/hosts (.gitlab-ci.yml,
// `.webkit_oidc_hosts`), which is where that job's Playwright process and
// the stack's published ports already live. See the desktop-webkit/
// mobile-webkit projects below for the launchOptions half of this.
const oidcHostPort = process.env.TEST_OIDC_PORT ?? "4443";
const firefoxLaunchOptions = process.env.ORBIT_ACCEPTANCE_OIDC === "true"
  ? {
    firefoxUserPrefs: {
      "network.dns.localDomains": "orbit-oidc",
      ...(oidcHostPort === "4443" ? {} : { "network.socket.forcePort": `4443=${oidcHostPort}` }),
    },
  }
  : undefined;

// #1183: which engines' projects this run has. Every engine by default, so a
// local run is the whole suite; CI splits it across jobs because Firefox
// inside `smoke` took that job to 29.9 of its 30 minutes (pipeline 1926):
// `smoke` sets chromium, `smoke_firefox` sets firefox (.gitlab-ci.yml). #1192
// adds webkit the same way; webkit's own two jobs (smoke_webkit,
// smoke_webkit_mobile) split further by device -- see ORBIT_E2E_WEBKIT_DEVICES
// below -- because desktop and phone together ran close to the same 30m limit.
// "unclaimed" and "setup" are not per engine and are always present.
const ENGINES = ["chromium", "firefox", "webkit"] as const;
const selectedEngines = (process.env.ORBIT_E2E_ENGINES || ENGINES.join(","))
  .split(",").map((engine) => engine.trim()).filter(Boolean);
for (const engine of selectedEngines) {
  if (!(ENGINES as readonly string[]).includes(engine)) {
    throw new Error(`ORBIT_E2E_ENGINES names "${engine}"; expected a comma-separated list of ${ENGINES.join(", ")}`);
  }
}
const runs = (engine: (typeof ENGINES)[number]) => selectedEngines.includes(engine);

// #1192: within the webkit engine, which device class(es) this run has. Both
// by default (a local run is the whole engine); smoke_webkit sets desktop,
// smoke_webkit_mobile sets mobile (.gitlab-ci.yml). No equivalent split
// exists for chromium/firefox because neither needed one yet.
const WEBKIT_DEVICES = ["desktop", "mobile"] as const;
const selectedWebkitDevices = (process.env.ORBIT_E2E_WEBKIT_DEVICES || WEBKIT_DEVICES.join(","))
  .split(",").map((device) => device.trim()).filter(Boolean);
for (const device of selectedWebkitDevices) {
  if (!(WEBKIT_DEVICES as readonly string[]).includes(device)) {
    throw new Error(`ORBIT_E2E_WEBKIT_DEVICES names "${device}"; expected a comma-separated list of ${WEBKIT_DEVICES.join(", ")}`);
  }
}
const runsWebkit = (device: (typeof WEBKIT_DEVICES)[number]) => runs("webkit") && selectedWebkitDevices.includes(device);

const BULK_IGNORE = [/bootstrap-protection\.spec\.ts/, /maintenance\.spec\.ts/];
const deviceProjects: Project[] = [
  ...(runs("chromium")
    ? [
      { name: "desktop-chromium", testIgnore: BULK_IGNORE, use: { ...devices["Desktop Chrome"] }, dependencies: ["setup"] },
      { name: "mobile-chromium", testIgnore: BULK_IGNORE, use: { ...devices["Pixel 7"] }, dependencies: ["setup"] },
    ]
    : []),
  // #1183: the release audit (#1151) wants the suite on every engine. Same
  // shape and viewport as desktop-chromium; its own launchOptions, because
  // `use.launchOptions` below is a Chromium switch (see firefoxLaunchOptions).
  // Specs gate on startsWith("mobile"), so this runs the desk dialect.
  ...(runs("firefox")
    ? [{
      name: "desktop-firefox",
      testIgnore: BULK_IGNORE,
      use: { ...devices["Desktop Firefox"], launchOptions: firefoxLaunchOptions },
      dependencies: ["setup"],
    }]
    : []),
  // #1192: the release audit (#1192) wants the suite on WebKit too, phone
  // first because Orbit's WebKit users are mostly on iPhones -- desktop
  // alongside it on the owner's instruction. Same ignore list and `setup`
  // dependency as the Chromium/Firefox projects.
  //
  // launchOptions: {} here, not left unset, and not `undefined`. The
  // top-level `use.launchOptions` below is a Chromium switch
  // (--host-resolver-rules) that redirects the orbit-oidc sign-in host for
  // the OIDC profile, and WebKit's launcher does not understand it
  // ("Cannot parse arguments: Unknown option --host-resolver-rules=...",
  // pipeline 1982, 12 failures across these two projects). Playwright merges
  // a project's `use` over the top-level one key at a time
  // (playwright/lib/util.js's mergeObjects) and SKIPS a key whose value is
  // literally `undefined`, keeping the parent's -- which is exactly why the
  // first attempt at this (`launchOptions: undefined`) still inherited the
  // Chromium args and still failed. `{}` is a real value, so it replaces the
  // inherited object outright and WebKit launches with no extra args.
  //
  // WebKit still needs orbit-oidc redirected somewhere it can reach -- it
  // has no --host-resolver-rules and no Firefox-style user-pref equivalent
  // (no documented one exists). That redirect happens one layer out, in CI:
  // smoke_webkit/smoke_webkit_mobile (.gitlab-ci.yml, `.webkit_oidc_hosts`)
  // add orbit-oidc to the job container's own /etc/hosts, which is the
  // mechanism a `use.launchOptions` in this file cannot express at all (no
  // browser flag involved). A local `--project desktop-webkit`/`mobile-webkit`
  // run has no equivalent yet -- see that CI comment for why.
  ...(runsWebkit("desktop")
    ? [{
      name: "desktop-webkit",
      testIgnore: BULK_IGNORE,
      use: { ...devices["Desktop Safari"], launchOptions: {} },
      dependencies: ["setup"],
    }]
    : []),
  ...(runsWebkit("mobile")
    ? [{
      name: "mobile-webkit",
      testIgnore: BULK_IGNORE,
      use: { ...devices["iPhone 15"], launchOptions: {} },
      dependencies: ["setup"],
    }]
    : []),
];

// #1080: maintenance.spec.ts opens an INSTANCE-WIDE maintenance window — the
// one piece of state per-worker identities cannot unshare, because a window
// deliberately closes every screen for every reader. It runs after the
// parallel bulk has finished, one project at a time (the device projects
// would otherwise open windows over each other): the first waits for every
// device project in this run, and each later one for the one before it.
// Tail rather than head so a red spec in the bulk never runs UNDER a
// maintenance window; the cost is that a red bulk skips these projects,
// which that run's rerun covers. #1183: the maintenance page is a screen
// people see, so Firefox gets its own pass, last in the chain. #1192 does
// not add one for WebKit -- out of scope for the issue that added
// desktop-webkit/mobile-webkit above; they still gate maintenance-desktop's
// start via deviceProjects.map() below like any other device project.
const maintenanceProjects: Project[] = [
  ...(runs("chromium")
    ? [
      { name: "maintenance-desktop", use: { ...devices["Desktop Chrome"] } },
      { name: "maintenance-mobile", use: { ...devices["Pixel 7"] } },
    ]
    : []),
  ...(runs("firefox")
    ? [{ name: "maintenance-firefox", use: { ...devices["Desktop Firefox"], launchOptions: firefoxLaunchOptions } }]
    : []),
].map((project, index, chain) => ({
  ...project,
  testMatch: /maintenance\.spec\.ts/,
  dependencies: index === 0 ? deviceProjects.map((device) => device.name as string) : [chain[index - 1].name],
}));

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
    ...(reuseKeptStack
      ? []
      : [{ name: "unclaimed", testMatch: /bootstrap-protection\.spec\.ts/, use: { ...devices["Desktop Chrome"] } }]),
    // #1039: claims the stack once "unclaimed" above has finished, so any
    // other spec means what it says run alone with --spec against a fresh
    // stack instead of relying on an earlier spec in the same run having
    // claimed it first. See tests/e2e/claim.setup.ts for what it does and
    // does not cover (OIDC only) and why. #1150: on the --reuse path
    // "unclaimed" is dropped above, so this dependency would point at a
    // project that no longer exists -- drop it too, in the same condition.
    { name: "setup", testMatch: /.*\.setup\.ts/, dependencies: reuseKeptStack ? [] : ["unclaimed"] },
    ...deviceProjects,
    ...maintenanceProjects,
  ],
  outputDir: "../../test-results",
});
