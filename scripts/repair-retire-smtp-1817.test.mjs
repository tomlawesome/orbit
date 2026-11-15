import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { composeUpCalls, makeFixture, repoDir, runRepair, runRepairBetweenPlanAndExecute, scratchDir, scriptsDir, stderrLines, treeSnapshot } from "./repair-test-harness.mjs";

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
//  - The undo copy covers only the lines the retirement removes, never the
//    secret; the action's metadata says plainly that the secret cannot be
//    rolled back.
//  - Owner decision 2: the secret is deleted, never copied, on either path.
//  - #1834 slice 1 (owner decision 10a, 2026-11-14) supersedes "the backup
//    lasts" (R4): the copy holds only the removed lines (never SMTP_PASSWORD or
//    any other line), and is removed in the same run once `orbit
//    mail-sending-status` is usable again after the secret is gone.

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

  it("owner decision 2: an inline password is in no file afterwards, and no .env-orbit copy is left (#1834 10a: removed in the same run)", () => {
    const targetDir = withMail({ lines: true, overlayListed: true, overlayFile: true, secret: false }, { inlinePassword: true });
    expect(envOf(targetDir)).toContain(`SMTP_PASSWORD=${FAKE_PASSWORD}`);
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...MACHINE });
    expect(result.stdout).toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    expect(envOf(targetDir)).not.toMatch(/^SMTP_PASSWORD=/mu);
    expect(envBackups(targetDir)).toEqual([]);
    expect(filesContaining(FAKE_PASSWORD, targetDir)).toEqual([]);
  });

  it("owner decision 2: a crash between the steps leaves the password in no backup either, and the copy holds only the removed lines (#1834 10a)", () => {
    const targetDir = withMail();
    const crashed = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, upFails: true, ...MACHINE });
    expect(crashed.stdout).not.toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    // Only the live secret file may hold the password: never a copy of it.
    expect(filesContaining(FAKE_PASSWORD, targetDir)).toEqual([secretPath(targetDir)]);
    expect(secretFilesAnywhere(targetDir)).toEqual([secretPath(targetDir)]);
    // The stack was never restarted on the rewritten file: the copy stays, with only the removed lines.
    const copies = envBackups(targetDir);
    expect(copies).toHaveLength(1);
    expect(readFileSync(copies[0], "utf8").split("\n").filter(Boolean)).toEqual(REMOVED_LINES);
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

// #1834 slice 1 (owner decision 10a) replaces R4 ("the backup lasts"): the undo copy
// holds only the removed lines and is removed in the same run once mail sending is
// confirmed; kept and named when it is not.
const REMOVED_LINES = [
  "COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml",
  "SMTP_HOST=smtp.example.test",
  "SMTP_PORT=587",
  "SMTP_SECURITY=starttls",
  "SMTP_USER=orbit@example.test",
  "SMTP_PASSWORD_FILE=/run/orbit-secrets/orbit-smtp-password",
  "SMTP_FROM=Orbit <orbit@example.test>",
];
const KEK_LINE = "DOCUMENT_KEK=TEST-NOT-A-REAL-KEK";
const GATE_FAILS_AFTER = { mailStatusAfterSecretGone: answer("none", false) };
const backupFolders = (targetDir) => (existsSync(join(targetDir, "orbit-install-backups")) ? readdirSync(join(targetDir, "orbit-install-backups")).sort() : []);
const RECORD = ".orbit-smtp-retirement";

describe("#1834 slice 1: the Repair undo copy holds only the removed lines and is removed in the same run", () => {
  it("mail sending usable afterwards: the copy, the overlay copy, the folder and the step record are gone; the run leaves nothing behind", () => {
    const targetDir = withMail({ lines: true, overlayListed: true, overlayFile: true, secret: true }, { inlinePassword: true });
    appendFileSync(join(targetDir, ".env-orbit"), `${KEK_LINE}\n`);
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...MACHINE });
    expect(result.stdout).toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    expect(envBackups(targetDir)).toEqual([]);
    expect(findCalls(["-path", join(targetDir, "orbit-install-backups", "*"), "-name", "docker-compose.mail.yml"], targetDir)).toEqual([]);
    expect(backupFolders(targetDir)).toEqual([]);
    expect(existsSync(join(targetDir, RECORD))).toBe(false);
    expect(filesContaining("TEST-NOT-A-REAL-KEK", join(targetDir, "orbit-install-backups"))).toEqual([]);
    expect(filesContaining(FAKE_PASSWORD, targetDir)).toEqual([]);
  });

  it("mail sending not confirmed afterwards: the copy and the overlay copy are kept (mode 600, folder 700), one line names the path and why, and the run still finishes", () => {
    const targetDir = withMail();
    appendFileSync(join(targetDir, ".env-orbit"), `SMTP_PASSWORD=${FAKE_PASSWORD}\n${KEK_LINE}\nPOSTGRES_PASSWORD=TEST-NOT-A-REAL-PG-PASSWORD\n`);
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...GATE_FAILS_AFTER, ...MACHINE });
    expect(result.stdout).toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    expect(existsSync(secretPath(targetDir))).toBe(false);
    const copies = envBackups(targetDir);
    expect(copies).toHaveLength(1);
    expect((statSync(copies[0]).mode & 0o777).toString(8)).toBe("600");
    expect((statSync(dirname(copies[0])).mode & 0o777).toString(8)).toBe("700");
    // Only the removed lines: not SMTP_PASSWORD, not the key, not the other secret, not the commented lines.
    const text = readFileSync(copies[0], "utf8");
    expect(text.split("\n").filter(Boolean)).toEqual(REMOVED_LINES);
    expect(text).not.toContain("DOCUMENT_KEK");
    expect(text).not.toContain("POSTGRES_PASSWORD");
    expect(text).not.toContain("APP_URL");
    expect(filesContaining(FAKE_PASSWORD, targetDir)).toEqual([]);
    const naming = `${result.stdout}\n${result.stderr}`.split("\n").filter((entry) => entry.includes(copies[0]));
    expect(naming).toHaveLength(1);
    expect(naming[0]).toMatch(/kept/iu);
    expect(naming[0]).toMatch(/mail sending/iu);
    expect(naming[0]).toMatch(/confirm/iu);
    expect(existsSync(join(targetDir, RECORD))).toBe(true);
  });

  it("the DOCUMENT_KEK line is never copied, whichever way the run ends", () => {
    for (const options of [{}, GATE_FAILS_AFTER]) {
      const targetDir = withMail();
      appendFileSync(join(targetDir, ".env-orbit"), `${KEK_LINE}\n`);
      runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...options, ...MACHINE });
      expect(filesContaining("TEST-NOT-A-REAL-KEK", join(targetDir, "orbit-install-backups"))).toEqual([]);
      expect(envOf(targetDir)).toContain(KEK_LINE);
    }
  });

  it("interrupted run: the next run removes the kept copy, the overlay copy and the record once the gate holds, and makes no new copy", () => {
    const targetDir = withMail();
    const first = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...GATE_FAILS_AFTER, ...MACHINE });
    expect(first.stdout).toContain("result=done");
    expect(envBackups(targetDir)).toHaveLength(1);
    expect(existsSync(join(targetDir, RECORD))).toBe(true);
    const foldersBefore = backupFolders(targetDir);
    const second = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...MACHINE });
    expect(second.stdout).toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    expect(envBackups(targetDir)).toEqual([]);
    expect(findCalls(["-path", join(targetDir, "orbit-install-backups", "*"), "-name", "docker-compose.mail.yml"], targetDir)).toEqual([]);
    expect(existsSync(join(targetDir, RECORD))).toBe(false);
    for (const name of backupFolders(targetDir)) expect(foldersBefore).toContain(name);
  });

  it("a folder that holds anything else is left in place; only the files the retirement wrote go", () => {
    const targetDir = withMail();
    runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...GATE_FAILS_AFTER, ...MACHINE });
    const [copy] = envBackups(targetDir);
    expect(copy).toBeDefined();
    const other = join(dirname(copy), "other-file.txt");
    writeFileSync(other, "left by another run\n");
    const second = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...MACHINE });
    expect(second.stdout).toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(join(dirname(copy), "docker-compose.mail.yml"))).toBe(false);
    expect(readFileSync(other, "utf8")).toBe("left by another run\n");
    expect(existsSync(join(targetDir, RECORD))).toBe(false);
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

