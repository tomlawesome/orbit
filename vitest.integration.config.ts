import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      /* The two SvelteKit-isms the ported API routes need (#735). The suites
         call the real route modules now, and those import a sibling through
         `$lib` and read the environment through `$env/dynamic/private`, which
         is a virtual module nothing resolves outside SvelteKit. Kept in step
         with `vitest.config.ts`, which needs them for the same reason. */
      $lib: fileURLToPath(new URL("./web/src/lib", import.meta.url)),
      "$env/dynamic/private": fileURLToPath(
        new URL("./tests/support/env-dynamic-private.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude],
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    coverage: { enabled: false },
  },
});
