import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ACTIONS, IMAGE_COMPOSE, composeFolder, runOwner } from "./repair-owner-fixtures.mjs";
import { privShims, realTool } from "./repair-priv-shims.mjs";
import { composeUpCalls, scratchDir, treeSnapshot } from "./repair-test-harness.mjs";

// #1873 (spec: note on the issue, X1-X5): the Low gaps the inline review of the #1857/#1858 owner-write fix found.
// Run as root in a folder another user owns (root is simulated by the setpriv shim of repair-priv-shims.mjs, a
// pass-through that runs the command as the current user; the real `timeout` and `setsid --wait` are used):
//   X1 an owner write never leaves its temp file when the owner step stops, stalls, ignores TERM or floods;
//      root picks the full temp name, the owner creates it exclusively
//   X2 the compose restore's final rename never lands inside a directory
//   X3 opening the backup/restore lock never blocks and never follows a swapped link
//   X4 the image's docker-compose.yml is capped at 1 MiB while it streams
//   X5 the real limits are exercised against a SIGSTOPped and a TERM-proof owner child
// Written from the spec alone.

vi.setConfig({ testTimeout: 90_000 });

const LIMIT = { ORBIT_REPAIR_OWNER_STEP_TIMEOUT: "2" };
// The limit (2 s) plus the kill grace (5 s) plus a loaded host's start-up.
const BUDGET_MS = 20_000;
const LOCK = ["backups", ".orbit-backup-restore.lock"];
const REAL_FAILED = (action) => action.done.replace("result=done", "result=failed");
const orbitLines = (result) => result.stderr.split("\n").filter((line) => line.startsWith("Orbit repair:"));

/** Every owner-write temp file (any suffix of 6 or more characters) anywhere under the folder. */
function leftovers(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (/\.(repair|repair-restore|retire-smtp|smtp-copy)\.[A-Za-z0-9_-]{6,}$/u.test(entry.name)) found.push(path);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(dir);
  return found;
}

const VEHICLES = {
  "restore-compose-file (.docker-compose.yml.repair.*)": { make: () => ACTIONS["restore-compose-file"].make(), action: ACTIONS["restore-compose-file"] },
  "the .env-orbit restore (.env-orbit.repair-restore.*)": { make: () => ACTIONS["restore-config-rollback"].make(), action: ACTIONS["restore-config-rollback"] },
};

/**
 * A `cat` that, when run by the owner (ORBIT_TEST_PRIVDROP=1, set by the setpriv shim) stops itself or ignores
 * TERM. In the owner script the temp file exists by the time `cat` runs, so this is a real owner child that
 * stalls with its temp file in the folder. Root's own `cat` is untouched. The pids go to a log for cleanup.
 */
function catHang(kind) {
  const dir = scratchDir("orbit-lows-cat-");
  const pids = join(dir, "pids.log");
  const body =
    kind === "stop"
      ? `kill -STOP $$`
      : `trap '' TERM; for _i in $(seq 1 40); do sleep 1; done`;
  writeFileSync(join(dir, "cat"), `#!/usr/bin/env bash\nif [[ "\${ORBIT_TEST_PRIVDROP:-0}" == 1 ]]; then echo $$ >> '${pids}'; ${body}; exit 1; fi\nexec '${realTool("cat")}' "$@"\n`);
  chmodSync(join(dir, "cat"), 0o755);
  return {
    dir,
    cleanup: () => {
      if (existsSync(pids)) for (const pid of readFileSync(pids, "utf8").split("\n").filter(Boolean)) spawnSync("kill", ["-KILL", pid], { stdio: "ignore" });
    },
  };
}

/** The common outcome of a stopped owner step: bounded, named, nothing left behind. */
function expectStopped(result, targetDir, action, reason, budgetMs = BUDGET_MS) {
  expect(result.hung, `repair was still running after the test's own cap:\n${result.stderr.slice(0, 600)}`).toBe(false);
  expect(result.ms, "repair outlived the step limit plus the kill grace").toBeLessThan(budgetMs);
  expect(result.stdout).not.toContain(action.done);
  expect(result.status).not.toBe(0);
  expect(orbitLines(result).some((line) => reason.test(line)), `no 'Orbit repair:' line gives the reason ${reason}:\n${result.stderr.slice(0, 1500)}`).toBe(true);
  expect(leftovers(targetDir), "an owner-write temp file was left behind").toEqual([]);
}

