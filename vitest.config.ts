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
    exclude: [
      ...configDefaults.exclude,
      ".agents/worktrees/**",
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
