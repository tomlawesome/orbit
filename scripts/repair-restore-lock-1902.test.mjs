import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ACTIONS, IMAGE_COMPOSE, runOwner } from "./repair-owner-fixtures.mjs";
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
    // Limit 10 s; the owner's sync (6 s) and then mv (6 s) each fit the limit, together they do not. The mv shim
    // tries a non-blocking flock on the scratch file after its own wait, i.e. well past the limit: "held" means the
    // lock is still taken by the restore, "free" means it lapsed. #1933: it was 3 s with 2.5 s waits, and a loaded
    // runner pushed the mv past its limit before the probe ran; each step now has 4 s of room.
    const slow = (tool, check) => {
      writeFileSync(join(shimDir, tool), [
        "#!/usr/bin/env bash",
        'if [[ "${ORBIT_TEST_PRIVDROP:-0}" == 1 && "$*" == *.repair.* ]]; then',
        "  sleep 6",
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
      const result = runOwner(targetDir, { shims, state, fakeBin, env: { ORBIT_REPAIR_OWNER_STEP_TIMEOUT: "10", PATH: `${shimDir}:${shims.env.PATH}` }, capSeconds: 60 });
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

describe("#1902 L1: a lock lost mid-restore fails the restore loudly", () => {
  /** An owner-side shim for `tool` that, on the scratch file, kills the owner-lock holder (before or after the real tool). */
  function killHolder(tool, when) {
    const dir = scratchDir("orbit-1902-kill-");
    // Only this run's holder: it is started as `bash -c <script> owner-lock <scratch file>`, so match on that file.
    const kill = `pkill -KILL -f -- "owner-lock $f\$"; sleep 1`;
    writeFileSync(join(dir, tool), [
      "#!/usr/bin/env bash",
      `if [[ "\${ORBIT_TEST_PRIVDROP:-0}" == 1 && "$*" == *.repair.* ]]; then`,
      `  f=""; for a in "$@"; do [[ "$a" == *.docker-compose.yml.repair.* ]] && f="$a"; done`,
      when === "before" ? `  ${kill}` : `  '${realTool(tool)}' "$@"; rc=$?; ${kill}; exit $rc`,
      "fi",
      `exec '${realTool(tool)}' "$@"`,
      "",
    ].join("\n"));
    chmodSync(join(dir, tool), 0o755);
    return dir;
  }

  it("as root, a holder that ends before the rename fails the restore with a lost-lock line and no rename", () => {
    const { targetDir, state, fakeBin } = compose.make();
    const dir = killHolder("sync", "before");
    const shims = privShims(targetDir);
    try {
      const result = runOwner(targetDir, { shims, state, fakeBin, env: { PATH: `${dir}:${shims.env.PATH}` }, capSeconds: 40 });
      expect(result.hung, result.stderr.slice(0, 600)).toBe(false);
      expect(result.stdout).not.toContain(compose.done);
      expect(orbitLines(result).some((line) => /lock/iu.test(line) && /lost/iu.test(line)), `no lost-lock line:\n${result.stderr.slice(0, 1500)}`).toBe(true);
      expect(existsSync(join(targetDir, "docker-compose.yml")), "the rename happened without the lock").toBe(false);
      expect(readdirSync(targetDir).filter((name) => name.startsWith(".docker-compose.yml.repair")), "a scratch file was left behind").toEqual([]);
    } finally {
      shims.cleanup();
    }
  });

  it("as root, a holder that ends after the rename landed fails the restore with the 'already in place' line, the restored file kept", () => {
    const { targetDir, state, fakeBin } = compose.make();
    const dir = killHolder("mv", "after");
    const shims = privShims(targetDir);
    try {
      const result = runOwner(targetDir, { shims, state, fakeBin, env: { PATH: `${dir}:${shims.env.PATH}` }, capSeconds: 40 });
      expect(result.hung, result.stderr.slice(0, 600)).toBe(false);
      expect(result.stdout).not.toContain(compose.done);
      expect(orbitLines(result).some((line) => /lock/iu.test(line) && /already in place/iu.test(line)), `no 'already in place' line:\n${result.stderr.slice(0, 1500)}`).toBe(true);
      expect(Buffer.compare(readFileSync(join(targetDir, "docker-compose.yml")), Buffer.from(IMAGE_COMPOSE))).toBe(0);
    } finally {
      shims.cleanup();
    }
  });
});

describe("#1902 L3: root's sweep listing", () => {
  it("as root, never applies a link-following test to a scratch-shape name (a link to a FIFO included): no hang", () => {
    const { targetDir, state, fakeBin } = compose.make();
    const outside = scratchDir("orbit-1902-fifo-");
    const fifo = join(outside, "hung");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const link = ".docker-compose.yml.repair.Fifo01";
    symlinkSync(fifo, join(targetDir, link));
    // A DEBUG trap (BASH_ENV, set -T so functions and subshells inherit it) records every command root's bash runs
    // while the sweep function is on the stack. Owner children (ORBIT_TEST_PRIVDROP=1) are not root's reads.
    const hook = scratchDir("orbit-1902-hook-");
    const trace = join(hook, "root-sweep.log");
    writeFileSync(join(hook, "env.sh"), [
      "set -T",
      `trap '[[ "\${ORBIT_TEST_PRIVDROP:-0}" == 1 ]] || { [[ " \${FUNCNAME[*]} " == *" sweep_compose_restore_scratch "* ]] && printf "%s\\n" "$BASH_COMMAND" >> '${trace}'; }' DEBUG`,
      "",
    ].join("\n"));
    const shims = privShims(targetDir);
    try {
      const result = runOwner(targetDir, { shims, state, fakeBin, env: { BASH_ENV: join(hook, "env.sh") }, capSeconds: 30 });
      expect(result.hung, `repair hung:\n${result.stderr.slice(0, 600)}`).toBe(false);
      expect(result.stdout, result.stderr).toContain(compose.done);
      const commands = existsSync(trace) ? readFileSync(trace, "utf8").split("\n").filter(Boolean) : [];
      expect(commands.length, "the hook saw no command of root's sweep").toBeGreaterThan(0);
      // Follow-capable: [[ / [ / test with -f -e -d -s -r -w -x -p -S -b -c -a, stat -L, find -L/-H/-follow.
      const following = commands.filter((command) => /(?:\[\[|\[|\btest)\s(?:[^\n]*\s)?-[fedsrwxpSbca]\s|\bstat\s+(?:\S+\s+)*-L\b|\bfind\s+(?:\S+\s+)*(?:-L|-H|-follow)\b/u.test(command));
      expect(following, `root applied a link-following test:\n${following.join("\n")}`).toEqual([]);
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
