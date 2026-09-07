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
    /* Not the 5s default: every test here creates a real PostgreSQL database
       and migrates it, so the default was never a plausible budget and the
       suite only passed while the runner was quiet. On pipeline 605 the
       migration baseline test took 5,764ms against it and failed, naming a
       timeout rather than the contention that actually caused it (#880).

       15s is sized as a hang detector, not a performance budget: measured on
       a green run, the median test takes 403ms and the 95th percentile 1.2s,
       and a loaded host stretches that by about 4x. So no honest test can
       reach 15s, and a genuinely stuck one still reports promptly.

       A test whose *duration is the assertion* keeps its own explicit value
       instead -- notification-worker's blackholed-SMTP test at `}, 20_000)`
       is the pattern, and 32 tests already follow it. Tightening this default
       per test would buy nothing but reintroduce the flake above. */
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: { enabled: false },
  },
});
