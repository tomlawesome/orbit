import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { composeUpCalls, makeFixture, repoDir, runRepair, scratchDir, scriptsDir, treeSnapshot } from "./repair-test-harness.mjs";

// #1817: repair.sh retires the SMTP lines once Orbit holds outgoing mail in its
// own settings. Written from the issue's specification alone, before the change.
//
//  - Finding `smtp-lines-retirable` (target=env-file severity=warn, owner decision 7a) when the gate
//    holds -- `orbit mail-sending-status` (run in orbit-app through `compose exec
//    -T`) says source=imported or source=ui -- and any of three remain: the SMTP_*
//    lines in .env-orbit, docker-compose.mail.yml (the file, or its entry in
//    COMPOSE_FILE), .orbit-secrets/smtp-password. `none`, a skipped import, a
//    stopped container or an unknown command: no finding, nothing changed.
//  - Plan action `retire-smtp-lines`, in the safe batch only, running: rewrite
//    .env-orbit (no SMTP_* keys, no overlay in COMPOSE_FILE), `up -d --no-build`,
//    delete the secret file. The diagnosis (--check, --plan) stays read-only.
//  - The usual backup covers .env-orbit and the overlay, never the secret; the
//    backed-up .env-orbit has any SMTP_PASSWORD= line removed. The action's
//    metadata says plainly that the secret cannot be rolled back.
//  - Owner decision 2: the secret is deleted, never copied, on either path.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const FAKE_PASSWORD = "TEST-NOT-A-REAL-PASSWORD";
const SMTP_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURITY", "SMTP_USER", "SMTP_PASSWORD", "SMTP_PASSWORD_FILE", "SMTP_FROM"];
const COMMENTED = ["# SMTP_HOST=smtp.example.test", "# SMTP_FROM=Orbit <old@example.test>"];
const FINDING = "finding class=smtp-lines-retirable target=env-file severity=warn";
const RUNNING = { db: "running", app: "running" };
const answer = (source, imported = true) => `mail-sending source=${source} imported-from-environment=${imported}`;
const IMPORTED = { ...RUNNING, mailStatus: answer("imported") };
const MACHINE = { env: { ORBIT_REPAIR_PROMPTS: "machine" }, input: "y\n" };

/** A healthy fixture plus the pre-#1629 mail shape; `parts` picks which artefacts exist. */
function withMail(parts = { lines: true, overlayListed: true, overlayFile: true, secret: true }, { inlinePassword = false } = {}) {
  const targetDir = makeFixture();
  const envPath = join(targetDir, ".env-orbit");
  const extra = [];
  if (parts.overlayListed) extra.push("COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml");
  if (parts.lines || parts.inlinePassword || inlinePassword) {
    extra.push("SMTP_HOST=smtp.example.test", "SMTP_PORT=587", "SMTP_SECURITY=starttls", "SMTP_USER=orbit@example.test");
    extra.push(inlinePassword ? `SMTP_PASSWORD=${FAKE_PASSWORD}` : "SMTP_PASSWORD_FILE=/run/orbit-secrets/orbit-smtp-password");
    extra.push("SMTP_FROM=Orbit <orbit@example.test>");
  }
  extra.push(...COMMENTED, "");
  appendFileSync(envPath, extra.join("\n"));
  chmodSync(envPath, 0o600);
  if (parts.overlayFile) writeFileSync(join(targetDir, "docker-compose.mail.yml"), "services:\n  orbit-app:\n    secrets:\n      - orbit-smtp-password\n");
  if (parts.secret) {
    writeFileSync(join(targetDir, ".orbit-secrets", "smtp-password"), FAKE_PASSWORD);
    chmodSync(join(targetDir, ".orbit-secrets", "smtp-password"), 0o600);
  }
  return targetDir;
}

