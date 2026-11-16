import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { composeUpCalls, makeFixture, runRepair, scratchDir } from "./repair-test-harness.mjs";

// #1848 FR-O5a and FR-S1b (repair side), written from the posted specifications alone.
//
//  - FR-O5a: when the backup chain of retire-smtp-lines fails, the dated folder is removed and, if this run made
//    orbit-install-backups, it is removed too (rmdir only), whether the run is root or not. A root that existed before,
//    one that is not empty, and failures after the chain succeeded keep today's behaviour.
//  - FR-S1b: the four mktemp files of a retirement are removed on TERM and HUP (a SIGINT case is not written: bash only dies of INT when the child did too, so a shim cannot fake it), and the next retirement sweeps the two
//    deployment-folder names (exactly 6 characters of [A-Za-z0-9] after the fixed part) before writing anything.
//
// Root is simulated, as in repair-retire-smtp-1817.test.mjs: an `id` shim prints 0 for `id -u` and a `chown` shim fails
// on request or runs the real chown (a no-op for the test user, since --reference=. names its own owner). Each link of
// the chain is failed with a shim on PATH: mkdir (dated folder; a directory squatting on the marker name), chown
// (marker, dated folder, root), mktemp (copy, overlay, record). SIGTERM is sent by an `mv` shim at the moment the
// temporary file is about to be renamed, so the timing is exact and not a race.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const FAKE_PASSWORD = "TEST-NOT-A-REAL-PASSWORD";
const RUNNING = { db: "running", app: "running" };
const IMPORTED = { ...RUNNING, mailStatus: "mail-sending source=imported imported-from-environment=true" };
const GATE_FAILS_AFTER = { mailStatusAfterSecretGone: "mail-sending source=none imported-from-environment=false" };
const DONE = "execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done";
const FAILED = "execute action=retire-smtp-lines resolves=smtp-lines-retirable result=failed";
const BACKUP_REFUSED = "retire-smtp-lines refused, nothing was changed: the backup of .env-orbit could not be made in orbit-install-backups.";
const ROOT = "orbit-install-backups";
const realTool = (name) => spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();

