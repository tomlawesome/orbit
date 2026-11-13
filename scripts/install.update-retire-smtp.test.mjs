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

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

      it("asks for the status once, inside orbit-app, after the stack is ready", () => {
        const targetDir = withSmtpLines(installedFolder());
        const result = update(targetDir, answer);
        const asked = statusCalls(result);
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatch(/compose .*exec -T orbit-app node \/opt\/orbit\/cli\/orbit\.js mail-sending-status$/u);
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
