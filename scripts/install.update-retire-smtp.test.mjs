// scripts/install.sh --plain --update retires the SMTP_* lines once Orbit holds
// outgoing mail in its own settings (#1817). Written from the specification
// alone (issue #1817 body and its "Owner decisions (2026-11-13)"), before the
// change. The real engine runs against the fake docker; the status command is
// answered by FAKE_MAIL_SENDING_STATUS(_EXIT) and every start is traced to
// up-trace.jsonl (install-test-support.mjs).
//
// The specification:
//  - after wait_for_deployment_readiness, run `orbit mail-sending-status` once in
//    orbit-app through `compose exec -T`; the gate holds when source is
//    `imported` or `ui` and an artefact remains (SMTP_* lines, the overlay in
//    COMPOSE_FILE or the file, .orbit-secrets/smtp-password);
//  - steps in order, each idempotent: back up .env-orbit and rewrite it (no
//    SMTP_* keys, commented lines untouched, no docker-compose.mail.yml in
//    COMPOSE_FILE, mode 600); `up -d --no-build` and wait for readiness; delete
//    .orbit-secrets/smtp-password (keep the directory); print one completion line;
//  - nothing the running stack references goes before the stack stops referencing it;
//  - a missing command or a non-zero exit: do nothing, print nothing;
//  - `none`, a stopped container, an unknown command: everything as it was.
// Owner decision 2: the secret is deleted, never copied. Decision 3: the line below.
//
// #1834 slice 1 (owner decision 10a, 2026-11-14): the undo copy of .env-orbit
// holds only the lines the retirement removes or rewrites, and is removed in
// the same run once `orbit mail-sending-status` is usable again after the
// secret is gone; otherwise it is kept and named, and the next run removes it.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { makePreprovisionedDeployment, makeTarget, recognisedVolume, runInstall } from "./install-test-support.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const COMPLETION_LINE =
  "Outgoing mail: SMTP credentials were migrated to Orbit's mail settings. They were removed from .env-orbit and deleted from the secrets folder.";
const FAKE_PASSWORD = "TEST-NOT-A-REAL-PASSWORD";
const SMTP_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURITY", "SMTP_USER", "SMTP_PASSWORD", "SMTP_PASSWORD_FILE", "SMTP_FROM"];
const COMMENTED = ["# SMTP_HOST=smtp.example.test", "# SMTP_FROM=Orbit <old@example.test>"];

/** A deployment made by a real plain install, ready to be updated. */
function installedFolder() {
  const targetDir = makeTarget();
  makePreprovisionedDeployment(targetDir);
  expect(runInstall(targetDir, {}, ["--plain", "--install"]).status).toBe(0);
  return targetDir;
}

/** The pre-#1629 shape: SMTP lines, the overlay in COMPOSE_FILE, the password file (or an inline password). */
function withSmtpLines(targetDir, { inlinePassword = false } = {}) {
  const lines = [
    "COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml",
    "SMTP_HOST=smtp.example.test",
    "SMTP_PORT=587",
    "SMTP_SECURITY=starttls",
    "SMTP_USER=orbit@example.test",
    inlinePassword ? `SMTP_PASSWORD=${FAKE_PASSWORD}` : "SMTP_PASSWORD_FILE=/run/orbit-secrets/orbit-smtp-password",
    "SMTP_FROM=Orbit <orbit@example.test>",
    ...COMMENTED,
    "",
  ];
  const envPath = join(targetDir, ".env-orbit");
  writeFileSync(envPath, `${readFileSync(envPath, "utf8")}${lines.join("\n")}`, { mode: 0o600 });
  if (!inlinePassword) writeFileSync(join(targetDir, ".orbit-secrets", "smtp-password"), FAKE_PASSWORD, { mode: 0o600 });
  return targetDir;
}

/**
 * Updates `targetDir` with the status command answering `statusLine` (undefined: the command does not exist, as in an older image).
 * `stateDir` holds the fake's state (the start trace) and the installer's private state, so a test can search both.
 */
