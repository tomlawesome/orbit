import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // SvelteKit's own alias, so the v19 unit tests in tests/unit can import
      // a web/ module that imports a sibling through $lib (#410). web/ test
      // FILES stay excluded below; only their subjects are reachable.
      $lib: fileURLToPath(new URL("./web/src/lib", import.meta.url)),
    },
  },
  test: {
    environment: "node",
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
      // Playwright's test() outside a Playwright runner and fails to load (#425).
      "web/**",
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "scripts/*.mjs"],
      exclude: ["src/**/*.test.ts", "scripts/*.test.mjs"],
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "coverage",
      // Ratchet, not target (#302): floors sit just under the measured
      // baseline (2026-08-12: global 29.5% statements; src/lib 64%;
      // src/server/documents 79%) so CI fails on regression while no
      // percentage is ever a goal in itself. Raise floors when a phase
      // durably lifts a layer; never lower them to make a change pass.
      thresholds: {
        statements: 28,
        branches: 28,
        functions: 26,
        lines: 29,
        "src/lib/**": { statements: 60 },
        "src/server/documents/**": { statements: 75 },
      },
    },
  },
});