const envOf = (targetDir) => readFileSync(join(targetDir, ".env-orbit"), "utf8");
const secretPath = (targetDir) => join(targetDir, ".orbit-secrets", "smtp-password");
const findCalls = (args, targetDir) => spawnSync("find", [targetDir, ...args], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
/** Every path under the folder, the recovery and backup directories included, named like the secret file. */
const secretFilesAnywhere = (targetDir) => findCalls(["-name", "smtp-password*"], targetDir);
const filesContaining = (text, targetDir) => spawnSync("grep", ["-rlF", "--", text, targetDir], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
/** Every file under the folder named .env-orbit (or a copy of it) other than the live one: the backups. */
const envBackups = (targetDir) => findCalls(["-type", "f", "-name", ".env-orbit*", "-not", "-path", join(targetDir, ".env-orbit"), "-not", "-name", ".env-orbit.example"], targetDir);
const statusCalls = (result) => result.argv.filter((entry) => entry.includes("mail-sending-status"));
const mutatingCalls = (result) => result.argv.filter((entry) => /^(restart|rm|stop|kill) /u.test(entry) || /\bcompose\b.*\b(up|rm|stop|down)\b/u.test(entry));

describe("#1817 finding smtp-lines-retirable", () => {
  for (const [source, imported] of [["imported", true], ["ui", true], ["ui", false]]) {
    it(`is raised for source=${source} imported-from-environment=${imported} while the lines, the overlay and the secret remain`, () => {
      const targetDir = withMail();
      const result = runRepair(targetDir, ["--check"], { ...RUNNING, mailStatus: answer(source, imported) });
      expect(result.stdout).toContain(FINDING);
      expect(result.stdout.split("\n").filter((entry) => entry.startsWith("finding class=smtp-lines-retirable"))).toHaveLength(1);
    });
  }

  for (const [label, parts] of [
    ["only the SMTP lines", { lines: true }],
    ["only the overlay's entry in COMPOSE_FILE", { overlayListed: true }],
    ["only the secret file", { secret: true }],
  ]) {
    it(`is raised when ${label} remain`, () => {
      const targetDir = withMail(parts);
      expect(runRepair(targetDir, ["--check"], IMPORTED).stdout).toContain(FINDING);
    });
  }

  // R1 (inline review of b342ca61): "overlay" means its COMPOSE_FILE entry; the shipped file alone is not something to retire.
  for (const [label, answerLine] of [["source=imported", answer("imported")], ["source=ui, nothing imported", answer("ui", false)]]) {
    it(`is not raised, and a safe run changes nothing, when only the shipped docker-compose.mail.yml is present (${label})`, () => {
      const targetDir = withMail({ overlayFile: true });
      const options = { ...RUNNING, mailStatus: answerLine };
      expect(runRepair(targetDir, ["--check"], options).stdout).not.toContain("smtp-lines-retirable");
      expect(runRepair(targetDir, ["--plan"], options).stdout).not.toContain("retire-smtp-lines");
      const before = treeSnapshot(targetDir);
      const executed = runRepair(targetDir, ["--execute", "--safe-only"], { ...options, ...MACHINE });
      expect(executed.stdout).not.toContain("retire-smtp-lines");
      expect(treeSnapshot(targetDir)).toBe(before);
      expect(existsSync(join(targetDir, "docker-compose.mail.yml"))).toBe(true);
    });
  }

  it("a fresh install (the overlay file shipped, .env-orbit untouched) with source=ui gives no finding and no change", () => {
    const targetDir = makeFixture();
    writeFileSync(join(targetDir, "docker-compose.mail.yml"), "services:\n  orbit-app:\n    secrets:\n      - orbit-smtp-password\n");
    const options = { ...RUNNING, mailStatus: answer("ui", false) };
    const before = treeSnapshot(targetDir);
    expect(runRepair(targetDir, ["--check"], options).stdout).not.toContain("smtp-lines-retirable");
    expect(runRepair(targetDir, ["--execute", "--safe-only"], { ...options, ...MACHINE }).stdout).not.toContain("retire-smtp-lines");
    expect(treeSnapshot(targetDir)).toBe(before);
  });

  // R3 (owner 7a): the finding is a warn, so the diagnosis calls the deployment `attention`, exits 3 like other warn findings, and --plan agrees.
  it("is a warn: --check says result=attention and exits 3, --plan exits 3, and the severity is not info", () => {
    const targetDir = withMail();
    const check = runRepair(targetDir, ["--check"], IMPORTED);
    expect(check.stdout).toContain(FINDING);
    expect(check.stdout).not.toContain("class=smtp-lines-retirable target=env-file severity=info");
    expect(check.stdout).toMatch(/^diagnosis result=attention checked=\d+ skipped=\d+$/mu);
    expect(check.stdout).not.toContain("diagnosis result=healthy");
    expect(check.status).toBe(3);
    expect(runRepair(targetDir, ["--plan"], IMPORTED).status).toBe(3);
  });

  // R2: with the finding firing, checked + skipped still add up to the total.
  it("--check keeps the checked=<n> skipped=<n> grammar when the finding fires: both 0 or more, and the sum is the usual total", () => {
    const diagnosis = (stdout) => stdout.split("\n").find((entry) => entry.startsWith("diagnosis ")) ?? "";
    const counts = (stdout) => {
      const found = /^diagnosis result=\S+ checked=(-?\d+) skipped=(-?\d+)$/u.exec(diagnosis(stdout));
      expect(found, diagnosis(stdout)).not.toBeNull();
      return { checked: Number(found[1]), skipped: Number(found[2]) };
    };
    const fired = runRepair(withMail(), ["--check"], IMPORTED);
    expect(fired.stdout).toContain("finding class=smtp-lines-retirable target=env-file");
    const withFinding = counts(fired.stdout);
    const quiet = counts(runRepair(withMail({}), ["--check"], IMPORTED).stdout);
    expect(withFinding.checked).toBeGreaterThanOrEqual(0);
    expect(withFinding.skipped).toBeGreaterThanOrEqual(0);
    expect(withFinding.checked + withFinding.skipped).toBe(quiet.checked + quiet.skipped);
  });

  it("is not raised when nothing remains to retire, whatever the status says", () => {
    const targetDir = withMail({});
    expect(runRepair(targetDir, ["--check"], IMPORTED).stdout).not.toContain("smtp-lines-retirable");
  });

  it("asks for the status once, inside orbit-app, through compose exec -T", () => {
    const targetDir = withMail();
    const result = runRepair(targetDir, ["--check"], IMPORTED);
    const asked = statusCalls(result);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/\bcompose\b.*\bexec -T orbit-app node \/opt\/orbit\/cli\/orbit\.js mail-sending-status$/u);
  });

  describe("is not raised, and nothing is planned, when the gate does not hold", () => {
    const cases = [
      ["source=none", { ...RUNNING, mailStatus: answer("none", false) }],
      ["an unknown command (an older image)", { ...RUNNING }],
      ["a non-zero exit, even with an imported line", { ...IMPORTED, mailStatusExit: 1 }],
      ["a stopped application container", { db: "running", app: "stopped", mailStatus: answer("imported") }],
      ["an answer outside the vocabulary", { ...RUNNING, mailStatus: "mail-sending source=imported" }],
      // Over 256 bytes is cut short and then an odd answer. Trailing newlines are stripped by $(...), so only the cap refuses these.
      ["a valid line followed by 300 newlines (over 256 bytes)", { ...RUNNING, mailStatus: `${answer("imported")}${"\n".repeat(300)}` }],
      ["a valid line, 300 newlines, then more text", { ...RUNNING, mailStatus: `${answer("imported")}${"\n".repeat(300)}trailing` }],
    ];
    for (const [label, options] of cases) {
      it(label, () => {
        const targetDir = withMail();
        const check = runRepair(targetDir, ["--check"], options);
        expect(check.stdout).not.toContain("smtp-lines-retirable");
        const plan = runRepair(targetDir, ["--plan"], options);
        expect(plan.stdout).not.toContain("retire-smtp-lines");
        const before = treeSnapshot(targetDir);
        const executed = runRepair(targetDir, ["--execute", "--safe-only"], options);
        expect(executed.stdout).not.toContain("retire-smtp-lines");
        // Only Repair's own start-services may add anything: since #1823 it
        // creates and holds the restore lock before starting a stopped
        // container. Nothing else in the folder may change.
        const startLock = (tree) => tree.split("\n").filter((line) => !/^\.\/backups( 700 \d+ d|\/\.orbit-backup-restore\.lock 600 0 f)$/u.test(line)).join("\n");
        const after = treeSnapshot(targetDir);
        if (options.app === "stopped") expect(startLock(after)).toBe(startLock(before));
        else expect(after).toBe(before);
        expect(envOf(targetDir)).toContain("SMTP_HOST=smtp.example.test");
        expect(existsSync(secretPath(targetDir))).toBe(true);
        // A stopped container is started by Repair's own start-services; nothing else may bring the stack up.
        expect(composeUpCalls(executed).filter((entry) => !entry.includes("--no-recreate"))).toEqual([]);
      });
    }
  });

  it("the diagnosis is read-only: --check and --plan change no file and run no compose up", () => {
    const targetDir = withMail();
    const before = treeSnapshot(targetDir);
    const check = runRepair(targetDir, ["--check"], IMPORTED);
    const plan = runRepair(targetDir, ["--plan"], IMPORTED);
    expect(treeSnapshot(targetDir)).toBe(before);
    expect(mutatingCalls(check)).toEqual([]);
    expect(mutatingCalls(plan)).toEqual([]);
  });
});

describe("#1817 plan action retire-smtp-lines", () => {
  it("is planned for the finding, once, with the usual backup, and never as manual", () => {
    const targetDir = withMail();
    const result = runRepair(targetDir, ["--plan"], IMPORTED);
    const planned = result.stdout.split("\n").filter((entry) => entry.startsWith("plan action=retire-smtp-lines"));
    expect(planned).toHaveLength(1);
    expect(planned[0]).toContain("resolves=smtp-lines-retirable");
    expect(planned[0]).toContain("backup=required");
    expect(planned[0]).toContain("target=env-file");
    expect(result.stdout).not.toContain("action=manual resolves=smtp-lines-retirable");
  });

  it("says plainly that the secret cannot be rolled back", () => {
    const targetDir = withMail();
    const result = runRepair(targetDir, ["--plan"], IMPORTED);
    const said = `${result.stdout}\n${result.stderr}`.split("\n").filter((entry) => /smtp|secret|password/iu.test(entry) && /cannot|can not|never|not (be )?(rolled back|restored|recovered)/iu.test(entry));
    expect(said.length).toBeGreaterThan(0);
    expect(said.join("\n")).toMatch(/roll(ed)? ?back|restor|recover/iu);
  });

  it("is in the safe batch only: --execute --dangerous neither runs nor offers it", () => {
    const targetDir = withMail();
    const before = treeSnapshot(targetDir);
    const result = runRepair(targetDir, ["--execute", "--dangerous"], { ...IMPORTED, ...MACHINE });
    expect(result.stdout).not.toContain("retire-smtp-lines");
    expect(treeSnapshot(targetDir)).toBe(before);
    expect(composeUpCalls(result)).toEqual([]);
  });

  it("is not run unattended with no confirmation: a declined safe batch leaves everything as it was", () => {
    const targetDir = withMail();
    const before = treeSnapshot(targetDir);
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, env: { ORBIT_REPAIR_PROMPTS: "machine" }, input: "n\n" });
    expect(result.stdout).not.toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    expect(treeSnapshot(targetDir)).toBe(before);
  });
});

