import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import svelte from "eslint-plugin-svelte";

// eslint-plugin-svelte's own `flat/recommended` config leaves some entries
// without a `files` glob (it is designed to be spread at the top of a config
// array so those entries apply to everything). Pin every entry to `.svelte`
// explicitly instead, so this addition can never touch the JS/TS rules above
// (#620).
const svelteRecommended = svelte.configs["flat/recommended"].map((config) => ({
  ...config,
  files: config.files ?? ["**/*.svelte"],
}));

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  ...svelteRecommended,
  globalIgnores([".next/**",
  // web/ build artefacts: gitignored output, not source (#419)
  "web/build/**", "web/.svelte-kit/**", "web/.preview/**", "web/test-results/**", "coverage/**", "drizzle/**", "dist/**"]),
]);
