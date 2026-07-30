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
    },
  },
});