function withMail() {
  const targetDir = makeFixture();
  const envPath = join(targetDir, ".env-orbit");
  const extra = [
    "COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml",
    "SMTP_HOST=smtp.example.test",
    "SMTP_PORT=587",
    "SMTP_SECURITY=starttls",
    "SMTP_USER=orbit@example.test",
    "SMTP_PASSWORD_FILE=/run/orbit-secrets/orbit-smtp-password",
    "SMTP_FROM=Orbit <orbit@example.test>",
    "",
  ];
  writeFileSync(envPath, `${readFileSync(envPath, "utf8")}${extra.join("\n")}`, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  writeFileSync(join(targetDir, "docker-compose.mail.yml"), "services:\n  orbit-app:\n    secrets:\n      - orbit-smtp-password\n");
  writeFileSync(join(targetDir, ".orbit-secrets", "smtp-password"), FAKE_PASSWORD, { mode: 0o600 });
  return targetDir;
}
const envOf = (targetDir) => readFileSync(join(targetDir, ".env-orbit"), "utf8");
const exists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Shims on PATH, each acting only when it matches and otherwise running the real tool.
 *  root: `id -u` prints 0.  fail: which link fails.  intrude: the failing shim first drops a file into orbit-install-backups.
 *  signal: { when: <glob on the mv source>, name } sends SIGTERM to the repair.sh process when mv is asked to rename a matching
 *  temporary file, logs the name, and does not rename (the signal is handled once the shim exits).
 */
function shims({ root = false, fail = null, intrude = false, signal = null } = {}) {
  const dir = scratchDir("orbit-repair-1848-shims-");
  const log = join(dir, "signal.log");
  const sh = (name, body) => {
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  const intruder = intrude ? `: > "${ROOT}/intruder" 2>/dev/null || true; ` : "";
  const failNow = `${intruder}exit 1`;
  if (root) sh("id", `if [[ $# -eq 1 && "$1" == -u ]]; then echo 0; exit 0; fi\nexec '${realTool("id")}' "$@"`);
  const chownFail = { marker: "*/.orbit-smtp-undo", dated: `${ROOT}/*-repair*`, backupsRoot: ROOT }[fail];
  sh("chown", `last="\${@: -1}"; last="\${last#./}"; last="\${last%/}"\ncase "$last" in ${chownFail ?? "__never__"}) ${failNow};; esac\nexec '${realTool("chown")}' "$@"`);
  const mktempFail = { copy: "*/.env-orbit.smtp-copy.*", overlay: "*/docker-compose.mail.yml.smtp-copy.*", record: "./.orbit-smtp-retirement.*" }[fail];
  sh("mktemp", `case "\${@: -1}" in ${mktempFail ?? "__never__"}) ${failNow};; esac\nexec '${realTool("mktemp")}' "$@"`);
  // datedMkdir: the dated folder cannot be made. markerSquat: it is made, but a directory already sits at the marker's name.
  sh(
    "mkdir",
    `last="\${@: -1}"
if [[ "${fail}" == datedMkdir && "$last" == ${ROOT}/*-repair* ]]; then ${failNow}; fi
'${realTool("mkdir")}' "$@" || exit $?
if [[ "${fail}" == markerSquat && "$last" == ${ROOT}/*-repair* ]]; then '${realTool("mkdir")}' "$last/.orbit-smtp-undo"; ${intruder}fi`,
  );
  const pattern = signal ? signal.when : "__never__";
  sh(
    "mv",
    `src=""; for a in "$@"; do case "$a" in -*) ;; *) src="$a"; break;; esac; done
case "$src" in ${pattern})
  printf '%s\\n' "$src" >> '${log}'
  pid=$PPID
  while :; do up="$(ps -o ppid= -p "$pid" | tr -d ' ')"; [[ -n "$up" && "$up" != 1 && "$(ps -o args= -p "$up")" == *repair.sh* ]] || break; pid="$up"; done
  kill -${signal?.name ?? "TERM"} "$pid"
  sleep 1
  exit 1;;
esac
exec '${realTool("mv")}' "$@"`,
  );
  return { dir, env: { ORBIT_REPAIR_PROMPTS: "machine", PATH: `${dir}:${process.env.PATH}` }, signalled: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

const run = (targetDir, s, extra = {}) => runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...extra, env: s.env, input: "y\n" });

// FR-O5a ---------------------------------------------------------------------------------------------------------------
const LINKS = [
  ["the dated folder cannot be made (mkdir)", { fail: "datedMkdir" }],
  ["the marker cannot be written", { fail: "markerSquat" }],
  ["the marker cannot be given the folder's owner (chown)", { fail: "marker", root: true }],
  ["the copy cannot be written", { fail: "copy" }],
  ["the overlay copy cannot be made", { fail: "overlay" }],
  ["the dated folder cannot be given the folder's owner (chown)", { fail: "dated", root: true }],
  ["orbit-install-backups itself cannot be given the folder's owner (chown)", { fail: "backupsRoot", root: true }],
];

describe("FR-O5a (#1848): a failed backup chain removes the orbit-install-backups this run made", () => {
  for (const [label, options] of LINKS) {
    describe(label, () => {
      it("leaves no orbit-install-backups; same stderr line, result=failed, exit 4, .env-orbit untouched", () => {
        const targetDir = withMail();
        const before = envOf(targetDir);
        const result = run(targetDir, shims(options));
        expect(result.stderr).toContain(BACKUP_REFUSED);
        expect(result.stdout).toContain(FAILED);
        expect(result.stdout).not.toContain(DONE);
        expect(result.status).toBe(4);
        expect(envOf(targetDir)).toBe(before);
        expect(exists(join(targetDir, ROOT)), `${ROOT} was left behind`).toBe(false);
        expect(composeUpCalls(result)).toEqual([]);
      });

      if (options.fail !== "backupsRoot") {
        it("keeps an orbit-install-backups that existed before the run (empty), and removes only the dated folder", () => {
          const targetDir = withMail();
          mkdirSync(join(targetDir, ROOT), { mode: 0o700 });
          const result = run(targetDir, shims(options));
          expect(result.stderr).toContain(BACKUP_REFUSED);
          expect(result.status).toBe(4);
          expect(readdirSync(join(targetDir, ROOT))).toEqual([]);
        });
      }

      it("keeps the root and a file someone put there meanwhile (rmdir only)", () => {
        const targetDir = withMail();
        const result = run(targetDir, shims({ ...options, intrude: true }));
        expect(result.stderr).toContain(BACKUP_REFUSED);
        expect(result.status).toBe(4);
        expect(readdirSync(join(targetDir, ROOT))).toEqual(["intruder"]);
      });

      it("a later run by the same user then completes the retirement", () => {
        const targetDir = withMail();
        run(targetDir, shims(options));
        const again = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, env: { ORBIT_REPAIR_PROMPTS: "machine" }, input: "y\n" });
        expect(again.stdout, again.stderr).toContain(DONE);
        expect(again.stderr).not.toContain(BACKUP_REFUSED);
      });
    });
  }

  it("the same cleanup applies to a run that is not root (no id shim): nothing is left, nothing is chowned", () => {
    const targetDir = withMail();
    const result = run(targetDir, shims({ fail: "copy" }));
    expect(result.status).toBe(4);
    expect(exists(join(targetDir, ROOT))).toBe(false);
  });

  it("a failure after the chain succeeded (the step record) keeps today's behaviour: the root and the dated folder stay", () => {
    const targetDir = withMail();
    const before = envOf(targetDir);
    const result = run(targetDir, shims({ fail: "record", root: true }));
    expect(result.stderr).toContain("retire-smtp-lines left .env-orbit as it was: its step record could not be written.");
    expect(result.stdout).not.toContain(DONE);
    expect(envOf(targetDir)).toBe(before);
    const dated = readdirSync(join(targetDir, ROOT));
    expect(dated).toHaveLength(1);
    expect(dated[0]).toMatch(/-repair/u);
  });

  it("a successful run is unchanged: the root and the dated folder exist (mode 700), chowned to the folder's owner", () => {
    const targetDir = withMail();
    const s = shims({ root: true });
    const result = run(targetDir, s, GATE_FAILS_AFTER);
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(readdirSync(join(targetDir, ROOT))).toHaveLength(1);
    expect((lstatSync(join(targetDir, ROOT)).mode & 0o777).toString(8)).toBe("700");
    expect(composeUpCalls(result).length).toBeGreaterThan(0);
  });
});