describe("#1817 execute action retire-smtp-lines (--execute --safe-only)", () => {
  it("removes the SMTP lines, the overlay entry and file and the secret file, keeping everything else", () => {
    const targetDir = withMail();
    const secretsBefore = ["document-kek", "oidc-client-secret", "postgres-password", "session-secret"];
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...MACHINE });
    expect(result.stdout).toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    const env = envOf(targetDir);
    for (const key of SMTP_KEYS) expect(env).not.toMatch(new RegExp(`^${key}=`, "mu"));
    expect(env).not.toMatch(/^COMPOSE_FILE=.*docker-compose\.mail\.yml/mu);
    for (const commented of COMMENTED) expect(env).toContain(commented);
    expect(env).toContain("APP_URL=https://orbit.repair-test.internal");
    expect(env).toContain("COMPOSE_PROJECT_NAME=repairtest");
    expect((statSync(join(targetDir, ".env-orbit")).mode & 0o777).toString(8)).toBe("600");
    expect(existsSync(join(targetDir, "docker-compose.mail.yml"))).toBe(false);
    expect(existsSync(secretPath(targetDir))).toBe(false);
    for (const name of secretsBefore) expect(existsSync(join(targetDir, ".orbit-secrets", name))).toBe(true);
    expect(statSync(join(targetDir, ".orbit-secrets")).isDirectory()).toBe(true);
  });

  it("restarts the stack with `up -d --no-build` on the rewritten file, with the secret still in place at that start", () => {
    const targetDir = withMail();
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...MACHINE });
    expect(result.stdout).toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    expect(result.upTrace.at(-1)).toBe("false false true");
    expect(composeUpCalls(result).some((entry) => / up -d --no-build(\s|$)/u.test(entry))).toBe(true);
  });

  it("after a run, the finding is gone", () => {
    const targetDir = withMail();
    runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...MACHINE });
    expect(runRepair(targetDir, ["--check"], IMPORTED).stdout).not.toContain("smtp-lines-retirable");
  });

  it("owner decision 2: .orbit-secrets/smtp-password exists nowhere afterwards, the recovery and backup directories included, and its content is in no file", () => {
    const targetDir = withMail();
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...MACHINE });
    expect(result.stdout).toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    expect(secretFilesAnywhere(targetDir)).toEqual([]);
    expect(filesContaining(FAKE_PASSWORD, targetDir)).toEqual([]);
  });

  it("owner decision 2: a backed-up .env-orbit has no SMTP_PASSWORD= line, and an inline password is in no file", () => {
    const targetDir = withMail({ lines: true, overlayListed: true, overlayFile: true, secret: false }, { inlinePassword: true });
    expect(envOf(targetDir)).toContain(`SMTP_PASSWORD=${FAKE_PASSWORD}`);
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...MACHINE });
    expect(result.stdout).toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    expect(envOf(targetDir)).not.toMatch(/^SMTP_PASSWORD=/mu);
    for (const backup of envBackups(targetDir)) expect(readFileSync(backup, "utf8"), backup).not.toMatch(/^SMTP_PASSWORD=/mu);
    expect(filesContaining(FAKE_PASSWORD, targetDir)).toEqual([]);
  });

  it("owner decision 2: a crash between the steps leaves the password in no backup either", () => {
    const targetDir = withMail();
    const crashed = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, upFails: true, ...MACHINE });
    expect(crashed.stdout).not.toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    // Only the live secret file may hold the password: never a copy of it.
    expect(filesContaining(FAKE_PASSWORD, targetDir)).toEqual([secretPath(targetDir)]);
    expect(secretFilesAnywhere(targetDir)).toEqual([secretPath(targetDir)]);
  });

  it("resumes after a crash between the steps: the secret stays while the stack may still mount it, and the next run finishes", () => {
    const targetDir = withMail();
    const first = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, upFails: true, ...MACHINE });
    expect(first.stdout).not.toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    expect(existsSync(secretPath(targetDir))).toBe(true);
    // The rewrite had happened; the secret is the one thing left to retire.
    expect(envOf(targetDir)).not.toMatch(/^SMTP_/mu);
    expect(runRepair(targetDir, ["--check"], IMPORTED).stdout).toContain(FINDING);
    const second = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...MACHINE });
    expect(second.stdout).toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    expect(existsSync(secretPath(targetDir))).toBe(false);
    expect(secretFilesAnywhere(targetDir)).toEqual([]);
    expect(runRepair(targetDir, ["--check"], IMPORTED).stdout).not.toContain("smtp-lines-retirable");
  });

  it("a deployment with source=none is untouched: no change to any file, no compose up", () => {
    const targetDir = withMail();
    const before = treeSnapshot(targetDir);
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...RUNNING, mailStatus: answer("none", false), ...MACHINE });
    expect(result.stdout).not.toContain("retire-smtp-lines");
    expect(treeSnapshot(targetDir)).toBe(before);
    expect(composeUpCalls(result)).toEqual([]);
  });
});