// #1834 slice 4, review of a7aa25e5: Repair after an install killed between the SMTP copy and
// its step record. The state is planted as install.sh (a7aa25e5) leaves it: a dated folder with
// the marker .orbit-smtp-undo naming that folder ("copy=orbit-install-backups/<name>"), then the
// copy, and no step record. Repair adopts it exactly as install does: no second copy.
const ORPHAN = "orbit-install-backups/20260101T000000Z";
function withKilledInstallOrphan({ markerNames = ORPHAN, markerIsSymlink = false } = {}) {
  const targetDir = withMail();
  const folder = join(targetDir, ORPHAN);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(join(targetDir, "orbit-install-backups"), 0o700);
  chmodSync(folder, 0o700);
  const marker = join(folder, ".orbit-smtp-undo");
  if (markerIsSymlink) {
    const outside = mkdtempSync(join(tmpdir(), "orbit-marker-outside-"));
    writeFileSync(join(outside, "marker"), `copy=${markerNames}\n`, { mode: 0o600 });
    symlinkSync(join(outside, "marker"), marker);
  } else {
    writeFileSync(marker, `copy=${markerNames}\n`, { mode: 0o600 });
  }
  writeFileSync(join(folder, ".env-orbit"), `${REMOVED_LINES.join("\n")}\n`, { mode: 0o600 });
  expect(existsSync(join(targetDir, RECORD))).toBe(false);
  return { targetDir, folder, copy: join(folder, ".env-orbit") };
}
/** Every file under `folder` with its bytes, as one comparable string. */
const folderBytes = (folder) =>
  spawnSync("bash", ["-c", 'find . -mindepth 1 -printf "%p %y %m\\n" | LC_ALL=C sort; find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum'], { cwd: folder, encoding: "utf8" }).stdout;

describe("#1834 slice 4 review: Repair adopts the SMTP copy a killed install left", () => {
  it("mail sending confirmed: the adopted copy, its marker and its folder are gone, and no other copy is left", () => {
    const { targetDir, folder } = withKilledInstallOrphan();
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...MACHINE });
    expect(result.stdout).toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    expect(envBackups(targetDir)).toEqual([]);
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(join(targetDir, RECORD))).toBe(false);
  });

  it("mail sending not confirmed: exactly one copy, the adopted one, holding the removed lines; no second folder", () => {
    const { targetDir, copy } = withKilledInstallOrphan();
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...GATE_FAILS_AFTER, ...MACHINE });
    expect(result.stdout).toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    expect(envBackups(targetDir)).toEqual([copy]);
    expect(readFileSync(copy, "utf8").split("\n").filter(Boolean)).toEqual(REMOVED_LINES);
    expect(backupFolders(targetDir)).toEqual(["20260101T000000Z"]);
    expect(existsSync(join(targetDir, RECORD))).toBe(true);
  });

  for (const [label, options] of [
    ["a marker that names a different folder", { markerNames: "orbit-install-backups/20250101T000000Z" }],
    ["a symlinked marker", { markerIsSymlink: true }],
  ]) {
    it(`${label} is never adopted: that folder is left byte for byte`, () => {
      const { targetDir, folder } = withKilledInstallOrphan(options);
      const before = folderBytes(folder);
      const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...GATE_FAILS_AFTER, ...MACHINE });
      expect(result.stdout).toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
      expect(folderBytes(folder)).toBe(before);
    });
  }

  it("the adopted copy is a hard link to another file: that file is unchanged after the run", () => {
    const { targetDir, copy } = withKilledInstallOrphan();
    const victim = join(targetDir, "operator-notes.txt");
    writeFileSync(victim, "the operator's own notes\n", { mode: 0o600 });
    spawnSync("rm", ["-f", "--", copy]);
    linkSync(victim, copy);
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...GATE_FAILS_AFTER, ...MACHINE });
    expect(result.status).not.toBeNull();
    expect(readFileSync(victim, "utf8")).toBe("the operator's own notes\n");
  });
});

// O-S5 (audit v0.3.9-c, #1844): run as root (sudo), retire-smtp-lines must give
// every file it leaves behind the deployment folder's owner, the rule
// restore-compose-file already follows (`chown --reference=.` when `id -u` is 0).
// Root is simulated with shims ahead of the real tools on PATH: `id -u` prints 0,
// and `chown` logs each call ("<args> exists=<yes|no> link=<yes|no>", both for its
// last argument, `link` being `-L`), then runs the real chown (which succeeds for
// the test user: `--reference=.` names its own uid) or fails, as the test asks.
// No fakeroot, so the assertions are on the chown calls and their timing, not on
// a uid. FIX-S1 (audit v0.3.9-c, #1844) adds the `--no-dereference` form and the
// `plant` hook, which plants symlinks the moment a folder is chowned.
const realTool = (name) => spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();

/** A JavaScript regex on a folder-relative path, as a bash ERE for `[[ =~ ]]` (only `\d` needs translating). */
const bashRegex = (regex) => regex.source.replace(/\\d/gu, "[0-9]");

/**
 * chown: "pass" (log, then the real chown), "fail" (log, exit 1), "fail-backups-root" (exit 1 only when the last
 * argument is the orbit-install-backups folder itself), "fail-dated" (exit 1 only when the last argument is a dated
 * backup folder, DATED), "fail-match" (exit 1 only when the last argument, ./ and a trailing / stripped, matches the
 * failWhen regex). root: whether the `id` shim makes `id -u` print 0.
 * plant: { when: <regex on the last argument, ./ and a trailing / stripped>, links: [[name, target], ...] }: when a
 * chown names a matching path, `ln -s <target> "<last>/<name>"` is run for each pair (a failure ignored) before the
 * real chown, the first instant the folder's owner could create an entry there.
 * Each chown log line also goes, with the number of `compose up` calls the docker shim had logged by then, to
 * an order log, so a test can tell whether a chown came before the stack was started.
 * When a chown names a directory (not a link), its entries down to two levels at that moment (`find -printf '%P:%y'`)
 * go to a contents log, so a test can tell what was already in a folder when it changed owner.
 */