describe("#1873 X1/X5: a stopped, TERM-proof or flooding owner step leaves no temp file (real timeout and setsid)", () => {
  for (const [what, vehicle] of Object.entries(VEHICLES)) {
    for (const [kind, label, reason] of [
      ["stop", "stops itself (SIGSTOP) while it writes", /timed out/iu],
      ["ignore-term", "ignores TERM while it writes", /timed out/iu],
    ]) {
      it(`${what}: an owner child that ${label} is ended within the limit plus grace and its temp file removed`, () => {
        const { targetDir, state, fakeBin } = vehicle.make();
        const hang = catHang(kind);
        const shims = privShims(targetDir);
        try {
          const result = runOwner(targetDir, { shims, state, fakeBin, env: { ...LIMIT, PATH: `${hang.dir}:${shims.env.PATH}` }, capSeconds: 40 });
          expect(shims.setprivCalls().length, "no owner child was started").toBeGreaterThan(0);
          expectStopped(result, targetDir, vehicle.action, reason);
        } finally {
          hang.cleanup();
          shims.cleanup();
        }
      });
    }

    for (const [kind, label, reason] of [
      ["run-then-stop", "made its temp file and then stops (SIGSTOP)", /timed out/iu],
      ["run-then-ignore-term", "made its temp file and then ignores TERM", /timed out/iu],
      ["run-then-flood", "made its temp file and then floods its output", /too large|capped|4096/iu],
    ]) {
      it(`${what}: an owner step that ${label} leaves no temp file`, () => {
        const { targetDir, state, fakeBin } = vehicle.make();
        const shims = privShims(targetDir, { variant: { kind, match: "*smtp-owner-write*" } });
        try {
          const result = runOwner(targetDir, { shims, state, fakeBin, env: LIMIT, capSeconds: 40 });
          expect(shims.setprivCalls().length, "no owner child was started").toBeGreaterThan(0);
          expectStopped(result, targetDir, vehicle.action, reason);
        } finally {
          shims.cleanup();
        }
      });
    }
  }
});

describe("#1873 X1: root picks the full temp name; the owner creates exactly it and refuses an existing one", () => {
  const compose = ACTIONS["restore-compose-file"];
  const NAME = /(?:^|[\s/])(\.docker-compose\.yml\.repair\.(?!X{6}(?:\s|$))[A-Za-z0-9]{6,})(?=\s|$)/u;

  const nameOf = (shims) => {
    const call = shims.setprivCalls().find((line) => line.includes("smtp-owner-write"));
    expect(call, `no setpriv call runs smtp-owner-write:\n${shims.setprivCalls().join("\n")}`).toBeTruthy();
    return NAME.exec(call)?.[1];
  };

  it("the owner is handed a full name with a random suffix, not a template, and the run succeeds", () => {
    const { targetDir, state, fakeBin } = compose.make();
    const shims = privShims(targetDir);
    const result = runOwner(targetDir, { shims, state, fakeBin });
    expect(result.stdout, result.stderr).toContain(compose.done);
    const name = nameOf(shims);
    expect(name, `the owner's command line names no full temp name:\n${shims.setprivCalls().join("\n")}`).toBeTruthy();
    expect(leftovers(targetDir)).toEqual([]);
  });

  it("two runs choose different suffixes", () => {
    const names = [];
    for (let i = 0; i < 2; i += 1) {
      const { targetDir, state, fakeBin } = compose.make();
      const shims = privShims(targetDir);
      runOwner(targetDir, { shims, state, fakeBin });
      names.push(nameOf(shims));
    }
    expect(names[0], "no full temp name was handed to the owner").toBeTruthy();
    expect(names[0]).not.toBe(names[1]);
  });

  it("a link planted at the chosen name before the owner starts is refused: nothing is written through it", () => {
    const { targetDir, state, fakeBin } = compose.make();
    const shims = privShims(targetDir);
    const outside = scratchDir("orbit-lows-outside-");
    const victim = join(outside, "victim");
    writeFileSync(victim, "UNTOUCHED\n");
    const planted = join(outside, "planted.log");
    const inner = shims.env.PATH.split(":")[0];
    const planter = scratchDir("orbit-lows-planter-");
    writeFileSync(
      join(planter, "setpriv"),
      `#!/usr/bin/env bash\nfor a in "$@"; do\n  b="\${a##*/}"\n  if [[ "$b" =~ ^\\.docker-compose\\.yml\\.repair\\.[A-Za-z0-9]{6,}$ && "$b" != *XXXXXX ]]; then\n    case "$a" in /*) p="$a";; *) p="$PWD/$a";; esac\n    [[ -e "$p" || -L "$p" ]] || { ln -s '${victim}' "$p" && echo "$p" >> '${planted}'; }\n  fi\ndone\nexec '${inner}/setpriv' "$@"\n`,
    );
    chmodSync(join(planter, "setpriv"), 0o755);
    const result = runOwner(targetDir, { shims, state, fakeBin, env: { PATH: `${planter}:${shims.env.PATH}` } });
    expect(existsSync(planted), `the owner was never handed a full name to plant at:\n${shims.setprivCalls().join("\n")}`).toBe(true);
    expect(readFileSync(victim, "utf8"), "the owner wrote through a link at its temp name").toBe("UNTOUCHED\n");
    expect(result.stdout).not.toContain(compose.done);
    expect(existsSync(join(targetDir, "docker-compose.yml")), "a compose file was made from a planted name").toBe(false);
    expect(leftovers(targetDir)).toEqual([]);
  });

  it("not root: the same restore as today, no setpriv, nothing left", () => {
    const { targetDir, state, fakeBin } = compose.make();
    const shims = privShims(targetDir, { root: false, setpriv: false });
    const result = runOwner(targetDir, { shims, state, fakeBin });
    expect(result.stdout, result.stderr).toContain(compose.done);
    expect(shims.setprivCalls()).toEqual([]);
    expect(readFileSync(join(targetDir, "docker-compose.yml")).equals(IMAGE_COMPOSE)).toBe(true);
    expect(leftovers(targetDir)).toEqual([]);
  });
});