// R4 (inline review of b342ca61): the named rollback point must outlive the run.
describe("#1817 R4: the .env-orbit backup of a Repair retirement lasts", () => {
  it("is still there after the run, in a directory with mode 700, without any SMTP_PASSWORD= line, and its path is named on stderr", () => {
    const targetDir = withMail({ lines: true, overlayListed: true, overlayFile: true, secret: true }, { inlinePassword: true });
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...MACHINE });
    expect(result.stdout).toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    const backups = envBackups(targetDir);
    expect(backups.length, "no .env-orbit backup is left after the run").toBeGreaterThan(0);
    for (const backup of backups) {
      expect((statSync(dirname(backup)).mode & 0o777).toString(8), dirname(backup)).toBe("700");
      const text = readFileSync(backup, "utf8");
      expect(text).not.toMatch(/^SMTP_PASSWORD=/mu);
      expect(text).toContain("APP_URL=https://orbit.repair-test.internal");
    }
    expect(backups.some((backup) => result.stderr.includes(backup) || result.stderr.includes(dirname(backup))), result.stderr).toBe(true);
    // Owner decision 2 still holds: the secret is copied nowhere.
    expect(secretFilesAnywhere(targetDir)).toEqual([]);
    expect(filesContaining(FAKE_PASSWORD, targetDir)).toEqual([]);
  });

  it("with the password in the secret file: the backup lasts and the secret is copied nowhere", () => {
    const targetDir = withMail();
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...MACHINE });
    expect(result.stdout).toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    expect(envBackups(targetDir).length).toBeGreaterThan(0);
    expect(secretFilesAnywhere(targetDir)).toEqual([]);
    expect(filesContaining(FAKE_PASSWORD, targetDir)).toEqual([]);
  });
});

