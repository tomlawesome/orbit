// Local Vitest worker cap (#1864): a CI profile and a local profile for test
// concurrency, the local default sized from the CPU count, with an env var to
// override it.
//
// Local (CI unset): at most min(8, max(1, floor(cpus / 2))) workers, the
// setting that gives clean full runs on a shared host.
// CI set, no override: {} -- Vitest's own defaults, exactly as before.
// ORBIT_TEST_WORKERS=<1..64> sets the cap in both profiles; anything else
// throws, so the run stops at config load with a message naming the variable.
import os from "node:os";

const overridePattern = /^[0-9]+$/;

export function testWorkers({ env = process.env, cpus = os.availableParallelism() } = {}) {
  const override = env.ORBIT_TEST_WORKERS;
  if (override !== undefined) {
    const n = overridePattern.test(override) ? Number(override) : Number.NaN;
    if (!Number.isInteger(n) || n < 1 || n > 64) {
      throw new Error(
        `ORBIT_TEST_WORKERS must be a whole number from 1 to 64; got ${JSON.stringify(override)}.`,
      );
    }
    return { maxWorkers: n };
  }
  if (env.CI) return {};
  return { maxWorkers: Math.min(8, Math.max(1, Math.floor(cpus / 2))) };
}
