import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([".next/**",
  // web/ build artefacts: gitignored output, not source (#419)
  "web/build/**", "web/.svelte-kit/**", "web/.preview/**", "web/test-results/**", "coverage/**", "drizzle/**", "dist/**"]),
]);