// Low: an .env-orbit edit between Repair's read and its rename. The harness has no hook for the middle of an
// action, so a `chmod` shim stands in: Repair chmods its temporary copy after reading .env-orbit and before the
// rename; the shim appends a line to the live file at that moment, once.
describe("#1817 low: an .env-orbit edit between Repair's read and its rename is not lost", () => {
  it("either the action refuses with no change, or the edit survives", () => {
    const targetDir = withMail();
    const shimDir = mkdtempSync(join(tmpdir(), "orbit-repair-1817-chmod-"));
    const marker = join(shimDir, "fired");
    const realChmod = spawnSync("bash", ["-c", "command -v chmod"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      join(shimDir, "chmod"),
      `#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    .env-orbit?*|*/.env-orbit?*)
      if [[ "$a" != *.example && ! -e '${marker}' ]]; then
        : > '${marker}'
        printf 'LATE_EDIT=kept\n' >> '${join(targetDir, ".env-orbit")}'
      fi;;
  esac
done
exec '${realChmod}' "$@"
`,
    );
    chmodSync(join(shimDir, "chmod"), 0o755);
    const result = runRepair(targetDir, ["--execute", "--safe-only"], {
      ...IMPORTED,
      env: { ORBIT_REPAIR_PROMPTS: "machine", PATH: `${shimDir}:${process.env.PATH}` },
      input: "y\n",
    });
    expect(existsSync(marker), "the chmod hook never fired: the temporary copy is no longer chmodded by name .env-orbit*").toBe(true);
    const env = envOf(targetDir);
    expect(env, result.stderr).toContain("LATE_EDIT=kept");
    // A refusal means no change: the lines and the secret are all still there.
    if (/^SMTP_HOST=/mu.test(env)) {
      expect(existsSync(secretPath(targetDir))).toBe(true);
      expect(result.stdout).not.toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    }
  });
});

// Rewrite: lines on non-SMTP keys survive byte for byte, quoted values and CRLF line endings included.
describe("#1817 rewrite: quoted values and CRLF line endings survive a Repair retirement", () => {
  const KEEP = ['CUSTOM_QUOTED="two words"\n', "CUSTOM_CRLF=plain\r\n", 'CUSTOM_QUOTED_CRLF="x y"\r\n', "CUSTOM_SINGLE='q'\n"];

  it("keeps them unchanged while the SMTP lines (CRLF too) and the overlay entry go", () => {
    const targetDir = withMail();
    const envPath = join(targetDir, ".env-orbit");
    appendFileSync(envPath, `${KEEP.join("")}SMTP_HOST=other.example.test\r\n`);
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...MACHINE });
    expect(result.stdout).toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    const env = envOf(targetDir);
    for (const kept of KEEP) expect(env, JSON.stringify(kept)).toContain(kept);
    expect(env).not.toMatch(/^SMTP_[A-Z_]+=/mu);
    expect(env).not.toMatch(/^COMPOSE_FILE=.*docker-compose\.mail\.yml/mu);
  });
});