// FR-S1b ---------------------------------------------------------------------------------------------------------------
const RECORD_NAME = ".orbit-smtp-retirement.Ab12Cd";
const REWRITE_NAME = ".env-orbit.retire-smtp.Zz9yX8";
const outside = () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-1848-outside-"));
  const path = join(dir, "target");
  writeFileSync(path, "KEEP\n");
  return path;
};

describe("FR-S1b (#1848): the retirement sweeps stale temporary files by exact name", () => {
  it("removes both names, as files and as symlinks, leaves a symlink's target, and says nothing about it", () => {
    const targetDir = withMail();
    const target = outside();
    writeFileSync(join(targetDir, RECORD_NAME), "step=backed-up\n");
    symlinkSync(target, join(targetDir, REWRITE_NAME));
    const result = run(targetDir, shims());
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(exists(join(targetDir, RECORD_NAME))).toBe(false);
    expect(exists(join(targetDir, REWRITE_NAME))).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("KEEP\n");
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/Ab12Cd|Zz9yX8/u);

    const second = withMail();
    const target2 = outside();
    symlinkSync(target2, join(second, RECORD_NAME));
    writeFileSync(join(second, REWRITE_NAME), "SMTP_HOST=leftover\n");
    expect(run(second, shims()).stdout).toContain(DONE);
    expect(exists(join(second, RECORD_NAME))).toBe(false);
    expect(exists(join(second, REWRITE_NAME))).toBe(false);
    expect(readFileSync(target2, "utf8")).toBe("KEEP\n");
  });

  it("removes a dangling symlink of those names", () => {
    const targetDir = withMail();
    symlinkSync(join(targetDir, "does-not-exist"), join(targetDir, RECORD_NAME));
    run(targetDir, shims());
    expect(exists(join(targetDir, RECORD_NAME))).toBe(false);
  });

  it("keeps every other name: the old .tmp name, wrong lengths, wrong characters, other files", () => {
    const targetDir = withMail();
    const keep = [
      ".env-orbit.retire-smtp.tmp",
      ".orbit-smtp-retirement.toolong1",
      ".orbit-smtp-retirement.Ab12C",
      ".env-orbit.retire-smtp.Zz9yX8x",
      ".env-orbit.retire-smtp.Zz-yX8",
      ".orbit-smtp-retirementAb12Cd",
      "notes.txt",
    ];
    for (const name of keep) writeFileSync(join(targetDir, name), "mine\n");
    writeFileSync(join(targetDir, RECORD_NAME), "x\n");
    const result = run(targetDir, shims());
    expect(result.stdout, result.stderr).toContain(DONE);
    for (const name of keep) expect(readFileSync(join(targetDir, name), "utf8"), name).toBe("mine\n");
    expect(exists(join(targetDir, RECORD_NAME))).toBe(false);
  });
});

describe("FR-S1b (#1848): a caught signal leaves no temporary file", () => {
  // [label, glob on the mv source, signal, where the leftover would be]
  const CASES = [
    ["the step record write", "./.orbit-smtp-retirement.*", "TERM", (dir) => readdirSync(dir).filter((n) => /^\.orbit-smtp-retirement\./u.test(n))],
    ["the .env-orbit rewrite", "*.retire-smtp.*", "TERM", (dir) => readdirSync(dir).filter((n) => /^\.env-orbit\.retire-smtp\./u.test(n))],
    ["the .env-orbit rewrite (SIGHUP)", "*.retire-smtp.*", "HUP", (dir) => readdirSync(dir).filter((n) => /^\.env-orbit\.retire-smtp\./u.test(n))],
    ["the undo copy's .env-orbit write", "*/.env-orbit.smtp-copy.*", "TERM", (dir) => undoLeftovers(dir)],
    ["the undo copy's overlay write", "*/docker-compose.mail.yml.smtp-copy.*", "TERM", (dir) => undoLeftovers(dir)],
  ];
  const undoLeftovers = (dir) => {
    const root = join(dir, ROOT);
    if (!exists(root)) return [];
    return readdirSync(root).flatMap((d) => readdirSync(join(root, d)).filter((n) => /\.smtp-copy\./u.test(n)));
  };
  for (const [label, when, name, leftovers] of CASES) {
    it(`${label}: ${name} leaves no temporary file behind`, () => {
      const targetDir = withMail();
      const s = shims({ signal: { when, name } });
      const result = run(targetDir, s);
      expect(s.signalled(), "the shim never reached the write it was to interrupt").not.toEqual([]);
      expect(result.stdout).not.toContain(DONE);
      expect(leftovers(targetDir), `left behind after ${name}`).toEqual([]);
      for (const entry of s.signalled()) expect(exists(entry.startsWith("/") ? entry : join(targetDir, entry)), entry).toBe(false);
    });
  }
});