describe("#1873 X2: the compose restore never lands inside a directory", () => {
  const compose = ACTIONS["restore-compose-file"];

  /** An `mv` that, for the owner's rename of the temp file, first turns docker-compose.yml into a directory (the swap the review described). */
  function dirSwap() {
    const dir = scratchDir("orbit-lows-mv-");
    writeFileSync(
      join(dir, "mv"),
      `#!/usr/bin/env bash\nif [[ "\${ORBIT_TEST_PRIVDROP:-0}" == 1 ]]; then\n  args=("$@"); n=\${#args[@]}\n  if [[ $n -ge 2 && "\${args[$((n - 2))]##*/}" == .docker-compose.yml.repair.* && ! -e "\${args[$((n - 1))]}" ]]; then mkdir -- "\${args[$((n - 1))]}"; fi\nfi\nexec '${realTool("mv")}' "$@"\n`,
    );
    chmodSync(join(dir, "mv"), 0o755);
    return dir;
  }

  it("docker-compose.yml became a directory before the rename: the restore fails, reports it, and nothing is moved into the directory", () => {
    const { targetDir, state, fakeBin } = compose.make();
    const shims = privShims(targetDir);
    const swap = dirSwap();
    const result = runOwner(targetDir, { shims, state, fakeBin, env: { PATH: `${swap}:${shims.env.PATH}` } });
    const path = join(targetDir, "docker-compose.yml");
    expect(existsSync(path) && statSync(path).isDirectory(), "the swap did not happen, so the test proves nothing").toBe(true);
    expect(result.stdout, result.stderr).not.toContain(compose.done);
    expect(result.stdout).toContain(REAL_FAILED(compose));
    expect(readdirSync(path), "the restored file landed inside the directory").toEqual([]);
    expect(leftovers(targetDir), "the temp file was left behind").toEqual([]);
    expect(result.stderr).toMatch(/docker-compose\.yml/u);
  });
});