// O-S5 (audit v0.3.9-c, #1844): run as root (sudo), retire-smtp-lines must give
// every file it leaves behind the deployment folder's owner, the rule
// restore-compose-file already follows (`chown --reference=.` when `id -u` is 0).
// Root is simulated with shims ahead of the real tools on PATH: `id -u` prints 0,
// and `chown` logs each call ("<args> exists=<yes|no for its last argument>"),
// then runs the real chown (which succeeds for the test user: `--reference=.`
// names its own uid) or fails, as the test asks. No fakeroot, so the assertions
// are on the chown calls and their timing, not on a uid.
const realTool = (name) => spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();

/**
 * chown: "pass" (log, then the real chown), "fail" (log, exit 1), "fail-backups-root" (exit 1 only when the last
 * argument is the orbit-install-backups folder itself). root: whether the `id` shim makes `id -u` print 0.
 * Each chown log line also goes, with the number of `compose up` calls the docker shim had logged by then, to
 * an order log, so a test can tell whether a chown came before the stack was started.
 */
function rootShims({ chown = "pass", root = true } = {}) {
  const dir = scratchDir("orbit-repair-os5-shims-");
  const log = join(dir, "chown.log");
  const order = join(dir, "chown-order.log");
  if (root) {
    writeFileSync(join(dir, "id"), `#!/usr/bin/env bash\nif [[ $# -eq 1 && "$1" == -u ]]; then echo 0; exit 0; fi\nexec '${realTool("id")}' "$@"\n`);
    chmodSync(join(dir, "id"), 0o755);
  }
  const outcome = {
    pass: `exec '${realTool("chown")}' "$@"`,
    fail: "exit 1",
    "fail-backups-root": `case "\${last%/}" in orbit-install-backups|./orbit-install-backups|*/orbit-install-backups) exit 1;; esac\nexec '${realTool("chown")}' "$@"`,
  }[chown];
  writeFileSync(
    join(dir, "chown"),
    `#!/usr/bin/env bash
last="\${@: -1}"
if [[ -e "$last" || -L "$last" ]]; then there=yes; else there=no; fi
printf '%s exists=%s\\n' "$*" "$there" >> '${log}'
# The harness's docker wrapper names its state folder on its second line (S='...'); argv.log there lists every docker call so far.
state="$(sed -n "2s/^S='\\(.*\\)'\$/\\1/p" "$(command -v docker)" 2>/dev/null)"
ups=unknown
if [[ -n "$state" ]]; then ups="$(grep -cE '\\bcompose\\b.*\\bup\\b' "$state/argv.log" 2>/dev/null)"; ups="\${ups:-0}"; fi
printf '%s ups=%s\\n' "$last" "$ups" >> '${order}'
${outcome}
`,
  );
  chmodSync(join(dir, "chown"), 0o755);
  const read = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
  return {
    dir,
    log,
    env: { ORBIT_REPAIR_PROMPTS: "machine", PATH: `${dir}:${process.env.PATH}` },
    calls: () => read(log),
    order: () => read(order).map((line) => /^(.*) ups=(\S+)$/u.exec(line)).map((found) => ({ path: found[1].replace(/^\.\//u, ""), ups: found[2] })),
  };
}

/** The chown calls, each parsed as `--reference=. -- <path> exists=<yes|no>`; any other form is kept with form=null. */
const chownCalls = (shims) =>
  shims.calls().map((line) => {
    const found = /^--reference=\. -- (\S+) exists=(yes|no)$/u.exec(line);
    return found ? { line, path: found[1].replace(/^\.\//u, ""), exists: found[2] } : { line, path: null, exists: null };
  });
const DATED = /^orbit-install-backups\/\d{8}T\d{6}Z-repair(-\d)?$/u;
const DONE = "execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done";

describe("O-S5 (#1844): a root run of retire-smtp-lines leaves nothing owned by root", () => {
  it("gives every lasting file the folder's owner (chown --reference=.) before it is renamed or left, the rewritten copy before compose up", () => {
    const targetDir = withMail({ lines: true, overlayListed: true, overlayFile: true, secret: true }, { inlinePassword: true });
    const shims = rootShims();
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, env: shims.env, input: "y\n" });
    expect(result.stdout, result.stderr).toContain(DONE);
    const calls = chownCalls(shims);
    expect(calls.length, "chown was never run under a root run").toBeGreaterThan(0);
    for (const call of calls) expect(call.path, `a chown call not of the form --reference=. -- <path>: ${call.line}`).not.toBeNull();
    const named = (test) => calls.filter((call) => (typeof test === "string" ? call.path === test : test.test(call.path)));
    const datedFolder = named(DATED);
    for (const [label, test] of [
      [".env-orbit.retire-smtp.tmp", ".env-orbit.retire-smtp.tmp"],
      ["orbit-install-backups", "orbit-install-backups"],
      ["orbit-install-backups/<stamp>-repair", DATED],
      [".orbit-smtp-retirement.tmp", ".orbit-smtp-retirement.tmp"],
    ]) {
      const hits = named(test);
      expect(hits.length, `no chown names ${label}:\n${shims.calls().join("\n")}`).toBeGreaterThan(0);
      for (const hit of hits) expect(hit.exists, hit.line).toBe("yes");
    }
    const copy = `${datedFolder[0].path}/.env-orbit`;
    const copyHits = named(copy);
    expect(copyHits.length, `no chown names ${copy}:\n${shims.calls().join("\n")}`).toBeGreaterThan(0);
    for (const hit of copyHits) expect(hit.exists, hit.line).toBe("yes");
    // The rewritten copy is chowned before it is renamed over .env-orbit, so before the stack is started on it.
    expect(composeUpCalls(result).length).toBeGreaterThan(0);
    const tmpOrder = shims.order().filter((entry) => entry.path === ".env-orbit.retire-smtp.tmp");
    expect(tmpOrder.length).toBeGreaterThan(0);
    for (const entry of tmpOrder) expect(entry.ups, "the chown of .env-orbit.retire-smtp.tmp came after compose up").toBe("0");
  });

  it("a record that lingers after a failed start has been given the folder's owner too, and a later ordinary run finishes", () => {
    const targetDir = withMail();
    const shims = rootShims();
    const first = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, upFails: true, env: shims.env, input: "y\n" });
    expect(first.stdout).not.toContain(DONE);
    expect(existsSync(join(targetDir, ".orbit-smtp-retirement"))).toBe(true);
    expect(envOf(targetDir)).not.toMatch(/^SMTP_/mu);
    const calls = chownCalls(shims);
    for (const path of [".orbit-smtp-retirement.tmp", ".env-orbit.retire-smtp.tmp"]) {
      const hits = calls.filter((call) => call.path === path);
      expect(hits.length, `no chown names ${path}:\n${shims.calls().join("\n")}`).toBeGreaterThan(0);
      for (const hit of hits) expect(hit.exists, hit.line).toBe("yes");
    }
    const second = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...MACHINE });
    expect(second.stdout, second.stderr).toContain(DONE);
    expect(existsSync(secretPath(targetDir))).toBe(false);
  });

  it("a chown that fails on the rewritten copy leaves everything as it was, and says so", () => {
    const targetDir = withMail();
    const shims = rootShims({ chown: "fail" });
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, env: shims.env, input: "y\n" });
    expect(result.stdout).not.toContain(DONE);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("retire-smtp-lines left .env-orbit as it was: the rewritten copy could not be given the folder's owner");
    expect(envOf(targetDir)).toContain("SMTP_HOST=");
    expect((statSync(join(targetDir, ".env-orbit")).mode & 0o777).toString(8)).toBe("600");
    expect(existsSync(join(targetDir, ".env-orbit.retire-smtp.tmp"))).toBe(false);
    expect(existsSync(secretPath(targetDir))).toBe(true);
    expect(composeUpCalls(result)).toEqual([]);
    expect(envBackups(targetDir)).toEqual([]);
  });

  it("a chown that fails on the backup folder refuses with the backup message and leaves no backup", () => {
    const targetDir = withMail();
    const before = envOf(targetDir);
    const shims = rootShims({ chown: "fail-backups-root" });
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, env: shims.env, input: "y\n" });
    expect(result.stdout).not.toContain(DONE);
    expect(result.stderr).toContain("the backup of .env-orbit could not be made in orbit-install-backups");
    expect(envOf(targetDir)).toBe(before);
    expect((statSync(join(targetDir, ".env-orbit")).mode & 0o777).toString(8)).toBe("600");
    expect(existsSync(join(targetDir, ".env-orbit.retire-smtp.tmp"))).toBe(false);
    expect(existsSync(join(targetDir, ".orbit-smtp-retirement"))).toBe(false);
    expect(composeUpCalls(result)).toEqual([]);
    // orbit-install-backups itself may remain, but empty.
    expect(envBackups(targetDir)).toEqual([]);
    expect(findCalls(["-path", join(targetDir, "orbit-install-backups", "*")], targetDir)).toEqual([]);
  });

  it("as the folder's own user nothing is chowned and the action completes", () => {
    const targetDir = withMail();
    const shims = rootShims({ chown: "fail", root: false });
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, env: shims.env, input: "y\n" });
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(existsSync(shims.log), `chown was run as an ordinary user:\n${shims.calls().join("\n")}`).toBe(false);
    const env = envOf(targetDir);
    expect(env).not.toMatch(/^SMTP_[A-Z_]+=/mu);
    expect(env).not.toMatch(/^COMPOSE_FILE=.*docker-compose\.mail\.yml/mu);
    expect(existsSync(join(targetDir, "docker-compose.mail.yml"))).toBe(false);
    expect(existsSync(secretPath(targetDir))).toBe(false);
    const backups = envBackups(targetDir);
    expect(backups.length).toBeGreaterThan(0);
    for (const backup of backups) expect((statSync(dirname(backup)).mode & 0o777).toString(8), dirname(backup)).toBe("700");
  });
});

