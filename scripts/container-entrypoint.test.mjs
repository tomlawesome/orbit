import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// #1429 (review finding B1): under the 2 GB container limit Node 22 sizes its
// own heap to about 1 GB, so a maximum-size archive import (about 1 GB peak)
// can run out of heap on every retry while the container still has room. The
// entrypoint therefore sets --max-old-space-size to 70% of the container's
// memory limit, read from cgroup v2 (memory.max) or cgroup v1
// (memory/memory.limit_in_bytes) under ORBIT_CGROUP_ROOT (default
// /sys/fs/cgroup), unless the operator's NODE_OPTIONS already sets it. The
// only visible behaviour is the NODE_OPTIONS the exec'd process receives.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const entrypoint = readFileSync(new URL("./container-entrypoint.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n");

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const UNSET = "<unset>";

const scratch = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * A scratch install the real entrypoint can run in without root, a Docker
 * secrets mount or su-exec. Faked, and why:
 *  - the two fixed secret paths (/run/secrets, /run/orbit-secrets) are
 *    rewritten to scratch directories in a copy of the script, because they
 *    are readonly constants and the test host has neither;
 *  - `id` reports uid 0 and `chown` does nothing, because the script insists
 *    on starting as root and the test user is not root;
 *  - `su-exec` prints the NODE_OPTIONS it was exec'd with and exits, which is
 *    the one behaviour under test.
 * The cgroup tree is a scratch directory selected with ORBIT_CGROUP_ROOT.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "orbit-entrypoint-heap-"));
  scratch.push(root);
  const scripts = join(root, "scripts");
  const shims = join(root, "shims");
  const sourceSecrets = join(root, "run-secrets");
  const runtimeSecrets = join(root, "run-orbit-secrets");
  const cgroup = join(root, "cgroup");
  for (const dir of [scripts, shims, sourceSecrets, runtimeSecrets, cgroup]) mkdirSync(dir);

  const script = entrypoint
    .replace('readonly source_directory="/run/secrets"', `readonly source_directory="${sourceSecrets}"`)
    .replace('readonly runtime_directory="/run/orbit-secrets"', `readonly runtime_directory="${runtimeSecrets}"`);
  expect(script).not.toBe(entrypoint);
  writeFileSync(join(scripts, "container-entrypoint.sh"), script, "utf8");
  writeFileSync(join(root, "VERSION"), "v1.2.3\n");
  writeFileSync(join(root, "REVISION"), `${"a".repeat(40)}\n`);
  writeFileSync(join(root, "CHANNEL"), "preview\n");
  writeFileSync(join(sourceSecrets, "orbit-test-secret"), "not-a-real-secret\n");

  const shim = (name, body) => {
    writeFileSync(join(shims, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(shims, name), 0o755);
  };
  shim("id", "echo 0");
  shim("chown", "exit 0");
  shim("su-exec", `printf 'NODE_OPTIONS=[%s]\\n' "\${NODE_OPTIONS-${UNSET}}"`);

  return {
    root,
    cgroup,
    writeV2(text) {
      writeFileSync(join(cgroup, "memory.max"), text);
    },
    writeV1(text) {
      mkdirSync(join(cgroup, "memory"), { recursive: true });
      writeFileSync(join(cgroup, "memory", "memory.limit_in_bytes"), text);
    },
    /** Runs the entrypoint to its exec and returns the NODE_OPTIONS it handed over. */
    run({ nodeOptions, cgroupRoot = cgroup, extraEnv = {} } = {}) {
      const env = {
        PATH: `${shims}:/usr/bin:/bin`,
        ...(cgroupRoot === null ? {} : { ORBIT_CGROUP_ROOT: cgroupRoot }),
        ...(nodeOptions === undefined ? {} : { NODE_OPTIONS: nodeOptions }),
        ...extraEnv,
      };
      const result = failOnProcessDeadline(
        spawnSync("sh", [join(scripts, "container-entrypoint.sh"), "node", "fake-app.js"], {
          encoding: "utf8",
          env,
          ...processGuard(),
        }),
        { label: "container entrypoint heap sizing" },
      );
      expect(result.status, `entrypoint failed during setup: ${result.stderr}`).toBe(0);
      const line = result.stdout.split("\n").find((l) => l.startsWith("NODE_OPTIONS=["));
      expect(line, `the fake su-exec was never reached; stdout: ${result.stdout}`).toBeDefined();
      return line.slice("NODE_OPTIONS=[".length, -1);
    },
  };
}

