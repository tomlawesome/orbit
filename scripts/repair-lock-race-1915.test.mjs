import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runOwner } from "./repair-owner-fixtures.mjs";
import { UID, privShims, realTool } from "./repair-priv-shims.mjs";
import { makeFixture, scratchDir } from "./repair-test-harness.mjs";

// #1915 O-S3 (re-ruled): when the engine lock changes between engine_lock_idle's -e check and its open, repair never
// removes the file (it could be an install's live lock). It keeps own_created_lock's chmod/chown, refuses as
// unwritable, and appends a sentence telling the operator what to check. Race seam: the BASH_ENV DEBUG hook of #1899.

vi.setConfig({ testTimeout: 90_000 });

const STAGING = ".orbit-install-staging.abc123";
const MANAGED = ["docker-compose.yml", "docker-compose.mail.yml", ".env-orbit.example", "config/tika-config.json", "scripts/configure.sh", "scripts/installer-ui.sh", "scripts/backup.sh", "scripts/restore.sh", "scripts/repair.sh", "update.sh", ".env-orbit", ".orbit-secrets", ".orbit-files"];
const APPENDED = "; the lock changed while repair was checking it (an install or update just started or finished), so the file now there may be an empty one repair's open created; if no install or update is running and .orbit-engine.lock is empty, remove it yourself, or the next install waits up to 10 minutes on it";
const orbitLines = (result) => result.stderr.split("\n").filter((line) => line.startsWith("Orbit repair:"));

function engineFolder() {
  const targetDir = makeFixture();
  const original = join(targetDir, STAGING, "rollback", "original");
  mkdirSync(original, { recursive: true, mode: 0o700 });
  for (const dir of [join(targetDir, STAGING), join(targetDir, STAGING, "rollback"), original]) chmodSync(dir, 0o700);
  const present = MANAGED.filter((path) => existsSync(join(targetDir, path)));
  const copied = spawnSync("cp", ["-a", "--parents", ...present, original], { cwd: targetDir, encoding: "utf8" });
  if (copied.status !== 0) throw new Error(copied.stderr);
  const path = join(targetDir, ".orbit-engine.lock");
  writeFileSync(path, "", { mode: 0o600 });
  utimesSync(path, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
  return { targetDir, path };
}

/** BASH_ENV hook: just before `exec {fd}<` inside engine_lock_idle, removes the lock, then runs `after` (shell). */
function raceHook(path, after = "") {
  const hook = scratchDir("orbit-1915-race-");
  const flag = join(hook, "done");
  writeFileSync(
    join(hook, "env.sh"),
    `set -T
__orbit_lock_race() {
  case "\${BASH_COMMAND-}" in *'exec {fd}<'*) ;; *) return 0;; esac
  [[ " \${FUNCNAME[*]-} " == *" engine_lock_idle "* ]] || return 0
  [[ -e '${flag}' ]] && return 0
  : > '${flag}'
  ${realTool("rm")} -f -- '${path}'
  ${after}
  return 0
}
trap __orbit_lock_race DEBUG
`,
  );
  return { env: { BASH_ENV: join(hook, "env.sh") }, flag };
}

const run = (targetDir, shims, env) => runOwner(targetDir, { shims, state: { db: "running", app: "running" }, args: ["--execute", "--safe-only"], capSeconds: 40, env });

for (const [who, opts] of [["not root", { root: false, setpriv: false, getent: "fail" }], ["simulated root", {}]]) {
  describe(`#1915 O-S3 (re-ruled), ${who}`, () => {
    it("the lock removed before the open: the file the open created is kept (empty, 0600, the owner's), the refusal carries the appended text", () => {
      const { targetDir, path } = engineFolder();
      const hook = raceHook(path);
      const shims = privShims(targetDir, { extraTools: ["diff", "sha256sum"], ...opts });
      try {
        const result = run(targetDir, shims, hook.env);
        expect(existsSync(hook.flag), "the removal did not happen, so the test proves nothing").toBe(true);
        expect(result.hung).toBe(false);
        expect(existsSync(path), "repair removed the lock").toBe(true);
        const info = statSync(path);
        expect(info.isFile()).toBe(true);
        expect(info.size).toBe(0);
        expect((info.mode & 0o777).toString(8)).toBe("600");
        expect(info.uid).toBe(UID);
        const refusal = orbitLines(result).find((line) => line.includes("refusing restore-transaction"));
        expect(refusal, result.stderr.slice(0, 1500)).toBeDefined();
        expect(refusal).toContain("could not be opened for writing");
        expect(refusal).toContain(APPENDED);
        expect(result.stderr).not.toContain("vanished");
        expect(result.stderr).not.toContain("removed that file");
        expect(result.status).not.toBe(0);
        expect(existsSync(join(targetDir, STAGING)), "the staging folder was removed").toBe(true);
      } finally {
        shims.cleanup();
      }
    });

    it("race: the lock replaced by a fresh empty file just before the open (an engine's create): that file, with that inode, is still there", () => {
      const { targetDir, path } = engineFolder();
      const inodeFile = join(scratchDir("orbit-1915-inode-"), "inode");
      const hook = raceHook(path, `: > '${path}'; ${realTool("stat")} -c %i '${path}' > '${inodeFile}'`);
      const shims = privShims(targetDir, { extraTools: ["diff", "sha256sum"], ...opts });
      try {
        const result = run(targetDir, shims, hook.env);
        expect(existsSync(hook.flag), "the replacement did not happen, so the test proves nothing").toBe(true);
        expect(result.hung).toBe(false);
        expect(existsSync(path), "repair removed the engine's fresh lock").toBe(true);
        expect(String(statSync(path).ino)).toBe(readFileSync(inodeFile, "utf8").trim());
        expect(statSync(path).size).toBe(0);
        const refusal = orbitLines(result).find((line) => line.includes("refusing restore-transaction"));
        expect(refusal, result.stderr.slice(0, 1500)).toBeDefined();
        expect(refusal).toContain("could not be opened for writing");
        expect(refusal).toContain(APPENDED);
        expect(result.stderr).not.toContain("vanished");
        expect(result.stderr).not.toContain("removed that file");
      } finally {
        shims.cleanup();
      }
    });
  });
}
