import { defineConfig, globalIgnores } from "eslint/config";
import svelte from "eslint-plugin-svelte";
import tseslint from "typescript-eslint";

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
  /* Was `eslint-config-next`'s two configs until the cut (#735). Next brought
     the TypeScript rules along with its React ones, so dropping it wholesale
     would have quietly ended TypeScript linting; `typescript-eslint` is the
     same ruleset without the framework. The React-specific rules go, because
     there is no React left to lint. */
  ...tseslint.configs.recommended,
  /* `eslint-config-next` honoured the `_name` convention for deliberately
     unused bindings; `typescript-eslint`'s bare recommended set does not, so
     restoring it here keeps the same code passing rather than loosening the
     rule (#735). */
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        ignoreRestSiblings: true,
      }],
    },
  },
  ...svelteRecommended,
  globalIgnores([
  // Sibling worktrees: a second checkout of this codebase, plus its build
  // output. Linting it reports another branch's errors as this one's (#769)
  ".claude/worktrees/**",
  // web/ build artefacts: gitignored output, not source (#419)
  "web/build/**", "web/.svelte-kit/**", "web/.preview/**", "web/test-results/**", "coverage/**", "drizzle/**", "dist/**",
  // Scratch prototypes (#995). AGENTS.md and the extraction handoffs send
  // agents here to prototype, and tmp/ is gitignored, so the files are both
  // expected to exist and expected to rot — they import modules that have
  // since been refactored. Checking them meant that following the
  // instructions broke the fast suite for the next session, which then read
  // a failure naming a scratch file and had to work out that nothing was
  // actually wrong. Nothing in tmp/ is built, shipped or imported by
  // anything that is.
  "tmp/**"]),
]);
