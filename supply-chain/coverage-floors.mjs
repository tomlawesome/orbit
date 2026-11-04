// Per-directory coverage floors (#1099). Read by vitest.config.ts (the lower
// bound Vitest enforces) and by scripts/ci/coverage-floor-check.mjs (which adds
// the upper bound, `headroom`).
//
// Rules:
// - A floor is the measured value rounded down, never an aspiration.
// - Floors only go up. A change that needs a lower floor needs more tests.
// - Measure the way CI's `fast` job does, because a local run with the Docker
//   suites included moves the numbers:
//     ORBIT_TEST_COVERAGE=true ORBIT_TEST_SKIP_DOCKER=true bash scripts/test-backend.sh
//   then read coverage/coverage-summary.json.
//
// Keys are directory prefixes relative to the repo root, no trailing slash.

export const headroom = 5;

export const floors = {
  // measured on `dev` 230e6396, pipeline 3049, job `fast` 39963, 2026-10-27
  "scripts": { statements: 51, branches: 53, functions: 57, lines: 51 },
  // measured on `dev` 230e6396, pipeline 3049, job `fast` 39963, 2026-10-27
  // the CLI is exercised by the install acceptance stacks, not unit tests;
  // below the 70-85 band and known
  "src/cli": { statements: 5, branches: 4, functions: 4, lines: 6 },
  // re-measured on `dev` 582a0d58, pipeline 3069, job `fast` 40245, 2026-10-28
  // (#1540): the 2026-10-27 values came from a `dev` without !1102, which added
  // code here; the owner ruled the introduction measurement stale, so this is
  // the floor's true starting value, not a lowering
  // migrations and schema; functions are covered by the `integration`
  // project, which runs without coverage
  // branches raised to 66 from MR pipeline 3284, job `fast` 42754, 2026-10-31
  // (measured 66.15 on fix/v033-eighth-batch 7023c8a3)
  // raised on fix/v037-three-flakes 4d2b91b3, local run the `fast` way,
  // 2026-11-04 (#1066: rewrap-kek.test.ts): measured 62.95/83.08/20.90/62.46
  "src/db": { statements: 62, branches: 83, functions: 20, lines: 62 },
  // measured on batch/v037-1 a5d0141f, run locally, 2026-11-04 (#1618): new
  // with the what's-new routes; types and constants only, so branches and
  // functions have no totals (the check skips a metric with none)
  "src/release-notes": { statements: 100, branches: 0, functions: 0, lines: 100 },
  // measured on `dev` 230e6396, pipeline 3049, job `fast` 39963, 2026-10-27
  "src/lib": { statements: 87, branches: 82, functions: 89, lines: 89 },
  // measured on `dev` 230e6396, pipeline 3049, job `fast` 39963, 2026-10-27
  "src/server": { statements: 61, branches: 56, functions: 63, lines: 62 },
  // measured on `dev` 230e6396, pipeline 3049, job `fast` 39963, 2026-10-27
  // kept as a sub-floor because it already had its own 75% statements
  // floor; floors only go up
  "src/server/documents": { statements: 76, branches: 74, functions: 77, lines: 78 },
  // measured on fix/v037-three-flakes 4d2b91b3, run the `fast` way locally,
  // 2026-11-04 (#1066): web/src newly in coverage; check it against the first
  // push to `dev` (merge requests run without coverage)
  // functions set to 75 from batch/v037-1 a5d0141f, measured locally the same
  // way, 2026-11-04 (functions 75.91): the batch's other lanes added web/src
  // code; the 76 never reached `dev`, so this is the starting value, not a
  // lowering (as #1540)
  "web/src": { statements: 76, branches: 71, functions: 75, lines: 79 },
};
