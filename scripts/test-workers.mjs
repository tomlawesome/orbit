// Local Vitest worker cap (#1864): a CI profile and a local profile for test
// concurrency, the local default sized from the CPU count, with an env var to
// override it.
//
// Local (CI unset): at most min(8, max(1, floor(cpus / 2))) workers, the
// setting that gives clean full runs on a shared host.
// CI set, no override (#1933): at most min(8, max(1, floor(q / 2))) workers,
// where q = min(CPU quota, cpus). Node's availableParallelism ignores cgroup
// CPU quotas, so the quota is read from cgroup v2 /sys/fs/cgroup/cpu.max
// ("<quota> <period>", rounded down, minimum 1). "max", a missing or
// unreadable file, or malformed contents mean q = cpus.
// ORBIT_TEST_WORKERS=<1..64> sets the cap in both profiles; anything else
// throws, so the run stops at config load with a message naming the variable.
import { readFileSync } from "node:fs";
import os from "node:os";

const overridePattern = /^[0-9]+$/;

function readCpuMax() {
  try {
    return readFileSync("/sys/fs/cgroup/cpu.max", "utf8");
  } catch {
    return undefined;
  }
}

function quotaCpus(cpuMax, cpus) {
  if (typeof cpuMax !== "string") return cpus;
  const m = /^([0-9]+) ([0-9]+)(?:\r?\n)?$/.exec(cpuMax);
  if (!m) return cpus;
  const quota = Number(m[1]);
  const period = Number(m[2]);
  if (quota < 1 || period < 1) return cpus;
  return Math.min(cpus, Math.max(1, Math.floor(quota / period)));
}

export function testWorkers(options = {}) {
  const { env = process.env, cpus = os.availableParallelism() } = options;
  // An explicit `cpuMax: undefined` means "no quota file"; only an absent key reads the real one.
  const cpuMax = Object.hasOwn(options, "cpuMax") ? options.cpuMax : readCpuMax();
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
  if (env.CI) {
    const q = quotaCpus(cpuMax, cpus);
    return { maxWorkers: Math.min(8, Math.max(1, Math.floor(q / 2))) };
  }
  return { maxWorkers: Math.min(8, Math.max(1, Math.floor(cpus / 2))) };
}
