import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig, type TestUserConfig } from "vitest/config";

// The aliases both projects need. The engine's own tests reach it through "@",
// and the ported API routes reach two SvelteKit-isms that nothing resolves
// outside SvelteKit: a sibling through `$lib`, and the environment through the
// virtual `$env/dynamic/private` module (#735). Shared here so the two projects
// below cannot drift apart on them, which is what a second config file made
// easy.
const sharedAliases = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
  // SvelteKit's own alias, so the v19 unit tests in tests/unit can import a
  // web/ module that imports a sibling through $lib (#410). web/ test FILES
  // stay excluded below; only their subjects are reachable.
  $lib: fileURLToPath(new URL("./web/src/lib", import.meta.url)),
  // A virtual module SvelteKit generates, so nothing resolves it here; the
  // stub exposes the same live process environment the real one does.
  "$env/dynamic/private": fileURLToPath(
    new URL("./tests/support/env-dynamic-private.ts", import.meta.url),
  ),
};

// Written as a typed constant rather than inline: `project` below is declared
// on TestUserConfig, while a config file's `test` field is typed as the
// narrower InlineConfig, which omits it. Vitest resolves both out of the same
// merged configuration.
const test: TestUserConfig = {
  // Two projects, one config (#442). `default` is everything an ordinary
  // `pnpm exec vitest run` runs; `integration` is the suite that needs a real
  // PostgreSQL, and used to live in its own vitest.integration.config.ts.
  // Reaching it is deliberate -- `pnpm exec vitest run --project integration`,
  // which is what scripts/test-integration.mjs and the pipeline's
  // `integration` job call.
  //
  // `project` is why that suite does not join the default run: Vitest runs
  // every project when nothing filters them, and a plain `vitest run` has to
  // keep meaning what it meant before this fold -- no database required. A
  // --project on the command line overrides it.
  project: ["default"],
  projects: [
    {
      resolve: {
        alias: {
          ...sharedAliases,
          // The package-name form web/src files import the engine through
          // ("orbit/server/boot" etc, matching the root package.json `exports`
          // map). It only ever resolves once a real `pnpm install` links the
          // workspace self-reference; a worktree deliberately has none (#784),
          // so a web/ subject that imports the engine this way needs it
          // aliased here too, the same reason $lib and $env/dynamic/private
          // are (#717).
          orbit: fileURLToPath(new URL("./src", import.meta.url)),
          // hooks.server.js's `init` reads this to skip booting while the
          // adapter prerenders (#717); outside SvelteKit it is just a constant.
          "$app/environment": fileURLToPath(
            new URL("./tests/support/app-environment.ts", import.meta.url),
          ),
        },
      },
      test: {
        name: "default",
        environment: "node",
        // One temporary root per test file, removed when the file ends (#654).
        // The suites leaked every mkdtemp they made: ~88k directories filled
        // this host's /tmp and started failing runs with ENOSPC.
        setupFiles: ["./tests/support/temp-root.ts"],
        // Vitest's defaults (5s / 10s) already fail a hung test rather than the
        // whole job — pinned here, unchanged, so intent is explicit and can't
        // silently drift. A handful of tests that spawn real subprocesses
        // already declare their own longer `timeout` and are unaffected.
        testTimeout: 5_000,
        hookTimeout: 10_000,
        exclude: [
          ...configDefaults.exclude,
          ".agents/worktrees/**",
          // Same reason as .agents/worktrees/** above: a parallel agent's
          // checkout nested under here must never be collected as if it were
          // part of this tree — its state is someone else's in-progress work,
          // not this run's subject, and can otherwise fail or hang for reasons
          // that have nothing to do with this change (#572).
          ".claude/worktrees/**",
          "tests/e2e/**",
          "tests/integration/**",
          // web/ is a separate project with its own runners: its fidelity and
          // behaviour suites are Playwright, so collecting them here calls
          // Playwright's test() outside a Playwright runner and fails to
          // load (#425).
          "web/**",
        ],
      },
    },
    {
      resolve: { alias: sharedAliases },
      test: {
        name: "integration",
        environment: "node",
        exclude: [...configDefaults.exclude],
        include: ["tests/integration/**/*.test.ts"],
        fileParallelism: false,
        /* Not the 5s default: every test here creates a real PostgreSQL database
           and migrates it, so the default was never a plausible budget and the
           suite only passed while the runner was quiet. On pipeline 605 the
           migration baseline test took 5,764ms against it and failed, naming a
           timeout rather than the contention that actually caused it (#880).

           15s is sized as a hang detector, not a performance budget: measured on
           a green run, the median test takes 403ms and the 95th percentile 1.2s,
           and a loaded host stretches that by about 4x. So no honest test can
           reach 15s, and a genuinely stuck one still reports promptly.

           A test whose *duration is the assertion* keeps its own explicit value
           instead -- notification-worker's blackholed-SMTP test at `}, 20_000)`
           is the pattern, and 32 tests already follow it. Tightening this default
           per test would buy nothing but reintroduce the flake above. */
        testTimeout: 15_000,
        hookTimeout: 15_000,
      },
    },
  ],
  // Reporters and coverage are root-only options -- Vitest rejects either
  // inside a project -- so they apply to whichever projects run.
  //
  // Diagnose stalls instead of letting them die silently on the CI job
  // timeout (#572). "default" is the normal pass/fail report; the other
  // two only add output when something is actually stuck:
  //  - the local progress reporter prints each file/test as it *starts*,
  //    so the last line in a stalled log names the culprit directly;
  //  - "hanging-process" is Vitest's own built-in diagnostic for the case
  //    where every test finished but the process still won't exit (an
  //    open handle — timer, socket, child process). Vitest recommends it
  //    by name for exactly that symptom.
  reporters: ["default", "hanging-process", "./scripts/vitest-progress-reporter.mjs"],
  coverage: {
    provider: "v8",
    include: ["src/**/*.{ts,tsx}", "scripts/*.mjs"],
    exclude: ["src/**/*.test.ts", "scripts/*.test.mjs"],
    reporter: ["text-summary", "json-summary", "html"],
    reportsDirectory: "coverage",
    // Ratchet, not target (#302): floors sit just under the measured
    // baseline so CI fails on regression while no percentage is ever a goal
    // in itself. Raise floors when a phase durably lifts a layer; never
    // lower them to make a change pass.
    //
    // Re-pinned once at the cut (#735), which is the one case the
    // architecture ruling allows: deleting src/app and src/components
    // removed ~5000 largely untested statements, so the denominator changed
    // rather than the testing. Measured on the cut commit: 50.34%
    // statements, 48.3% branches, 51.68% functions, 52.04% lines. The
    // previous global floors (28/28/26/29) were set against a codebase that
    // no longer exists and would now pass while half the engine went
    // untested.
    thresholds: {
      statements: 50,
      branches: 48,
      functions: 51,
      lines: 51,
      "src/lib/**": { statements: 60 },
      "src/server/documents/**": { statements: 75 },
    },
  },
};

export default defineConfig({ test });
