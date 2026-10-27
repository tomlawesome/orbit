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
  // // measured on `dev` 230e6396, pipeline 3049, job `fast` 39963, 2026-10-27
  "scripts": { statements: 51, branches: 53, functions: 57, lines: 51 },
  // // measured on `dev` 230e6396, pipeline 3049, job `fast` 39963, 2026-10-27
  // the CLI is exercised by the install acceptance stacks, not unit tests;
  // below the 70-85 band and known
  "src/cli": { statements: 5, branches: 4, functions: 4, lines: 6 },
  // // measured on `dev` 230e6396, pipeline 3049, job `fast` 39963, 2026-10-27
  // migrations and schema; functions are covered by the `integration`
  // project, which runs without coverage
  "src/db": { statements: 48, branches: 62, functions: 13, lines: 48 },
  // // measured on `dev` 230e6396, pipeline 3049, job `fast` 39963, 2026-10-27
  "src/lib": { statements: 87, branches: 82, functions: 89, lines: 89 },
  // // measured on `dev` 230e6396, pipeline 3049, job `fast` 39963, 2026-10-27
  "src/server": { statements: 61, branches: 56, functions: 63, lines: 62 },
  // // measured on `dev` 230e6396, pipeline 3049, job `fast` 39963, 2026-10-27
  // kept as a sub-floor because it already had its own 75% statements
  // floor; floors only go up
  "src/server/documents": { statements: 76, branches: 74, functions: 77, lines: 78 },
};