function rootShims({ chown = "pass", root = true, plant = null, failWhen = null } = {}) {
  const dir = scratchDir("orbit-repair-os5-shims-");
  const log = join(dir, "chown.log");
  const order = join(dir, "chown-order.log");
  const datedRegex = join(dir, "dated.re");
  writeFileSync(datedRegex, bashRegex(DATED));
  const contents = join(dir, "chown-contents.log");
  const failRegex = join(dir, "fail.re");
  if (failWhen) writeFileSync(failRegex, bashRegex(failWhen));
  const plantRegex = join(dir, "plant.re");
  let planting = "";
  if (plant) {
    writeFileSync(plantRegex, bashRegex(plant.when));
    const links = plant.links.map(([name, target]) => `  ln -s '${target}' "$last/${name}" 2>/dev/null || true`).join("\n");
    planting = `re="$(cat '${plantRegex}')"\nif [[ "$rel" =~ $re ]]; then\n${links}\nfi\n`;
  }
  if (root) {
    writeFileSync(join(dir, "id"), `#!/usr/bin/env bash\nif [[ $# -eq 1 && "$1" == -u ]]; then echo 0; exit 0; fi\nexec '${realTool("id")}' "$@"\n`);
    chmodSync(join(dir, "id"), 0o755);
  }
  const outcome = {
    pass: `exec '${realTool("chown")}' "$@"`,
    fail: "exit 1",
    "fail-backups-root": `case "\${last%/}" in orbit-install-backups|./orbit-install-backups|*/orbit-install-backups) exit 1;; esac\nexec '${realTool("chown")}' "$@"`,
    "fail-dated": `re="$(cat '${datedRegex}')"\nif [[ "$rel" =~ $re ]]; then exit 1; fi\nexec '${realTool("chown")}' "$@"`,
    "fail-match": `re="$(cat '${failRegex}')"\nif [[ "$rel" =~ $re ]]; then exit 1; fi\nexec '${realTool("chown")}' "$@"`,
  }[chown];
  writeFileSync(
    join(dir, "chown"),
    `#!/usr/bin/env bash
last="\${@: -1}"
rel="\${last#./}"; rel="\${rel%/}"
if [[ -e "$last" || -L "$last" ]]; then there=yes; else there=no; fi
if [[ -L "$last" ]]; then link=yes; else link=no; fi
printf '%s exists=%s link=%s\\n' "$*" "$there" "$link" >> '${log}'
# The harness's docker wrapper names its state folder on its second line (S='...'); argv.log there lists every docker call so far.
state="$(sed -n "2s/^S='\\(.*\\)'\$/\\1/p" "$(command -v docker)" 2>/dev/null)"
ups=unknown
if [[ -n "$state" ]]; then ups="$(grep -cE '\\bcompose\\b.*\\bup\\b' "$state/argv.log" 2>/dev/null)"; ups="\${ups:-0}"; fi
printf '%s ups=%s\\n' "$last" "$ups" >> '${order}'
if [[ -d "$last" && ! -L "$last" ]]; then printf '%s|%s\\n' "$rel" "$(find "$last" -mindepth 1 -maxdepth 2 -printf '%P:%y ' 2>/dev/null)" >> '${contents}'; fi
${planting}${outcome}
`,
  );
  chmodSync(join(dir, "chown"), 0o755);
  const read = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
  return {
    dir,
    log,
    env: { ORBIT_REPAIR_PROMPTS: "machine", PATH: `${dir}:${process.env.PATH}` },
    calls: () => read(log),
    /** Each chown of a directory, in order: { path, entries: ["<relative path>:<find %y type>", ...] }. */
    contents: () => read(contents).map((line) => /^([^|]*)\|(.*)$/u.exec(line)).map((found) => ({ path: found[1], entries: found[2].split(" ").filter(Boolean) })),
    order: () => read(order).map((line) => /^(.*) ups=(\S+)$/u.exec(line)).map((found) => ({ path: found[1].replace(/^\.\//u, ""), ups: found[2] })),
  };
}

/**
 * The chown calls, each parsed as `--no-dereference --reference=. -- <path> exists=<yes|no> link=<yes|no>`; any
 * other form (the dereferencing `--reference=. -- <path>` included) is kept with path=null.
 */
const chownCalls = (shims) =>
  shims.calls().map((line) => {
    const found = /^--no-dereference --reference=\. -- (\S+) exists=(yes|no) link=(yes|no)$/u.exec(line);
    return found ? { line, path: found[1].replace(/^\.\//u, ""), exists: found[2], link: found[3] } : { line, path: null, exists: null, link: null };
  });
/** Every call is of the --no-dereference form and none names a symlink. */
const expectNoDereference = (calls) => {
  for (const call of calls) {
    expect(call.path, `a chown call not of the form --no-dereference --reference=. -- <path>: ${call.line}`).not.toBeNull();
    expect(call.link, `a chown call names a symlink: ${call.line}`).toBe("no");
  }
};
const RECORD_TMP = /^\.orbit-smtp-retirement\.[A-Za-z0-9]{6}$/u;
const REWRITE_TMP = /^\.env-orbit\.retire-smtp\.[A-Za-z0-9]{6}$/u;
/** Top-level names in the folder like a mktemp leftover of the record or of the rewrite (`<fixed>.??????`). */
const tempLeftovers = (targetDir) => readdirSync(targetDir).filter((name) => /^\.(orbit-smtp-retirement|env-orbit\.retire-smtp)\..{6}$/u.test(name));
const modeOf = (path) => (statSync(path).mode & 0o777).toString(8);
/** Whether anything, a dangling symlink included, is at the path. */
const lstatExists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
/** An existing file outside the deployment folder that a planted link points at: content KEEP, mode 0644. */
function outsideFile(dir = scratchDir("orbit-repair-fix-s1-outside-"), name = "target") {
  const path = join(dir, name);
  writeFileSync(path, "KEEP\n");
  chmodSync(path, 0o644);
  const stat = statSync(path);
  return { path, before: { bytes: readFileSync(path).toString("hex"), mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid } };
}
/** The outside file is still there with the same bytes, mode, owner and group. */
function unchanged(outside) {
  expect(existsSync(outside.path), `${outside.path} is gone`).toBe(true);
  const stat = statSync(outside.path);
  const now = { bytes: readFileSync(outside.path).toString("hex"), mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid };
  expect(now, `${outside.path} was written through a link: ${JSON.stringify(readFileSync(outside.path, "utf8"))}`).toEqual(outside.before);
}
const DATED = /^orbit-install-backups\/\d{8}T\d{6}Z-repair(-\d)?$/u;
const DONE = "execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done";

describe("O-S5 (#1844): a root run of retire-smtp-lines leaves nothing owned by root", () => {
  // FIX-S1 test 6: the same outcome with mktemp names and the --no-dereference form.
  it("gives every lasting file the folder's owner (chown --no-dereference --reference=.) before it is renamed or left, the rewritten copy before compose up", () => {
    const targetDir = withMail({ lines: true, overlayListed: true, overlayFile: true, secret: true }, { inlinePassword: true });
    const shims = rootShims();
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, env: shims.env, input: "y\n" });
    expect(result.stdout, result.stderr).toContain(DONE);
    const calls = chownCalls(shims);
    expect(calls.length, "chown was never run under a root run").toBeGreaterThan(0);
    expectNoDereference(calls);
    const named = (test) => calls.filter((call) => call.path !== null && (typeof test === "string" ? call.path === test : test.test(call.path)));
    const datedFolder = named(DATED);
    for (const [label, test] of [
      [".env-orbit.retire-smtp.<6>", REWRITE_TMP],
      ["orbit-install-backups", "orbit-install-backups"],
      ["orbit-install-backups/<stamp>-repair", DATED],
      [".orbit-smtp-retirement.<6>", RECORD_TMP],
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
    const tmpOrder = shims.order().filter((entry) => REWRITE_TMP.test(entry.path));
    expect(tmpOrder.length).toBeGreaterThan(0);
    for (const entry of tmpOrder) expect(entry.ups, "the chown of the rewritten copy came after compose up").toBe("0");
    // The record is removed at the end, and no mktemp name is left behind.
    expect(existsSync(join(targetDir, ".orbit-smtp-retirement"))).toBe(false);
    expect(tempLeftovers(targetDir)).toEqual([]);
  });

  it("a record that lingers after a failed start has been given the folder's owner too, and a later ordinary run finishes", () => {
    const targetDir = withMail();
    const shims = rootShims();
    const first = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, upFails: true, env: shims.env, input: "y\n" });
    expect(first.stdout).not.toContain(DONE);
    expect(existsSync(join(targetDir, ".orbit-smtp-retirement"))).toBe(true);
    expect(envOf(targetDir)).not.toMatch(/^SMTP_/mu);
    const calls = chownCalls(shims);
    expectNoDereference(calls);
    for (const test of [RECORD_TMP, REWRITE_TMP]) {
      const hits = calls.filter((call) => call.path !== null && test.test(call.path));
      expect(hits.length, `no chown names ${test}:\n${shims.calls().join("\n")}`).toBeGreaterThan(0);
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

  // FIX-S1 test 7: also no mktemp name is left behind and the record is gone.
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
    // #1834: mail sending was confirmed, so the undo copy is gone with its folder.
    expect(envBackups(targetDir)).toEqual([]);
    expect(tempLeftovers(targetDir)).toEqual([]);
    expect(existsSync(join(targetDir, ".orbit-smtp-retirement"))).toBe(false);
    // The copy's folder is mode 700 while it lasts: kept when mail sending cannot be confirmed (#1834).
    const keptDir = withMail();
    const keptShims = rootShims({ chown: "fail", root: false });
    const kept = runRepair(keptDir, ["--execute", "--safe-only"], { ...IMPORTED, ...GATE_FAILS_AFTER, env: keptShims.env, input: "y\n" });
    expect(kept.stdout, kept.stderr).toContain(DONE);
    expect(existsSync(keptShims.log), `chown was run as an ordinary user:\n${keptShims.calls().join("\n")}`).toBe(false);
    const backups = envBackups(keptDir);
    expect(backups.length).toBeGreaterThan(0);
    for (const backup of backups) expect((statSync(dirname(backup)).mode & 0o777).toString(8), dirname(backup)).toBe("700");
    expect(tempLeftovers(keptDir)).toEqual([]);
  });
});

// FIX-S1 (audit v0.3.9-c, #1844): a root run never writes, creates or re-owns anything through a symlink planted
// at a fixed name in the deployment folder or the backup folder. The folder's owner can create any entry there, so
// every file is written to a name mktemp chooses, chowned with --no-dereference and renamed over its fixed name,
// and the backup folder is given to the folder's owner only once its copies are in it.
describe("FIX-S1 (#1844): a root run of retire-smtp-lines does not follow a planted symlink", () => {
  const RECORD = ".orbit-smtp-retirement";
  const RECORD_FIXED_TMP = ".orbit-smtp-retirement.tmp";
  const REWRITE_FIXED_TMP = ".env-orbit.retire-smtp.tmp";
  const OVERLAY = "services:\n  orbit-app:\n    secrets:\n      - orbit-smtp-password\n";
  const runAsRoot = (targetDir, shims, extra = {}) => runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...extra, env: shims.env, input: "y\n" });

  /**
   * The record a failed start leaves is a regular mode-600 file holding step=backed-up and, since #1834, copy= naming
   * the undo copy's dated folder, not the planted link.
   */
  function expectRegularRecord(targetDir) {
    const path = join(targetDir, RECORD);
    expect(existsSync(path) || lstatExists(path), `${RECORD} was not written`).toBe(true);
    expect(lstatSync(path).isSymbolicLink(), `${RECORD} is a symlink: the planted link was renamed over it`).toBe(false);
    expect(readFileSync(path, "utf8")).toMatch(/^step=backed-up\ncopy=orbit-install-backups\/\d{8}T\d{6}Z-repair(-\d)?\n$/u);
    expect(modeOf(path)).toBe("600");
  }

  function expectRecordChownedByMktempName(shims) {
    const calls = chownCalls(shims);
    expect(calls.length, "chown was never run under a root run").toBeGreaterThan(0);
    expectNoDereference(calls);
    expect(calls.filter((call) => call.path === RECORD_FIXED_TMP || /\.orbit-smtp-retirement\.tmp(\s|$)/u.test(call.line))).toEqual([]);
    const hits = calls.filter((call) => call.path !== null && RECORD_TMP.test(call.path));
    expect(hits.length, `no chown names ${RECORD}.<6>:\n${shims.calls().join("\n")}`).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.exists, hit.line).toBe("yes");
  }

  it("test 1: a symlink planted at .orbit-smtp-retirement.tmp is neither written through nor re-owned", () => {
    const targetDir = withMail();
    const outside = outsideFile();
    const planted = join(targetDir, RECORD_FIXED_TMP);
    symlinkSync(outside.path, planted);
    const shims = rootShims();
    const result = runAsRoot(targetDir, shims, { upFails: true });
    expect(result.stdout).not.toContain(DONE);
    unchanged(outside);
    expect(lstatSync(planted).isSymbolicLink(), "the planted link was removed or replaced").toBe(true);
    expect(readlinkSync(planted)).toBe(outside.path);
    expectRegularRecord(targetDir);
    expect(envOf(targetDir), result.stderr).not.toMatch(/^SMTP_/mu);
    expectRecordChownedByMktempName(shims);
    expect(readdirSync(targetDir).filter((name) => /^\.orbit-smtp-retirement\..{6}$/u.test(name))).toEqual([]);
  });

  it("test 2: a dangling symlink at .orbit-smtp-retirement.tmp does not make root create its target", () => {
    const targetDir = withMail();
    const missing = join(scratchDir("orbit-repair-fix-s1-outside-"), "created-by-root");
    const planted = join(targetDir, RECORD_FIXED_TMP);
    symlinkSync(missing, planted);
    const shims = rootShims();
    const result = runAsRoot(targetDir, shims, { upFails: true });
    expect(result.stdout).not.toContain(DONE);
    expect(existsSync(missing), `root created ${missing} through the dangling link: ${existsSync(missing) ? JSON.stringify(readFileSync(missing, "utf8")) : ""}`).toBe(false);
    expect(lstatSync(planted).isSymbolicLink(), "the planted link was removed or replaced").toBe(true);
    expect(readlinkSync(planted)).toBe(missing);
    expectRegularRecord(targetDir);
    expect(envOf(targetDir), result.stderr).not.toMatch(/^SMTP_/mu);
    expectRecordChownedByMktempName(shims);
    expect(readdirSync(targetDir).filter((name) => /^\.orbit-smtp-retirement\..{6}$/u.test(name))).toEqual([]);
  });

  it("test 3: .env-orbit.retire-smtp.tmp is never opened or chowned by that name, and the owner change is --no-dereference", () => {
    const targetDir = withMail();
    const outside = outsideFile();
    const planted = join(targetDir, REWRITE_FIXED_TMP);
    symlinkSync(outside.path, planted);
    const shims = rootShims();
    const result = runAsRoot(targetDir, shims);
    expect(result.stdout, result.stderr).toContain(DONE);
    unchanged(outside);
    expect(lstatExists(planted), "the planted link was removed: the fixed name was still used").toBe(true);
    expect(lstatSync(planted).isSymbolicLink()).toBe(true);
    expect(readlinkSync(planted)).toBe(outside.path);
    const envPath = join(targetDir, ".env-orbit");
    expect(lstatSync(envPath).isFile(), ".env-orbit is not a regular file").toBe(true);
    expect(modeOf(envPath)).toBe("600");
    const env = envOf(targetDir);
    expect(env).not.toMatch(/^SMTP_[A-Z_]+=/mu);
    expect(env).not.toMatch(/^COMPOSE_FILE=.*docker-compose\.mail\.yml/mu);
    const calls = chownCalls(shims);
    expect(calls.length, "chown was never run under a root run").toBeGreaterThan(0);
    expectNoDereference(calls);
    expect(calls.filter((call) => call.path === REWRITE_FIXED_TMP || /\.env-orbit\.retire-smtp\.tmp(\s|$)/u.test(call.line))).toEqual([]);
    const hits = calls.filter((call) => call.path !== null && REWRITE_TMP.test(call.path));
    expect(hits.length, `no chown names .env-orbit.retire-smtp.<6>:\n${shims.calls().join("\n")}`).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.exists, hit.line).toBe("yes");
    expect(readdirSync(targetDir).filter((name) => /^\.env-orbit\.retire-smtp\..{6}$/u.test(name))).toEqual([]);
  });

  it("test 4: entries planted in the dated backup folder the moment it changes owner are not written through", () => {
    const targetDir = withMail();
    const outsideDir = scratchDir("orbit-repair-fix-s1-outside-");
    const target = outsideFile(outsideDir, "target");
    const target2 = outsideFile(outsideDir, "target2");
    const shims = rootShims({ plant: { when: DATED, links: [[".env-orbit", target.path], ["docker-compose.mail.yml", target2.path]] } });
    // #1834 removes the copies once mail sending is confirmed; it is not, so they stay to be inspected.
    const result = runAsRoot(targetDir, shims, GATE_FAILS_AFTER);
    expect(result.stdout, result.stderr).toContain(DONE);
    unchanged(target);
    unchanged(target2);
    const root = join(targetDir, "orbit-install-backups");
    const dated = readdirSync(root).filter((name) => DATED.test(`orbit-install-backups/${name}`));
    expect(dated, `dated backup folders: ${readdirSync(root).join(", ")}`).toHaveLength(1);
    const datedDir = join(root, dated[0]);
    const envCopy = join(datedDir, ".env-orbit");
    const overlayCopy = join(datedDir, "docker-compose.mail.yml");
    expect(lstatSync(envCopy).isFile(), "the backed-up .env-orbit is not a regular file").toBe(true);
    expect(lstatSync(overlayCopy).isFile(), "the backed-up docker-compose.mail.yml is not a regular file").toBe(true);
    expect(envBackups(targetDir)).toContain(envCopy);
    const copied = readFileSync(envCopy, "utf8");
    expect(copied).not.toMatch(/^SMTP_PASSWORD=/mu);
    // #1834: only the lines the retirement removes, never the rest of .env-orbit.
    expect(copied).toMatch(/^SMTP_HOST=/mu);
    expect(copied).not.toContain("APP_URL=https://orbit.repair-test.internal");
    expect(readFileSync(overlayCopy, "utf8")).toBe(OVERLAY);
    expect(modeOf(datedDir)).toBe("700");
    const calls = chownCalls(shims);
    expectNoDereference(calls);
    const index = (path) => calls.findIndex((call) => call.path === path);
    const relDated = `orbit-install-backups/${dated[0]}`;
    const [copyAt, datedAt, rootAt] = [index(`${relDated}/.env-orbit`), index(relDated), index("orbit-install-backups")];
    const log = shims.calls().join("\n");
    expect(copyAt, `no chown names the backed-up .env-orbit:\n${log}`).toBeGreaterThan(-1);
    expect(datedAt, `no chown names the dated folder:\n${log}`).toBeGreaterThan(copyAt);
    expect(rootAt, `the backup root was not chowned after the dated folder:\n${log}`).toBeGreaterThan(datedAt);
  });

  it("test 5: a chown that fails on the dated folder refuses with the backup message and leaves no backup", () => {
    const targetDir = withMail();
    const envPath = join(targetDir, ".env-orbit");
    const before = readFileSync(envPath);
    const shims = rootShims({ chown: "fail-dated" });
    const result = runAsRoot(targetDir, shims);
    expect(result.stdout).not.toContain(DONE);
    expect(result.stderr).toContain("the backup of .env-orbit could not be made in orbit-install-backups");
    expect(readFileSync(envPath).equals(before), "the live .env-orbit changed").toBe(true);
    expect(modeOf(envPath)).toBe("600");
    expect(existsSync(join(targetDir, RECORD))).toBe(false);
    expect(composeUpCalls(result)).toEqual([]);
    expect(findCalls(["-path", join(targetDir, "orbit-install-backups", "*")], targetDir)).toEqual([]);
    expect(readdirSync(targetDir).filter((name) => /^\.env-orbit\.retire-smtp\..{6}$/u.test(name))).toEqual([]);
    expect(existsSync(secretPath(targetDir))).toBe(true);
  });

  // Audit v0.3.9-c sweep 2: each of the five guarded chowns, failing alone, stops the run. The rewritten copy and
  // the backups root are covered above; these are the other three.
  const BACKUP_REFUSAL = "retire-smtp-lines refused, nothing was changed: the backup of .env-orbit could not be made in orbit-install-backups";
  const DATED_COPY = /^orbit-install-backups\/\d{8}T\d{6}Z-repair(-\d)?\/\.env-orbit$/u;

  /** A failed chown stopped the run before any change to .env-orbit, the secret or the stack. */
  function expectStoppedUnchanged(targetDir, result, before, message) {
    expect(result.stdout).not.toContain(DONE);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    const envPath = join(targetDir, ".env-orbit");
    expect(readFileSync(envPath).equals(before), "the live .env-orbit changed").toBe(true);
    expect(modeOf(envPath)).toBe("600");
    expect(existsSync(secretPath(targetDir))).toBe(true);
    expect(existsSync(join(targetDir, RECORD))).toBe(false);
    expect(tempLeftovers(targetDir)).toEqual([]);
    expect(composeUpCalls(result)).toEqual([]);
  }

  it("sweep 2: a chown that fails on the dated backup folder alone stops the run with no change and no backup left", () => {
    const targetDir = withMail();
    const before = readFileSync(join(targetDir, ".env-orbit"));
    const shims = rootShims({ chown: "fail-match", failWhen: DATED });
    const result = runAsRoot(targetDir, shims);
    expectStoppedUnchanged(targetDir, result, before, BACKUP_REFUSAL);
    const calls = chownCalls(shims);
    expect(calls.filter((call) => call.path !== null && DATED.test(call.path)).length, shims.calls().join("\n")).toBeGreaterThan(0);
    // The dated folder is removed with its copies; the backups root this run made may remain, empty.
    expect(envBackups(targetDir)).toEqual([]);
    expect(findCalls(["-path", join(targetDir, "orbit-install-backups", "*")], targetDir)).toEqual([]);
  });

  it("sweep 2: a chown that fails on the backed-up .env-orbit alone stops the run with no change and no backup left", () => {
    const targetDir = withMail();
    const before = readFileSync(join(targetDir, ".env-orbit"));
    const shims = rootShims({ chown: "fail-match", failWhen: DATED_COPY });
    const result = runAsRoot(targetDir, shims);
    expectStoppedUnchanged(targetDir, result, before, BACKUP_REFUSAL);
    const calls = chownCalls(shims);
    expect(calls.filter((call) => call.path !== null && DATED_COPY.test(call.path)).length, shims.calls().join("\n")).toBeGreaterThan(0);
    // It stops at once: the dated folder and the backups root are never chowned.
    expect(calls.filter((call) => call.path !== null && (DATED.test(call.path) || call.path === "orbit-install-backups")), shims.calls().join("\n")).toEqual([]);
    expect(envBackups(targetDir)).toEqual([]);
    expect(findCalls(["-path", join(targetDir, "orbit-install-backups", "*")], targetDir)).toEqual([]);
  });

  it("sweep 2: a chown that fails on the step record alone stops the run with .env-orbit unchanged, keeping the backup it announced", () => {
    const targetDir = withMail();
    const before = readFileSync(join(targetDir, ".env-orbit"));
    const shims = rootShims({ chown: "fail-match", failWhen: RECORD_TMP });
    const result = runAsRoot(targetDir, shims);
    expectStoppedUnchanged(targetDir, result, before, "retire-smtp-lines left .env-orbit as it was: its step record could not be written");
    const calls = chownCalls(shims);
    expect(calls.filter((call) => call.path !== null && RECORD_TMP.test(call.path)).length, shims.calls().join("\n")).toBeGreaterThan(0);
    // Unlike the other four, this guard runs after the lasting backup is complete and named on stderr, and it
    // leaves that backup in place: one dated folder, mode 700, its .env-orbit without the password line.
    expect(result.stderr).toContain("retire-smtp-lines copied the lines it removes from .env-orbit (never SMTP_PASSWORD=)");
    const backups = envBackups(targetDir);
    expect(backups).toHaveLength(1);
    expect(modeOf(dirname(backups[0]))).toBe("700");
    expect(readFileSync(backups[0], "utf8")).not.toMatch(/^SMTP_PASSWORD=/mu);
    // A later run, with the record never written, adopts that marked copy (#1834 slice 4) and finishes.
    const second = runAsRoot(targetDir, rootShims());
    expect(second.stdout, second.stderr).toContain(DONE);
    expect(existsSync(secretPath(targetDir))).toBe(false);
  });

  // FIX-S1's ordering: the dated folder, and a backups root this run made, change owner only once both copies are
  // written in the dated folder. Test 5 holds either way; this one does not.
  it("sweep 2: the dated folder and a new backups root are chowned only after both copies are in the dated folder", () => {
    const targetDir = withMail();
    const shims = rootShims();
    const result = runAsRoot(targetDir, shims);
    expect(result.stdout, result.stderr).toContain(DONE);
    const contents = shims.contents();
    const log = shims.calls().join("\n");
    const dated = contents.filter((entry) => DATED.test(entry.path));
    expect(dated, `the dated folder was not chowned once:\n${log}`).toHaveLength(1);
    expect(dated[0].entries, `the dated folder changed owner before its copies were written:\n${log}`).toEqual(
      expect.arrayContaining([".env-orbit:f", "docker-compose.mail.yml:f"]),
    );
    const root = contents.filter((entry) => entry.path === "orbit-install-backups");
    expect(root, `the backups root this run made was not chowned once:\n${log}`).toHaveLength(1);
    const name = dated[0].path.slice("orbit-install-backups/".length);
    expect(root[0].entries, `the backups root changed owner before the copies were written:\n${log}`).toEqual(
      expect.arrayContaining([`${name}:d`, `${name}/.env-orbit:f`, `${name}/docker-compose.mail.yml:f`]),
    );
    const paths = contents.map((entry) => entry.path);
    expect(paths.indexOf("orbit-install-backups"), log).toBeGreaterThan(paths.indexOf(dated[0].path));
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

// FIX-S1 test 10: the contract names the link rule, beside the O-S5 owner rule it keeps.
describe("FIX-S1 (#1844): the contract says nothing is written through a symlink", () => {
  const flat = (text) => text.replace(/\s+/gu, " ");

  it("repair guarantee 59 says never through a symlink and still names the deployment folder's owner", () => {
    const guarantees = readFileSync(join(repoDir, "docs", "installer-guarantees.md"), "utf8");
    const line = guarantees.split("\n").find((entry) => entry.startsWith("59. `smtp-lines-retirable`"));
    expect(line, "guarantee 59 (smtp-lines-retirable) is not found").toBeDefined();
    expect(flat(line)).toContain("never through a symlink");
    expect(flat(line)).toContain("the deployment folder's owner");
  });

  it("the retire-smtp-lines comment block in repair.sh says the same", () => {
    const source = readFileSync(join(scriptsDir, "repair.sh"), "utf8").split("\n");
    const start = source.findIndex((entry) => /^# --- retire-smtp-lines \(#1817\)/u.test(entry));
    expect(start, "repair.sh no longer has the retire-smtp-lines heading").toBeGreaterThan(-1);
    let end = start + 1;
    while (end < source.length && source[end].startsWith("#")) end += 1;
    const block = flat(source.slice(start, end).map((entry) => entry.replace(/^#\s?/u, "")).join(" "));
    expect(block).toContain("never through a symlink");
    expect(block).toContain("the deployment folder's owner");
  });
});

// ---------------------------------------------------------------------------
// #1848 O-F1 / O-F3 / O-S1: retire-smtp-lines runs behind the restore guard and
// holds the backup/restore lock from before the rewrite to after the secret is
// deleted, as start-services and recreate-services do. Written from the
// specification (issue #1848, note 59822) alone, before the change.
//
// Helpers below are copied from repair-restore-guard.test.mjs (it exports
// none): plantJournal, holdLock, flockShim, lockProbeEnv and their path helpers.
// ---------------------------------------------------------------------------

const backupsOf = (targetDir, backupDir) => backupDir ?? join(targetDir, "backups");
const journalOf = (targetDir, backupDir) => join(backupsOf(targetDir, backupDir), ".orbit-restore", "restore.journal");
const lockOf = (targetDir, backupDir) => join(backupsOf(targetDir, backupDir), ".orbit-backup-restore.lock");
const markerOf = (targetDir) => join(targetDir, ".orbit-restore-pending");
const recordOf = (targetDir) => join(targetDir, ".orbit-smtp-retirement");
const envFor = (backupDir) => (backupDir ? { ORBIT_BACKUP_DIR: backupDir } : undefined);

function plantJournal(targetDir, backupDir) {
  mkdirSync(join(backupsOf(targetDir, backupDir), ".orbit-restore"), { recursive: true });
  writeFileSync(journalOf(targetDir, backupDir), '{"step":"half-done"}\n');
}

function freeLock(targetDir) {
  mkdirSync(join(targetDir, "backups"), { recursive: true });
  writeFileSync(lockOf(targetDir), "");
}

// Holds `flock -x` on a lock file from a background process until released.
async function holdLock(lockPath) {
  mkdirSync(join(lockPath, ".."), { recursive: true });
  // Its own process group: flock's child `sleep` inherits the locked descriptor,
  // so release kills the whole group and waits until the lock is free again.
  const holder = spawn("flock", ["-x", lockPath, "sleep", "60"], { stdio: "ignore", detached: true });
  const deadline = Date.now() + 10_000;
  while (spawnSync("flock", ["-n", lockPath, "true"]).status === 0) {
    if (Date.now() > deadline) throw new Error("the background flock never took the lock");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return () => {
    process.kill(-holder.pid, "SIGKILL");
    const freeBy = Date.now() + 10_000;
    while (spawnSync("flock", ["-n", lockPath, "true"]).status !== 0) {
      if (Date.now() > freeBy) throw new Error("the background flock never let the lock go");
      spawnSync("sleep", ["0.05"]);
    }
  };
}

// A fake `flock` ahead of the real one (for the repair child only).
function flockShim(body, code) {
  const shimDir = scratchDir("orbit-flock-shim-");
  const shim = join(shimDir, "flock");
  writeFileSync(shim, `#!/usr/bin/env bash\n${body}\nexit ${code}\n`);
  chmodSync(shim, 0o755);
  return { PATH: `${shimDir}:${process.env.PATH}` };
}

// A `printf` function injected through BASH_ENV into the fake docker wrapper
// probes the lock with a second, independent `flock -n` when `compose ... up` runs.
function lockProbeEnv(lockPath) {
  const dir = scratchDir("orbit-lock-probe-");
  const out = join(dir, "probe.log");
  const rc = join(dir, "probe.sh");
  writeFileSync(
    rc,
    `printf() {
  if [[ -n "\${S:-}" && "\${1:-}" == '%s\\n' && "\${2:-}" == compose* && " \${2} " == *" up "* ]]; then
    /usr/bin/flock -n '${lockPath}' true 2>/dev/null; case $? in 0) builtin printf 'free\\n' >> '${out}' ;; 1) builtin printf 'held\\n' >> '${out}' ;; *) builtin printf 'error\\n' >> '${out}' ;; esac
  fi
  builtin printf "$@"
}
`,
  );
  return { env: { BASH_ENV: rc }, probes: () => (existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean) : []) };
}

const REFUSED = "Orbit repair: retire-smtp-lines refused, nothing was changed: ";
const DONE_LINE = "execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done";
const FAILED_LINE = "execute action=retire-smtp-lines resolves=smtp-lines-retirable result=failed";
const LOCK_REASON = "a backup, restore or export is running right now; wait for it to end, then re-run repair.";
const CANT_CHECK = "repair can't check whether a backup, restore or export is running: the lock at";
const JOURNAL_REFUSAL = "a restore has not been finished (journal at ";
const RETIRE_OPTIONS = { ...IMPORTED };

/** Every observable of a refused retire: lines, exit code, no compose up, nothing on disk changed. */
function expectRefused(result, targetDir, before, reason) {
  expect(result.stdout).toContain(FAILED_LINE);
  expect(result.stdout).not.toContain(DONE_LINE);
  expect(result.stdout).toContain("execution result=failed done=0 failed=1");
  expect(result.status).toBe(4);
  expect(stderrLines(result).join("\n")).toContain(`${REFUSED}${reason}`);
  expect(composeUpCalls(result)).toEqual([]);
  expect(treeSnapshot(targetDir)).toBe(before);
  expect(envOf(targetDir)).toContain("SMTP_HOST=smtp.example.test");
  expect(existsSync(secretPath(targetDir))).toBe(true);
}

/** A clean second run finishes: done, the secret and the finding gone. */
function expectCleanRunFinishes(targetDir, env) {
  const second = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...MACHINE, env: { ...MACHINE.env, ...env } });
  expect(second.stdout).toContain(DONE_LINE);
  expect(second.status).toBe(0);
  expect(existsSync(secretPath(targetDir))).toBe(false);
  expect(runRepair(targetDir, ["--check"], { ...IMPORTED, env }).stdout).not.toContain("smtp-lines-retirable");
}

describe("#1848 retire-smtp-lines is refused while a restore is unfinished", () => {
  it("1: a journal planted at the confirmation prompt refuses with the restore-unfinished wording, changes nothing, exit 4", async () => {
    const targetDir = withMail();
    let before = "";
    const result = await runRepairBetweenPlanAndExecute(targetDir, ["--execute", "--safe-only"], RETIRE_OPTIONS, () => {
      plantJournal(targetDir);
      before = treeSnapshot(targetDir);
    });
    expect(result.stdout).toContain("plan action=retire-smtp-lines resolves=smtp-lines-retirable");
    expectRefused(result, targetDir, before, JOURNAL_REFUSAL);
    expect(result.stderr).toContain(`${join(".orbit-restore", "restore.journal")}); run bash scripts/restore.sh --finish once Orbit is healthy, or --recover to roll it back.`);
    expect(readFileSync(journalOf(targetDir), "utf8")).toBe('{"step":"half-done"}\n');
  });

  it("2: a .orbit-restore-pending marker planted at the prompt refuses the same way", async () => {
    const targetDir = withMail();
    const custom = scratchDir("orbit-backups-");
    let before = "";
    const result = await runRepairBetweenPlanAndExecute(targetDir, ["--execute", "--safe-only"], RETIRE_OPTIONS, () => {
      plantJournal(targetDir, custom);
      writeFileSync(markerOf(targetDir), `${journalOf(targetDir, custom)}\n`);
      before = treeSnapshot(targetDir);
    });
    expect(result.stdout).toContain("plan action=retire-smtp-lines resolves=smtp-lines-retirable");
    expectRefused(result, targetDir, before, JOURNAL_REFUSAL);
    expect(result.stderr).toContain(journalOf(targetDir, custom));
  });
});

describe("#1848 retire-smtp-lines is refused while the backup/restore lock cannot be had", () => {
  it("3 and 6: a lock held by another process refuses with the running-right-now wording; once released a second run finishes", async () => {
    const targetDir = withMail();
    const release = await holdLock(lockOf(targetDir));
    const before = treeSnapshot(targetDir);
    try {
      const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...RETIRE_OPTIONS, ...MACHINE });
      expectRefused(result, targetDir, before, LOCK_REASON);
    } finally {
      release();
    }
    expectCleanRunFinishes(targetDir);
  });

  it("3: the lock is looked for in ORBIT_BACKUP_DIR", async () => {
    const targetDir = withMail();
    const custom = scratchDir("orbit-backups-");
    const release = await holdLock(lockOf(targetDir, custom));
    const before = treeSnapshot(targetDir);
    try {
      const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...RETIRE_OPTIONS, input: "y\n", env: { ...MACHINE.env, ...envFor(custom) } });
      expectRefused(result, targetDir, before, LOCK_REASON);
    } finally {
      release();
    }
    expectCleanRunFinishes(targetDir, envFor(custom));
  });

  it("4: a lock that cannot be tested (flock exits 65) refuses with the can't-be-tested wording and changes nothing", () => {
    const targetDir = withMail();
    freeLock(targetDir);
    const before = treeSnapshot(targetDir);
    const shim = flockShim(`printf 'flock: %s: Bad file descriptor\\n' "\${@: -1}" >&2`, 65);
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...RETIRE_OPTIONS, input: "y\n", env: { ...MACHINE.env, ...shim } });
    expectRefused(result, targetDir, before, `${CANT_CHECK} ${lockOf(targetDir)} can't be tested on that filesystem (flock said: flock:`);
    expect(result.stderr).toContain("Bad file descriptor");
    expect(result.stderr).not.toContain("running right now");
  });

  it.skipIf(process.getuid?.() === 0)("5: a backups folder that cannot be searched is refused the same way and nothing changes", () => {
    const targetDir = withMail();
    const backups = join(targetDir, "backups");
    mkdirSync(backups, { mode: 0o700 });
    chmodSync(backups, 0o700);
    const before = treeSnapshot(targetDir);
    chmodSync(backups, 0o000);
    try {
      const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...RETIRE_OPTIONS, ...MACHINE });
      chmodSync(backups, 0o700);
      expectRefused(result, targetDir, before, `repair can't check whether a backup, restore or export is running: ${backups} can't be searched`);
    } finally {
      chmodSync(backups, 0o700);
    }
  });
});

