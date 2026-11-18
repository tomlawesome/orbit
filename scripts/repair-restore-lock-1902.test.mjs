import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ACTIONS, runOwner } from "./repair-owner-fixtures.mjs";
import { privShims, realTool } from "./repair-priv-shims.mjs";
import { scratchDir } from "./repair-test-harness.mjs";

// #1902 (spec: issue body, L1/L2/L3 and the Must). Run as simulated root (the setpriv shim of repair-priv-shims.mjs)
// in the compose restore, the way repair-owner-lows-1873.test.mjs does.
//   L1 the restore's scratch-file lock is held for the whole restore, or its loss fails the restore loudly
//   L3 root's sweep listing never stats through a scratch-shape link, and is bounded in count and reported

vi.setConfig({ testTimeout: 90_000 });

const compose = ACTIONS["restore-compose-file"];
const orbitLines = (result) => result.stderr.split("\n").filter((line) => line.startsWith("Orbit repair:"));

describe("#1902 L1: the compose-restore lock does not lapse silently", () => {
  it("as root, a restore whose steps outlast the owner step limit still holds the scratch-file lock, or fails with an 'Orbit repair:' line", () => {
    const { targetDir, state, fakeBin } = compose.make();
    const shimDir = scratchDir("orbit-1902-slow-");
    const log = join(shimDir, "lock.log");
    // Limit 3 s; the owner's sync (2.5 s) and then mv (2.5 s) each fit the limit, together they do not. The mv shim
    // tries a non-blocking flock on the scratch file after its own wait, i.e. well past the limit: "held" means the
    // lock is still taken by the restore, "free" means it lapsed.
    const slow = (tool, check) => {
      writeFileSync(join(shimDir, tool), [
        "#!/usr/bin/env bash",
        'if [[ "${ORBIT_TEST_PRIVDROP:-0}" == 1 && "$*" == *.repair.* ]]; then',
        "  sleep 2.5",
        check ? `  f=""; for a in "$@"; do [[ "$a" == *.docker-compose.yml.repair.* ]] && f="$a"; done` : "",
        check ? `  if '${realTool("flock")}' -n "$f" true 2>/dev/null; then echo free >> '${log}'; else echo held >> '${log}'; fi` : "",
        "fi",
        `exec '${realTool(tool)}' "$@"`,
        "",
      ].join("\n"));
      chmodSync(join(shimDir, tool), 0o755);
    };
    slow("sync", false);
    slow("mv", true);
    const shims = privShims(targetDir);
    try {
      const result = runOwner(targetDir, { shims, state, fakeBin, env: { ORBIT_REPAIR_OWNER_STEP_TIMEOUT: "3", PATH: `${shimDir}:${shims.env.PATH}` }, capSeconds: 60 });
      expect(result.hung, result.stderr.slice(0, 600)).toBe(false);
      const seen = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      const held = seen.length > 0 && seen.every((line) => line === "held");
      const loud = result.status !== 0 && !result.stdout.includes(compose.done) && orbitLines(result).some((line) => /lock/iu.test(line));
      expect(held || loud, `the lock lapsed silently (probes: ${JSON.stringify(seen)}, status ${result.status}):\n${result.stderr.slice(0, 1500)}`).toBe(true);
    } finally {
      shims.cleanup();
    }
  });
});

describe("#1902 L3: root's sweep listing", () => {
  it("as root, never stats through a scratch-shape link (a link to a FIFO included): no hang, no following stat", () => {
    const strace = realTool("strace");
    if (!strace) throw new Error("strace is needed to see root's stats");
    const { targetDir, state, fakeBin } = compose.make();
    const outside = scratchDir("orbit-1902-fifo-");
    const fifo = join(outside, "hung");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const link = ".docker-compose.yml.repair.Fifo01";
    symlinkSync(fifo, join(targetDir, link));
    // `bash repair.sh` runs under strace (file calls only); other bash runs are plain.
    const shimDir = scratchDir("orbit-1902-strace-");
    const trace = join(shimDir, "trace.log");
    writeFileSync(join(shimDir, "bash"), [
      "#!/bin/sh",
      `case "$1" in */scripts/repair.sh) exec '${strace}' -f -qq -s 4096 -e trace=%file,%stat,%lstat -o '${trace}' ${realTool("bash")} "$@";; esac`,
      `exec '${realTool("bash")}' "$@"`,
      "",
    ].join("\n"));
    chmodSync(join(shimDir, "bash"), 0o755);
    const shims = privShims(targetDir);
    try {
      const result = runOwner(targetDir, { shims, state, fakeBin, env: { PATH: `${shimDir}:${shims.env.PATH}` }, capSeconds: 30 });
      expect(result.hung, `repair hung:\n${result.stderr.slice(0, 600)}`).toBe(false);
      expect(result.stdout, result.stderr).toContain(compose.done);
      const lines = readFileSync(trace, "utf8").split("\n");
      // Owner children (their execve names owner-sweep) may do what they like; root's own processes must not.
      const owner = new Set(lines.filter((line) => /execve\(.*"owner-sweep"/u.test(line)).map((line) => line.split(" ")[0]));
      const following = lines.filter((line) => line.includes("Fifo01") && /stat|access/u.test(line) && !/NOFOLLOW|lstat\(/u.test(line) && !owner.has(line.split(" ")[0]));
      expect(following, `root stat'd through the link:\n${following.join("\n")}`).toEqual([]);
      expect(existsSync(join(targetDir, link))).toBe(true);
    } finally {
      shims.cleanup();
    }
  });

  // 1,000 scratch-shape names: above any sane sweep bound (the fix sets one). Unbounded, the shimmed owner sweep
  // takes about a minute, hence the long cap; a bounded sweep is quick.
  const FLOOD = 1000;
  it(`as root, a flood of ${FLOOD} scratch-shape names is bounded and the cap is reported (no 'Argument list too long')`, { timeout: 200_000 }, () => {
    const { targetDir, state, fakeBin } = compose.make();
    for (let index = 0; index < FLOOD; index += 1) writeFileSync(join(targetDir, `.docker-compose.yml.repair.F${String(index).padStart(5, "0")}`), "x\n");
    const shims = privShims(targetDir);
    try {
      const result = runOwner(targetDir, { shims, state, fakeBin, capSeconds: 170 });
      expect(result.hung, result.stderr.slice(0, 600)).toBe(false);
      expect(result.stderr).not.toMatch(/argument list too long/iu);
      expect(result.stdout, result.stderr).toContain(compose.done);
      const sweeps = shims.setprivCalls().filter((line) => line.includes("owner-sweep"));
      const passed = sweeps.reduce((sum, line) => sum + (line.match(/\.docker-compose\.yml\.repair\./gu) ?? []).length, 0);
      expect(passed, "the sweep took every name: it is not bounded").toBeLessThan(FLOOD);
      expect(orbitLines(result).some((line) => /sweep|scratch/iu.test(line) && /(cap|limit|first|too many|more than|\d{2,})/iu.test(line)), `the cap was not reported:\n${result.stderr.slice(0, 1500)}`).toBe(true);
      expect(readdirSync(targetDir).length).toBeGreaterThan(0);
    } finally {
      shims.cleanup();
    }
  });
});