describe("the entrypoint sizes Node's heap from the container memory limit (#1429)", () => {
  it("sets the heap to 70% of a 2 GiB cgroup v2 limit: 1433 MiB", () => {
    const f = fixture();
    f.writeV2(`${2 * GIB}\n`);
    expect(f.run()).toBe("--max-old-space-size=1433");
  });

  it("rounds down to whole MiB for other limits (1 GiB -> 716, 3 GiB -> 2150)", () => {
    const f = fixture();
    f.writeV2(`${1 * GIB}\n`);
    expect(f.run()).toBe("--max-old-space-size=716");
    f.writeV2(`${3 * GIB}\n`);
    expect(f.run()).toBe("--max-old-space-size=2150");
  });

  it("falls back to the cgroup v1 limit when there is no v2 file", () => {
    const f = fixture();
    f.writeV1(`${4 * GIB}\n`);
    expect(f.run()).toBe("--max-old-space-size=2867");
  });

  it("prefers the cgroup v2 limit when both versions are present", () => {
    const f = fixture();
    f.writeV2(`${2 * GIB}\n`);
    f.writeV1(`${4 * GIB}\n`);
    expect(f.run()).toBe("--max-old-space-size=1433");
  });

  it("appends to an existing NODE_OPTIONS instead of replacing it", () => {
    const f = fixture();
    f.writeV2(`${2 * GIB}\n`);
    expect(f.run({ nodeOptions: "--trace-warnings" })).toBe("--trace-warnings --max-old-space-size=1433");
  });

  it("leaves NODE_OPTIONS alone when it already sets --max-old-space-size (the operator's setting wins)", () => {
    const f = fixture();
    f.writeV2(`${2 * GIB}\n`);
    // Positive control: the same limit does size the heap when nothing is set.
    expect(f.run()).toBe("--max-old-space-size=1433");
    expect(f.run({ nodeOptions: "--max-old-space-size=900" })).toBe("--max-old-space-size=900");
    expect(f.run({ nodeOptions: "--trace-warnings --max-old-space-size=900 --no-deprecation" })).toBe(
      "--trace-warnings --max-old-space-size=900 --no-deprecation",
    );
  });

  it("changes nothing when the v2 limit is the word max", () => {
    const f = fixture();
    f.writeV2(`${2 * GIB}\n`);
    expect(f.run()).toBe("--max-old-space-size=1433");
    f.writeV2("max\n");
    expect(f.run()).toBe(UNSET);
    expect(f.run({ nodeOptions: "--trace-warnings" })).toBe("--trace-warnings");
  });

  it("changes nothing when the cgroup root does not exist", () => {
    const f = fixture();
    f.writeV2(`${2 * GIB}\n`);
    expect(f.run()).toBe("--max-old-space-size=1433");
    expect(f.run({ cgroupRoot: join(f.root, "no-such-cgroup") })).toBe(UNSET);
    expect(f.run({ cgroupRoot: join(f.root, "no-such-cgroup"), nodeOptions: "--trace-warnings" })).toBe("--trace-warnings");
  });

  it("changes nothing when the limit file is empty or not a number", () => {
    const f = fixture();
    f.writeV2(`${2 * GIB}\n`);
    expect(f.run()).toBe("--max-old-space-size=1433");
    f.writeV2("");
    expect(f.run()).toBe(UNSET);
    f.writeV2("lots\n");
    expect(f.run()).toBe(UNSET);
    f.writeV2("2g\n");
    expect(f.run()).toBe(UNSET);
  });

  it("changes nothing when the limit file cannot be read", () => {
    const f = fixture();
    f.writeV2(`${2 * GIB}\n`);
    expect(f.run()).toBe("--max-old-space-size=1433");
    // A directory where the file should be is unreadable as a number.
    rmSync(join(f.cgroup, "memory.max"));
    mkdirSync(join(f.cgroup, "memory.max"));
    expect(f.run()).toBe(UNSET);
  });

  it("changes nothing when v2 says max and there is no v1 file", () => {
    const f = fixture();
    f.writeV1(`${2 * GIB}\n`);
    expect(f.run()).toBe("--max-old-space-size=1433");
    rmSync(join(f.cgroup, "memory"), { recursive: true });
    f.writeV2("max\n");
    expect(f.run()).toBe(UNSET);
  });

  it("treats the cgroup v1 no-limit value 9223372036854771712 as no limit", () => {
    const f = fixture();
    f.writeV1(`${2 * GIB}\n`);
    expect(f.run()).toBe("--max-old-space-size=1433");
    f.writeV1("9223372036854771712\n");
    expect(f.run()).toBe(UNSET);
    expect(f.run({ nodeOptions: "--trace-warnings" })).toBe("--trace-warnings");
  });

  it("treats a limit of exactly 1 TiB (1099511627776 bytes) as no limit", () => {
    const f = fixture();
    f.writeV2(`${2 * GIB}\n`);
    expect(f.run()).toBe("--max-old-space-size=1433");
    f.writeV2("1099511627776\n");
    expect(f.run()).toBe(UNSET);
    expect(f.run({ nodeOptions: "--trace-warnings" })).toBe("--trace-warnings");
  });
});