describe("#1848 the resume case goes through the same guard", () => {
  it("7: a retirement interrupted at step=backed-up is refused while a journal exists, record and secret stay, and a later clean run finishes", () => {
    const targetDir = withMail();
    const crashed = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, upFails: true, ...MACHINE });
    expect(crashed.stdout).not.toContain(DONE_LINE);
    expect(existsSync(recordOf(targetDir))).toBe(true);
    expect(envOf(targetDir)).not.toMatch(/^SMTP_/mu);
    plantJournal(targetDir);
    const before = treeSnapshot(targetDir);
    const record = readFileSync(recordOf(targetDir), "utf8");
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...MACHINE });
    expect(result.stdout).toContain(FAILED_LINE);
    expect(result.stdout).toContain("execution result=failed done=0 failed=1");
    expect(result.status).toBe(4);
    expect(stderrLines(result).join("\n")).toContain(`${REFUSED}${JOURNAL_REFUSAL}`);
    expect(composeUpCalls(result)).toEqual([]);
    expect(treeSnapshot(targetDir)).toBe(before);
    expect(readFileSync(recordOf(targetDir), "utf8")).toBe(record);
    expect(existsSync(secretPath(targetDir))).toBe(true);
    rmSync(join(targetDir, "backups", ".orbit-restore"), { recursive: true });
    expectCleanRunFinishes(targetDir);
    expect(existsSync(recordOf(targetDir))).toBe(false);
  });
});