describe("O-S5 (#1844): the contract names the owner rule", () => {
  const phrase = "the deployment folder's owner";
  const flat = (text) => text.replace(/\s+/gu, " ");

  it("repair guarantee 59 in docs/installer-guarantees.md says what a root run leaves behind takes the deployment folder's owner", () => {
    const guarantees = readFileSync(join(repoDir, "docs", "installer-guarantees.md"), "utf8");
    const line = guarantees.split("\n").find((entry) => entry.startsWith("59. `smtp-lines-retirable`"));
    expect(line, "guarantee 59 (smtp-lines-retirable) is not found").toBeDefined();
    expect(flat(line)).toContain(phrase);
  });

  it("the retire-smtp-lines comment block in repair.sh says the same", () => {
    const source = readFileSync(join(scriptsDir, "repair.sh"), "utf8").split("\n");
    const start = source.findIndex((entry) => /^# --- retire-smtp-lines \(#1817\)/u.test(entry));
    expect(start, "repair.sh no longer has the retire-smtp-lines heading").toBeGreaterThan(-1);
    let end = start + 1;
    while (end < source.length && source[end].startsWith("#")) end += 1;
    const block = flat(source.slice(start, end).map((entry) => entry.replace(/^#\s?/u, "")).join(" "));
    expect(block).toContain(phrase);
  });
});
