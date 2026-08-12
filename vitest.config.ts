import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: [
      ...configDefaults.exclude,
      ".agents/worktrees/**",
      "tests/e2e/**",
      "tests/integration/**",
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