describe("#1848 the lock spans the whole retirement and is always released", () => {
  it("8: the lock is held when compose up runs (flock -n fails) and is free after the run exits", () => {
    const targetDir = withMail();
    freeLock(targetDir);
    const probe = lockProbeEnv(lockOf(targetDir));
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...RETIRE_OPTIONS, input: "y\n", env: { ...MACHINE.env, ...probe.env } });
    expect(result.stdout).toContain(DONE_LINE);
    expect(probe.probes()).toEqual(["held"]);
    expect(spawnSync("flock", ["-n", lockOf(targetDir), "true"]).status).toBe(0);
  });

  it("8: a refused run leaves the lock free too", async () => {
    const targetDir = withMail();
    const result = await runRepairBetweenPlanAndExecute(targetDir, ["--execute", "--safe-only"], RETIRE_OPTIONS, () => plantJournal(targetDir));
    expect(result.status).toBe(4);
    expect(spawnSync("flock", ["-n", lockOf(targetDir), "true"]).status).toBe(0);
  });
});

describe("#1848 a refused retirement does not stop the batch, and leaks no lock", () => {
  const permissionTrap = (targetDir) => chmodSync(join(targetDir, ".orbit-secrets", "session-secret"), 0o644);

  it("10: another safe action in the same batch still shows result=done and the run exits 4", async () => {
    const targetDir = withMail();
    permissionTrap(targetDir);
    const release = await holdLock(lockOf(targetDir));
    try {
      const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...RETIRE_OPTIONS, ...MACHINE });
      expect(result.stdout).toMatch(/^execute action=fix-permissions resolves=secret-permissions result=done$/mu);
      expect(result.stdout).toContain(FAILED_LINE);
      expect(result.stdout).toMatch(/^execution result=failed done=1 failed=1/mu);
      expect(result.status).toBe(4);
      expect(lstatSync(join(targetDir, ".orbit-secrets", "session-secret")).mode & 0o777).toBe(0o600);
    } finally {
      release();
    }
  });

  // start-services needs Orbit's database stopped; the gate needs orbit-app running (a stopped app is no finding).
  const BATCH = { db: "stopped", app: "running", mailStatus: answer("imported") };

  it("12: a start-services in the same batch after a refused retirement is not refused as held (no lock handle leaks)", async () => {
    const targetDir = withMail();
    freeLock(targetDir);
    // A refusal on retire's own checks (after the guard): the .env-orbit mode changes after the plan.
    const result = await runRepairBetweenPlanAndExecute(targetDir, ["--execute", "--safe-only"], BATCH, () => chmodSync(join(targetDir, ".env-orbit"), 0o644));
    expect(result.stdout).toContain(FAILED_LINE);
    expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=done");
    expect(result.stderr).not.toContain("running right now");
    expect(result.stderr).not.toContain("start-services refused");
    expect(spawnSync("flock", ["-n", lockOf(targetDir), "true"]).status).toBe(0);
  });

  it("12: a start-services in the same batch after a completed retirement is not refused as held", () => {
    const targetDir = withMail();
    freeLock(targetDir);
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...BATCH, ...MACHINE });
    expect(result.stdout).toContain(DONE_LINE);
    expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=done");
    expect(result.stderr).not.toContain("running right now");
    expect(result.status).toBe(0);
  });
});