describe("#1873 X3: opening the backup/restore lock never blocks and never follows a swapped link", () => {
  const start = ACTIONS["start-services"];
  const lockPathOf = (targetDir) => join(targetDir, ...LOCK);

  /** A start-services folder whose lock exists as a regular file; a BASH_ENV hook swaps it for `kind` just before repair opens it (after its regular-file check). */
  function swapped(kind) {
    const { targetDir, state } = start.make();
    mkdirSync(join(targetDir, LOCK[0]), { mode: 0o700 });
    writeFileSync(lockPathOf(targetDir), "", { mode: 0o600 });
    const hook = scratchDir("orbit-lows-hook-");
    const flag = join(hook, "swapped");
    const outside = scratchDir("orbit-lows-lockdest-");
    const dest = join(outside, "lock-elsewhere");
    writeFileSync(dest, "");
    const swap = kind === "fifo" ? `${realTool("rm")} -f -- "$L"; ${realTool("mkfifo")} "$L"` : `${realTool("rm")} -f -- "$L"; ${realTool("ln")} -s '${dest}' "$L"`;
    writeFileSync(
      join(hook, "env.sh"),
      `set -T
__orbit_lock_swap() {
  case "\${BASH_COMMAND-}" in "[["*) return 0;; esac
  case "\${BASH_COMMAND-}" in *backup_restore_lock_path*) ;; *) return 0;; esac
  [[ " \${FUNCNAME[*]-} " == *" probe_backup_restore_lock "* ]] || return 0
  [[ -e '${flag}' ]] && return 0
  local L='${lockPathOf(targetDir)}'
  [[ -f "$L" && ! -L "$L" ]] || return 0
  : > '${flag}'
  ${swap}
  return 0
}
trap __orbit_lock_swap DEBUG
`,
    );
    return { targetDir, state, env: { BASH_ENV: join(hook, "env.sh") }, flag, dest };
  }

  const release = (path) => {
    // Release a reader still blocked in open() on the FIFO.
    try {
      if (existsSync(path)) closeSync(openSync(path, "r+"));
    } catch {
      // already gone
    }
  };

  for (const [who, shimOptions] of [
    ["root (as the folder's owner's repair)", {}],
    ["a user running repair directly", { root: false, setpriv: false }],
  ]) {
    it(`${who}: the lock turned into a FIFO after the regular-file check is refused with the lock line, with no wait`, () => {
      const { targetDir, state, env, flag } = swapped("fifo");
      const shims = privShims(targetDir, shimOptions);
      try {
        const result = runOwner(targetDir, { shims, state, env, capSeconds: 30 });
        expect(existsSync(flag), "the swap did not happen, so the test proves nothing").toBe(true);
        expect(result.hung, "repair blocked opening the FIFO").toBe(false);
        expect(result.ms, "repair waited on the lock").toBeLessThan(25_000);
        expect(result.stdout).not.toContain(start.done);
        expect(orbitLines(result).some((line) => /the lock at .*can't be read/u.test(line)), `no lock refusal line:\n${result.stderr.slice(0, 1500)}`).toBe(true);
        expect(composeUpCalls(result)).toEqual([]);
      } finally {
        release(lockPathOf(targetDir));
        shims.cleanup();
      }
    });

    it(`${who}: the lock swapped for a link to a regular file after the check is not followed: refused with the lock line`, () => {
      const { targetDir, state, env, flag } = swapped("link");
      const shims = privShims(targetDir, shimOptions);
      try {
        const result = runOwner(targetDir, { shims, state, env, capSeconds: 30 });
        expect(existsSync(flag), "the swap did not happen, so the test proves nothing").toBe(true);
        expect(result.hung).toBe(false);
        expect(result.stdout, "repair followed a swapped link and took the lock").not.toContain(start.done);
        expect(orbitLines(result).some((line) => /the lock at .*can't be read/u.test(line)), `no lock refusal line:\n${result.stderr.slice(0, 1500)}`).toBe(true);
        expect(composeUpCalls(result)).toEqual([]);
      } finally {
        shims.cleanup();
      }
    });
  }

  for (const [who, shimOptions] of [
    ["root", {}],
    ["not root", { root: false, setpriv: false }],
  ]) {
    it(`pin, ${who}: a lock that is already a FIFO is refused with the lock line, with no wait`, () => {
      const { targetDir, state } = start.make();
      mkdirSync(join(targetDir, LOCK[0]), { mode: 0o700 });
      spawnSync("mkfifo", [lockPathOf(targetDir)]);
      const shims = privShims(targetDir, shimOptions);
      try {
        const result = runOwner(targetDir, { shims, state, capSeconds: 30 });
        expect(result.hung).toBe(false);
        expect(result.ms).toBeLessThan(25_000);
        expect(result.stdout).not.toContain(start.done);
        expect(orbitLines(result).some((line) => /the lock at .*can't be read/u.test(line)), result.stderr.slice(0, 1500)).toBe(true);
      } finally {
        release(lockPathOf(targetDir));
      }
    });
  }

  it("pin: an ordinary lock file still lets start-services run", () => {
    const { targetDir, state } = start.make();
    const shims = privShims(targetDir);
    const result = runOwner(targetDir, { shims, state });
    expect(result.stdout, result.stderr).toContain(start.done);
    expect(statSync(lockPathOf(targetDir)).isFile()).toBe(true);
  });
});

describe("#1873 X4: the image's docker-compose.yml is capped at 1 MiB while it streams", () => {
  const compose = ACTIONS["restore-compose-file"];
  const CAP = 1024 * 1024;
  const padded = (size) => {
    const head = Buffer.from(IMAGE_COMPOSE);
    const line = "# padding padding padding padding\n";
    return Buffer.concat([head, Buffer.from(line.repeat(Math.ceil((size - head.length) / line.length))).subarray(0, size - head.length)]);
  };

  it("an image file of 3 MiB: the restore fails, says the file is too large, and leaves nothing behind", () => {
    const content = padded(3 * CAP);
    const { targetDir, state, fakeBin } = composeFolder(content);
    const shims = privShims(targetDir);
    const result = runOwner(targetDir, { shims, state, fakeBin });
    expect(result.hung).toBe(false);
    expect(result.stdout).not.toContain(compose.done);
    expect(result.stdout).toContain(REAL_FAILED(compose));
    expect(orbitLines(result).some((line) => /too large/iu.test(line)), `no line says 'too large':\n${result.stderr.slice(0, 1500)}`).toBe(true);
    expect(existsSync(join(targetDir, "docker-compose.yml")), "an oversize docker-compose.yml was installed").toBe(false);
    expect(leftovers(targetDir)).toEqual([]);
  });

  it("an image file of 1 MiB plus one byte is refused too", () => {
    const { targetDir, state, fakeBin } = composeFolder(padded(CAP + 1));
    const shims = privShims(targetDir);
    const result = runOwner(targetDir, { shims, state, fakeBin });
    expect(result.stdout).not.toContain(compose.done);
    expect(orbitLines(result).some((line) => /too large/iu.test(line)), result.stderr.slice(0, 1500)).toBe(true);
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(false);
    expect(leftovers(targetDir)).toEqual([]);
  });

  it("pin: an image file of exactly 1 MiB is restored whole", () => {
    const content = padded(CAP);
    expect(content.length).toBe(CAP);
    const { targetDir, state, fakeBin } = composeFolder(content);
    const shims = privShims(targetDir);
    const result = runOwner(targetDir, { shims, state, fakeBin });
    expect(result.stdout, result.stderr).toContain(compose.done);
    expect(readFileSync(join(targetDir, "docker-compose.yml")).equals(content)).toBe(true);
    expect(leftovers(targetDir)).toEqual([]);
  });
});

describe("#1873 X5: the #1858 stall test covers every owner action, not only retire-smtp-lines", () => {
  for (const [name, action] of Object.entries(ACTIONS)) {
    for (const [kind, label] of [
      ["stop", "stops itself (SIGSTOP)"],
      ["ignore-term", "ignores TERM"],
    ]) {
      it(`${name}: an owner child that ${label} ends the action as timed out within the limit plus grace, nothing left`, () => {
        const { targetDir, state, fakeBin } = action.make();
        const shims = privShims(targetDir, { variant: { kind } });
        const before = treeSnapshot(targetDir);
        try {
          const result = runOwner(targetDir, { shims, state, fakeBin, env: LIMIT, capSeconds: 40 });
          expect(shims.setprivCalls().length, "no owner child was started").toBeGreaterThan(0);
          expect(result.hung, result.stderr.slice(0, 600)).toBe(false);
          expect(result.ms).toBeLessThan(BUDGET_MS);
          expect(result.stdout).not.toContain(action.done);
          expect(result.status).not.toBe(0);
          expect(orbitLines(result).some((line) => /timed out/iu.test(line)), `no 'timed out' line:\n${result.stderr.slice(0, 1500)}`).toBe(true);
          expect(composeUpCalls(result)).toEqual([]);
          expect(leftovers(targetDir)).toEqual([]);
          expect(treeSnapshot(targetDir), "something was left behind").toBe(before);
        } finally {
          shims.cleanup();
        }
      });
    }
  }
});