function update(targetDir, statusLine, extraEnv = {}) {
  const own = recognisedVolume("orbit");
  const stateDir = mkdtempSync(join(tmpdir(), "orbit-retire-smtp-state-"));
  const result = runInstall(
    targetDir,
    {
      FAKE_VOLUMES: own.volume,
      FAKE_PS: JSON.stringify(own.ps),
      FAKE_CONTAINER_IMAGES: JSON.stringify(own.images),
      FAKE_STATE_DIR: stateDir,
      XDG_STATE_HOME: join(stateDir, "state"),
      ...(statusLine === undefined ? {} : { FAKE_MAIL_SENDING_STATUS: statusLine }),
      ...extraEnv,
    },
    ["--plain", "--update"],
  );
  return { ...result, stateDir };
}

const line = (source, imported) => `mail-sending source=${source} imported-from-environment=${imported}`;
const envOf = (targetDir) => readFileSync(join(targetDir, ".env-orbit"), "utf8");
const secretPath = (targetDir) => join(targetDir, ".orbit-secrets", "smtp-password");
const completionLines = (result) => `${result.stdout}\n${result.stderr}`.split("\n").filter((entry) => entry.includes("Outgoing mail:"));
const statusCalls = (result) => result.calls.split("\n").filter((entry) => entry.includes("mail-sending-status"));
const upTrace = (result) =>
  readFileSync(join(result.stateDir, "up-trace.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((entry) => JSON.parse(entry));
/** Every file under `roots` that contains `text`. */
const filesContaining = (text, ...roots) =>
  spawnSync("grep", ["-rlF", "--", text, ...roots], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
/** Everything a retirement must not have touched, as one comparable string. */
const snapshot = (targetDir) =>
  spawnSync("bash", ["-c", 'find . -mindepth 1 -type f -not -path "./.orbit-files/*" -print0 | LC_ALL=C sort -z | xargs -0 sha256sum; find . -mindepth 1 -type f -printf "%p %m\\n" | LC_ALL=C sort'], {
    cwd: targetDir,
    encoding: "utf8",
  }).stdout;

describe("install.sh --plain --update: retire the SMTP lines (#1817)", () => {
  for (const [source, imported] of [["imported", true], ["ui", true], ["ui", false]]) {
    describe(`source=${source} imported-from-environment=${imported}`, () => {
      const answer = line(source, imported);

      it("removes the SMTP lines, the overlay and the secret file, and prints exactly the owner's line once", () => {
        const targetDir = withSmtpLines(installedFolder());
        const result = update(targetDir, answer);
        expect(result.status).toBe(0);
        const env = envOf(targetDir);
        for (const key of SMTP_KEYS) expect(env).not.toMatch(new RegExp(`^${key}=`, "mu"));
        expect(env).not.toMatch(/^COMPOSE_FILE=.*docker-compose\.mail\.yml/mu);
        expect(existsSync(join(targetDir, "docker-compose.mail.yml"))).toBe(false);
        expect(existsSync(secretPath(targetDir))).toBe(false);
        expect(completionLines(result)).toEqual([COMPLETION_LINE]);
      });

      it("asks for the status once before the retirement and once after the completion line, inside orbit-app, after the stack is ready", () => {
        const targetDir = withSmtpLines(installedFolder());
        const result = update(targetDir, answer);
        const asked = statusCalls(result);
        expect(asked).toHaveLength(2);
        for (const call of asked) expect(call).toMatch(/compose .*exec -T orbit-app node \/opt\/orbit\/cli\/orbit\.js mail-sending-status$/u);
        const calls = result.calls.split("\n");
        const askedAt = calls.findIndex((entry) => entry.includes("mail-sending-status"));
        const readyAt = calls.findIndex((entry) => entry.includes("exec -T orbit-db"));
        expect(readyAt).toBeGreaterThan(-1);
        expect(askedAt).toBeGreaterThan(readyAt);
      });

      it("leaves the rest of .env-orbit and the secrets folder alone, keeps mode 600, and keeps commented lines", () => {
        const targetDir = withSmtpLines(installedFolder());
        const others = readdirSync(join(targetDir, ".orbit-secrets")).filter((name) => name !== "smtp-password").sort();
        const result = update(targetDir, answer);
        expect(result.status).toBe(0);
        const env = envOf(targetDir);
        for (const commented of COMMENTED) expect(env).toContain(commented);
        expect(env).toMatch(/^COMPOSE_FILE=docker-compose\.yml$/mu);
        expect(env).toMatch(/^ORBIT_CONFIG_APPLIED_VERSION=/mu);
        expect(env).toMatch(/^VAPID_PUBLIC_KEY=/mu);
        expect((statSync(join(targetDir, ".env-orbit")).mode & 0o777).toString(8)).toBe("600");
        expect(statSync(join(targetDir, ".orbit-secrets")).isDirectory()).toBe(true);
        expect(readdirSync(join(targetDir, ".orbit-secrets")).sort()).toEqual(others);
      });

      it("restarts the stack on the rewritten file before the secret goes: the secret is still there at the last start", () => {
        const targetDir = withSmtpLines(installedFolder());
        const result = update(targetDir, answer);
        expect(result.status).toBe(0);
        const trace = upTrace(result);
        // The first start is the update's own, with the lines in place; the last is the retirement's.
        expect(trace.length).toBeGreaterThanOrEqual(2);
        expect(trace[0]).toEqual({ smtpLines: true, overlayListed: true, secretPresent: true });
        expect(trace.at(-1)).toEqual({ smtpLines: false, overlayListed: false, secretPresent: true });
        const starts = result.calls.split("\n").filter((entry) => /--env-file \.env-orbit up -d/u.test(entry));
        expect(starts.at(-1)).toMatch(/ up -d --no-build$/u);
      });
    });
  }

  it("removes an inline SMTP_PASSWORD line too, and the password is then in no file of the folder or the installer's state", () => {
    const targetDir = withSmtpLines(installedFolder(), { inlinePassword: true });
    const result = update(targetDir, line("imported", true));
    expect(result.status).toBe(0);
    expect(envOf(targetDir)).not.toMatch(/^SMTP_PASSWORD=/mu);
    expect(filesContaining(FAKE_PASSWORD, targetDir, result.stateDir)).toEqual([]);
  });

  it("deletes the password file without copying it: its content is in no file of the folder or the installer's state", () => {
    const targetDir = withSmtpLines(installedFolder());
    const result = update(targetDir, line("imported", true));
    expect(result.status).toBe(0);
    expect(filesContaining(FAKE_PASSWORD, targetDir, result.stateDir)).toEqual([]);
  });

  it("is idempotent: a second update of the retired deployment prints nothing and keeps .env-orbit and the secrets as they were", () => {
    const targetDir = withSmtpLines(installedFolder());
    expect(update(targetDir, line("imported", true)).status).toBe(0);
    expect(existsSync(secretPath(targetDir))).toBe(false);
    const envBefore = envOf(targetDir);
    const secretsBefore = readdirSync(join(targetDir, ".orbit-secrets")).sort();
    const again = update(targetDir, line("imported", true));
    expect(again.status).toBe(0);
    expect(completionLines(again)).toEqual([]);
    expect(envOf(targetDir)).toBe(envBefore);
    expect(readdirSync(join(targetDir, ".orbit-secrets")).sort()).toEqual(secretsBefore);
  });

  it("retires what is left when only the secret file remains (the lines and the overlay entry already gone)", () => {
    const targetDir = withSmtpLines(installedFolder());
    expect(update(targetDir, line("imported", true)).status).toBe(0);
    writeFileSync(secretPath(targetDir), FAKE_PASSWORD, { mode: 0o600 });
    const result = update(targetDir, line("imported", true));
    expect(result.status).toBe(0);
    expect(existsSync(secretPath(targetDir))).toBe(false);
    expect(completionLines(result)).toEqual([COMPLETION_LINE]);
  });

  it("resumes after a crash between the steps: the first run stops after the rewrite, the next removes the secret and prints the line", () => {
    const targetDir = withSmtpLines(installedFolder());
    const first = update(targetDir, line("imported", true), { FAKE_UP_FAIL_AFTER_SMTP_RETIRED: "1" });
    // Rewritten, but the stack never restarted on it: the secret is still mounted, so it must still be there, and nothing is announced.
    expect(envOf(targetDir)).not.toMatch(/^SMTP_/mu);
    expect(existsSync(secretPath(targetDir))).toBe(true);
    expect(completionLines(first)).toEqual([]);
    const second = update(targetDir, line("imported", true));
    expect(second.status).toBe(0);
    expect(existsSync(secretPath(targetDir))).toBe(false);
    expect(envOf(targetDir)).not.toMatch(/^SMTP_/mu);
    expect(completionLines(second)).toEqual([COMPLETION_LINE]);
  });

  describe("the gate: everything stays as it was", () => {
    const untouched = (statusLine, extraEnv = {}) => {
      const targetDir = withSmtpLines(installedFolder());
      const before = snapshot(targetDir);
      const result = update(targetDir, statusLine, extraEnv);
      return { targetDir, before, result };
    };

    it("source=none: no change to the lines, the overlay entry or the secret, and nothing printed", () => {
      const { targetDir, result } = untouched(line("none", false));
      expect(result.status).toBe(0);
      expect(envOf(targetDir)).toContain("SMTP_HOST=smtp.example.test");
      expect(envOf(targetDir)).toMatch(/^COMPOSE_FILE=docker-compose\.yml:docker-compose\.mail\.yml$/mu);
      expect(readFileSync(secretPath(targetDir), "utf8")).toBe(FAKE_PASSWORD);
      expect(completionLines(result)).toEqual([]);
      expect(result.calls.split("\n").filter((entry) => /up -d/u.test(entry))).toHaveLength(1);
    });

    it("a command the image does not have: nothing removed, nothing printed", () => {
      const { targetDir, result } = untouched(undefined);
      expect(result.status).toBe(0);
      expect(envOf(targetDir)).toContain("SMTP_HOST=smtp.example.test");
      expect(existsSync(secretPath(targetDir))).toBe(true);
      expect(completionLines(result)).toEqual([]);
    });

    it("a non-zero exit, even with an imported line on stdout: nothing removed, nothing printed", () => {
      const { targetDir, result } = untouched(line("imported", true), { FAKE_MAIL_SENDING_STATUS_EXIT: "1" });
      expect(result.status).toBe(0);
      expect(envOf(targetDir)).toContain("SMTP_HOST=smtp.example.test");
      expect(existsSync(secretPath(targetDir))).toBe(true);
      expect(completionLines(result)).toEqual([]);
    });

    it("an answer outside the vocabulary: nothing removed, nothing printed", () => {
      for (const odd of ["mail-sending source=imported", "mail-sending source=other imported-from-environment=true"]) {
        const { targetDir, result } = untouched(odd);
        expect(result.status, odd).toBe(0);
        expect(envOf(targetDir), odd).toContain("SMTP_HOST=smtp.example.test");
        expect(existsSync(secretPath(targetDir)), odd).toBe(true);
        expect(completionLines(result), odd).toEqual([]);
      }
    });
  });

  it("an answer over 256 bytes is cut short and treated as an odd answer: nothing removed, nothing printed", () => {
    // Trailing newlines are stripped by $(...), so only a size cap refuses the first; the second must not be accepted once cut.
    for (const odd of [`${line("imported", true)}${"\n".repeat(300)}`, `${line("imported", true)}${"\n".repeat(300)}trailing`]) {
      const targetDir = withSmtpLines(installedFolder());
      const result = update(targetDir, odd);
      expect(result.status).toBe(0);
      expect(envOf(targetDir)).toContain("SMTP_HOST=smtp.example.test");
      expect(existsSync(secretPath(targetDir))).toBe(true);
      expect(completionLines(result)).toEqual([]);
    }
  });

  describe("a deployment with nothing to retire", () => {
    it("a fresh install (no SMTP artefacts) prints nothing about mail, and an imported answer changes no byte", () => {
      const targetDir = installedFolder();
      // Settle the folder with one update, then compare the next against it.
      expect(update(targetDir, line("imported", true)).status).toBe(0);
      const before = snapshot(targetDir);
      const result = update(targetDir, line("imported", true));
      expect(result.status).toBe(0);
      expect(completionLines(result)).toEqual([]);
      expect(snapshot(targetDir)).toBe(before);
      expect(result.stdout).not.toMatch(/SMTP|Outgoing mail/u);
    });

    it("a fresh install with source=none prints nothing about mail", () => {
      const targetDir = installedFolder();
      const result = update(targetDir, line("none", false));
      expect(result.status).toBe(0);
      expect(completionLines(result)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// #1834 slice 1: the undo copy (Update).
const KEK_LINE = "DOCUMENT_KEK=TEST-NOT-A-REAL-KEK";
const OTHER_LINES = [KEK_LINE];
const RECORD = ".orbit-smtp-retirement";
const GATE_FAILS_AFTER = { FAKE_MAIL_SENDING_STATUS_AFTER_SECRET_GONE: line("none", false) };
const backupsRoot = (targetDir) => join(targetDir, "orbit-install-backups");
/** The .env-orbit copies under orbit-install-backups. */
const undoCopies = (targetDir) =>
  spawnSync("find", [backupsRoot(targetDir), "-type", "f", "-name", ".env-orbit*"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
const backupFolders = (targetDir) => (existsSync(backupsRoot(targetDir)) ? readdirSync(backupsRoot(targetDir)).sort() : []);
const SMTP_LINE = /^(SMTP_(HOST|PORT|SECURITY|USER|PASSWORD_FILE|FROM)=|COMPOSE_FILE=.*docker-compose\.mail\.yml)/u;
/** A deployment with the SMTP lines and the password file, plus an inline DOCUMENT_KEK that no copy may hold. */
function withSmtpAndOtherSecrets(targetDir) {
  withSmtpLines(targetDir);
  appendFileSync(join(targetDir, ".env-orbit"), `${KEK_LINE}\n`);
  return targetDir;
}

describe("install.sh --plain --update: the SMTP undo copy (#1834 slice 1)", () => {
  it("the kept copy holds only the lines the retirement removes or rewrites: never DOCUMENT_KEK or any other line", () => {
    const targetDir = withSmtpAndOtherSecrets(installedFolder());
    const expected = envOf(targetDir).split("\n").filter((entry) => SMTP_LINE.test(entry));
    expect(expected.length).toBeGreaterThanOrEqual(7);
    const result = update(targetDir, line("imported", true), GATE_FAILS_AFTER);
    expect(result.status).toBe(0);
    const copies = undoCopies(targetDir);
    expect(copies).toHaveLength(1);
    const text = readFileSync(copies[0], "utf8");
    expect(text.split("\n").filter(Boolean)).toEqual(expected);
    expect(text).toContain("COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml");
    expect(text).not.toMatch(/^SMTP_PASSWORD=/mu);
    expect(text).not.toContain("DOCUMENT_KEK");
    for (const other of OTHER_LINES) expect(text).not.toContain(other);
    expect(text).not.toContain("#");
    expect(filesContaining(FAKE_PASSWORD, backupsRoot(targetDir))).toEqual([]);
    expect(filesContaining("TEST-NOT-A-REAL-KEK", backupsRoot(targetDir))).toEqual([]);
  });

  it("the kept copy has mode 600 in a folder with mode 700", () => {
    const targetDir = withSmtpLines(installedFolder());
    expect(update(targetDir, line("imported", true), GATE_FAILS_AFTER).status).toBe(0);
    const [copy] = undoCopies(targetDir);
    expect(copy).toBeDefined();
    expect((statSync(copy).mode & 0o777).toString(8)).toBe("600");
    expect((statSync(dirname(copy)).mode & 0o777).toString(8)).toBe("700");
  });

  it("mail sending usable after the retirement: the copy, its folder and the step record are gone in the same run", () => {
    const targetDir = withSmtpAndOtherSecrets(installedFolder());
    const result = update(targetDir, line("imported", true));
    expect(result.status).toBe(0);
    expect(completionLines(result)).toEqual([COMPLETION_LINE]);
    expect(undoCopies(targetDir)).toEqual([]);
    expect(backupFolders(targetDir).filter((name) => name !== "")).toEqual([]);
    expect(existsSync(join(targetDir, RECORD))).toBe(false);
    expect(existsSync(secretPath(targetDir))).toBe(false);
    expect(filesContaining("TEST-NOT-A-REAL-KEK", backupsRoot(targetDir))).toEqual([]);
  });

  it("asks for the status a second time, after the secret is deleted and the completion line is printed", () => {
    const targetDir = withSmtpLines(installedFolder());
    const result = update(targetDir, line("imported", true));
    expect(statusCalls(result)).toHaveLength(2);
  });

  it("mail sending not confirmed afterwards: the copy is kept, one line names its path and says why, the run still finishes", () => {
    const targetDir = withSmtpLines(installedFolder());
    const result = update(targetDir, line("imported", true), GATE_FAILS_AFTER);
    expect(result.status).toBe(0);
    expect(completionLines(result)).toEqual([COMPLETION_LINE]);
    expect(existsSync(secretPath(targetDir))).toBe(false);
    const [copy] = undoCopies(targetDir);
    expect(copy).toBeDefined();
    const naming = `${result.stdout}\n${result.stderr}`.split("\n").filter((entry) => entry.includes(copy));
    expect(naming).toHaveLength(1);
    expect(naming[0]).toMatch(/kept/iu);
    expect(naming[0]).toMatch(/mail sending/iu);
    expect(naming[0]).toMatch(/confirm/iu);
    expect(existsSync(join(targetDir, RECORD))).toBe(true);
  });

  it("a status command that fails afterwards (non-zero exit) also keeps the copy", () => {
    const targetDir = withSmtpLines(installedFolder());
    // The first answer is good; once the secret is gone the command answers nothing usable.
    const result = update(targetDir, line("imported", true), { FAKE_MAIL_SENDING_STATUS_AFTER_SECRET_GONE: "mail-sending source=imported" });
    expect(result.status).toBe(0);
    expect(undoCopies(targetDir)).toHaveLength(1);
  });

  it("interrupted run: the next run removes the kept copy and the record once the gate holds, and makes no new copy", () => {
    const targetDir = withSmtpAndOtherSecrets(installedFolder());
    expect(update(targetDir, line("imported", true), GATE_FAILS_AFTER).status).toBe(0);
    expect(undoCopies(targetDir)).toHaveLength(1);
    expect(existsSync(join(targetDir, RECORD))).toBe(true);
    const foldersBefore = backupFolders(targetDir);
    const second = update(targetDir, line("imported", true));
    expect(second.status).toBe(0);
    expect(undoCopies(targetDir)).toEqual([]);
    expect(existsSync(join(targetDir, RECORD))).toBe(false);
    // Nothing new was made: every folder now is one that was there before.
    for (const name of backupFolders(targetDir)) expect(foldersBefore).toContain(name);
    expect(filesContaining("TEST-NOT-A-REAL-KEK", backupsRoot(targetDir))).toEqual([]);
  });

  it("interrupted run, gate still not holding: the next run keeps the copy and the record", () => {
    const targetDir = withSmtpLines(installedFolder());
    expect(update(targetDir, line("imported", true), GATE_FAILS_AFTER).status).toBe(0);
    const [copy] = undoCopies(targetDir);
    const second = update(targetDir, line("none", false));
    expect(second.status).toBe(0);
    expect(undoCopies(targetDir)).toEqual([copy]);
    expect(existsSync(join(targetDir, RECORD))).toBe(true);
  });

  it("a folder that holds anything else is left in place; only the copy the retirement wrote goes", () => {
    const targetDir = withSmtpLines(installedFolder());
    expect(update(targetDir, line("imported", true), GATE_FAILS_AFTER).status).toBe(0);
    const [copy] = undoCopies(targetDir);
    const other = join(dirname(copy), "other-file.txt");
    writeFileSync(other, "left by another run\n");
    const second = update(targetDir, line("imported", true));
    expect(second.status).toBe(0);
    expect(existsSync(copy)).toBe(false);
    expect(readFileSync(other, "utf8")).toBe("left by another run\n");
    expect(existsSync(dirname(copy))).toBe(true);
    expect(existsSync(join(targetDir, RECORD))).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// #1834 slice 4: a run killed around the undo copy, and what is never touched.
//
// A PATH shim for awk stands in for SIGKILL at the one point that matters: the
// copy is made by `smtp_env_rewrite backup` (awk -v mode=backup). "after":
// the copy is written in full, then install.sh is killed before the
// `backed-up` record. "before": install.sh is killed as the copy is opened,
// leaving it empty. Every other awk call passes straight through.
const REAL_AWK = spawnSync("bash", ["-c", "command -v awk"], { encoding: "utf8" }).stdout.trim();
function killingAwk(when) {
  const dir = mkdtempSync(join(tmpdir(), "orbit-kill-awk-"));
  const script = `#!/usr/bin/env bash
backup=0
for argument in "$@"; do [[ "$argument" == mode=backup ]] && backup=1; done
kill_installer() {
  local pid=$PPID ppid rest
  local -a pids=()
  while ((pid > 1)) && tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'scripts/install\\.sh'; do
    pids=("$pid" "\${pids[@]}")
    read -r _ _ _ ppid rest < "/proc/$pid/stat" || break
    pid=$ppid
  done
  ((\${#pids[@]} > 0)) && kill -KILL "\${pids[@]}"
}
if [[ "$backup" == 1 && "${when}" == before ]]; then kill_installer; exit 1; fi
${REAL_AWK} "$@"
status=$?
if [[ "$backup" == 1 && "${when}" == after ]]; then kill_installer; fi
exit $status
`;
  writeFileSync(join(dir, "awk"), script, { mode: 0o755 });
  return dir;
}
/** Runs one update with the killing awk first on PATH (behind the fake docker). */
function killedUpdate(targetDir, when) {
  const saved = process.env.PATH;
  process.env.PATH = `${killingAwk(when)}:${saved}`;
  try {
    return update(targetDir, line("imported", true));
  } finally {
    process.env.PATH = saved;
  }
}
/** The lines a full undo copy of this .env-orbit holds. */
const smtpLinesOf = (text) => text.split("\n").filter((entry) => SMTP_LINE.test(entry));

describe("install.sh --plain --update: an SMTP undo copy left by a killed run (#1834 slice 4)", () => {
  it("killed after the copy, before the record: the next run adopts that copy, makes no second one, and removes it once mail sending is confirmed", () => {
    const targetDir = withSmtpAndOtherSecrets(installedFolder());
    const killed = killedUpdate(targetDir, "after");
    expect(killed.signal).toBe("SIGKILL");
    // The state a kill there leaves: a full copy and no record.
    expect(undoCopies(targetDir)).toHaveLength(1);
    expect(existsSync(join(targetDir, RECORD))).toBe(false);

    const next = update(targetDir, line("imported", true));
    expect(next.status).toBe(0);
    expect(completionLines(next)).toEqual([COMPLETION_LINE]);
    expect(undoCopies(targetDir)).toEqual([]);
    expect(existsSync(join(targetDir, RECORD))).toBe(false);
    expect(filesContaining("TEST-NOT-A-REAL-KEK", backupsRoot(targetDir))).toEqual([]);
  });

  it("killed after the copy, before the record, and mail sending not confirmed next time: exactly one copy, the full one, named once", () => {
    const targetDir = withSmtpLines(installedFolder());
    const expected = smtpLinesOf(envOf(targetDir));
    expect(killedUpdate(targetDir, "after").signal).toBe("SIGKILL");

    const next = update(targetDir, line("imported", true), GATE_FAILS_AFTER);
    expect(next.status).toBe(0);
    const copies = undoCopies(targetDir);
    expect(copies).toHaveLength(1);
    expect(smtpLinesOf(readFileSync(copies[0], "utf8"))).toEqual(expected);
    expect(`${next.stdout}\n${next.stderr}`.split("\n").filter((entry) => entry.includes(copies[0]))).toHaveLength(1);
    expect(existsSync(join(targetDir, RECORD))).toBe(true);
  });

  it("killed as the copy is being written: the next run leaves exactly one copy, and it holds every SMTP line", () => {
    const targetDir = withSmtpLines(installedFolder());
    const expected = smtpLinesOf(envOf(targetDir));
    expect(killedUpdate(targetDir, "before").signal).toBe("SIGKILL");
    // Nothing was rewritten yet.
    expect(smtpLinesOf(envOf(targetDir))).toEqual(expected);

    const next = update(targetDir, line("imported", true), GATE_FAILS_AFTER);
    expect(next.status).toBe(0);
    const copies = undoCopies(targetDir);
    expect(copies).toHaveLength(1);
    expect(smtpLinesOf(readFileSync(copies[0], "utf8"))).toEqual(expected);
  });

  it("never touched: earlier moved/, engine/ and originals/, the operator's recovery bundle and a backup.sh archive, through a kill and a completed retirement", () => {
    const targetDir = withSmtpLines(installedFolder());
    const old = join(backupsRoot(targetDir), "20200101T000000Z");
    for (const sub of ["moved", "engine", "originals"]) {
      mkdirSync(join(old, sub), { recursive: true, mode: 0o700 });
      writeFileSync(join(old, sub, `${sub}.txt`), `kept ${sub}\n`, { mode: 0o600 });
    }
    // A dated folder holding nothing but an .env-orbit, written by hand: not this run's copy.
    const handMade = join(backupsRoot(targetDir), "20200102T000000Z");
    mkdirSync(handMade, { mode: 0o700 });
    writeFileSync(join(handMade, ".env-orbit"), "SMTP_HOST=hand-kept.example.test\n", { mode: 0o600 });
    writeFileSync(join(targetDir, "orbit-recovery-20200101T000000Z.tar"), "recovery bundle\n", { mode: 0o600 });
    writeFileSync(join(targetDir, "orbit-backup-20200101T000000Z.tar"), "backup archive\n", { mode: 0o600 });
    const kept = () =>
      spawnSync("bash", ["-c", 'find orbit-install-backups/20200101T000000Z orbit-install-backups/20200102T000000Z orbit-recovery-20200101T000000Z.tar orbit-backup-20200101T000000Z.tar -print0 | LC_ALL=C sort -z | xargs -0 stat -c "%n %a %s" ; cat orbit-install-backups/*/moved/* orbit-install-backups/*/engine/* orbit-install-backups/*/originals/* orbit-install-backups/20200102T000000Z/.env-orbit *.tar'], {
        cwd: targetDir,
        encoding: "utf8",
      }).stdout;
    const before = kept();
    expect(before).toContain("hand-kept.example.test");

    expect(killedUpdate(targetDir, "after").signal).toBe("SIGKILL");
    expect(kept()).toBe(before);
    const next = update(targetDir, line("imported", true));
    expect(next.status).toBe(0);
    expect(completionLines(next)).toEqual([COMPLETION_LINE]);
    expect(kept()).toBe(before);
  });
});

// Review of a7aa25e5 (#1834 slice 4): adopting a killed run's copy rewrites it, and that rewrite
// must never write through a hard link into another file.
describe("install.sh --plain --update: adopting a killed run's SMTP copy never writes through a hard link (#1834 slice 4 review)", () => {
  for (const [label, statusAfter] of [["mail sending confirmed", {}], ["mail sending not confirmed", GATE_FAILS_AFTER]]) {
    it(`the marked folder's .env-orbit is a hard link to another file: that file is unchanged after the run (${label})`, () => {
      const targetDir = withSmtpLines(installedFolder());
      expect(killedUpdate(targetDir, "after").signal).toBe("SIGKILL");
      const [copy] = undoCopies(targetDir);
      expect(copy).toBeDefined();
      // Another file on the same filesystem, outside the backups folder.
      const victim = join(targetDir, "operator-notes.txt");
      writeFileSync(victim, "the operator's own notes\n", { mode: 0o600 });
      rmSync(copy);
      linkSync(victim, copy);
      expect(statSync(victim).nlink).toBe(2);

      const next = update(targetDir, line("imported", true), statusAfter);
      expect(next.status).toBe(0);
      expect(readFileSync(victim, "utf8")).toBe("the operator's own notes\n");
    });
  }
});
