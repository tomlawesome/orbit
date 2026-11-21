// #1848 FR-S1b points 3 and 4, written from the posted specification alone.
//  - The old-undo-copy prune (undo_copy_folder_qualifies) also accepts regular files named .env-orbit.smtp-copy.<6 of
//    [A-Za-z0-9]> and docker-compose.mail.yml.smtp-copy.<6 of the same>: temporary files a killed repair left.
//  - install.sh's smtp_discard_copy removes those names too, so an update that confirms a retirement repair started
//    removes the folder.
//  - Unchanged: any other name (the old .tmp names included), a sub-folder, a link or any other file still makes a folder
//    "not removed".
// Harness as in install.update-prune-undo-copies.test.mjs (same names, copied: that file exports nothing).

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";
import { baseEnvironment, installScript, makeFakeBin, makePreprovisionedDeployment, makeTarget, recognisedVolume, runInstallOnTerminal } from "./install-test-support.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS * 2 });

const ENV_FORM = "ORBIT_REMOVE_OLD_UNDO_COPIES";
const COPY = "SMTP_HOST=smtp.example.test\n";
const ENV_LEFTOVER = ".env-orbit.smtp-copy.Ab12Cd";
const OVERLAY_LEFTOVER = "docker-compose.mail.yml.smtp-copy.Ab12Cd";
const MARKER = ".orbit-smtp-undo";

function runDetached(targetDir, envOverrides = {}, args = []) {
  const binDir = makeFakeBin();
  const logDir = mkdtempSync(join(tmpdir(), "orbit-install-log-"));
  return failOnProcessDeadline(
    spawnSync("setsid", ["-w", "bash", installScript, ...args], { cwd: targetDir, encoding: "utf8", env: { ...baseEnvironment(binDir, logDir), ...envOverrides }, ...processGuard() }),
    { label: "runDetached" },
  );
}
const backups = (targetDir) => join(targetDir, "orbit-install-backups");
const writeFolder = (dir, files) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, { mode: 0o600 });
};
function installedFolder() {
  const targetDir = makeTarget();
  makePreprovisionedDeployment(targetDir);
  expect(runDetached(targetDir, {}, ["--plain", "--install"]).status).toBe(0);
  return targetDir;
}
const updateEnv = (extra = {}) => {
  const own = recognisedVolume("orbit");
  return { FAKE_VOLUMES: own.volume, FAKE_PS: JSON.stringify(own.ps), FAKE_CONTAINER_IMAGES: JSON.stringify(own.images), ...extra };
};
const update = (targetDir, extra = {}, args = []) => runDetached(targetDir, updateEnv(extra), ["--plain", "--update", ...args]);
const updateOnTerminal = (targetDir, answer) => runInstallOnTerminal(targetDir, updateEnv(), [{ after: "CANNOT", input: answer }], ["--plain", "--update"]);
const lines = (text) => text.replace(/\r/gu, "").split("\n");
const mentioning = (text, name) => lines(text).filter((entry) => entry.includes(`orbit-install-backups/${name}`));
const notRemoved = (text, name) => mentioning(text, name).some((entry) => /not removed/iu.test(entry));
const removedLine = (text, name) => mentioning(text, name).some((entry) => /removed/iu.test(entry) && !/not removed/iu.test(entry));

const FOLDER = "20250102T030405Z-repair";

describe("FR-S1b (#1848) install.sh prune: temporary files a killed repair left in an old undo folder", () => {
  for (const [label, files] of [
    ["the .env-orbit copy's temporary file", { ".env-orbit": COPY, [MARKER]: `copy=orbit-install-backups/${FOLDER}\n`, [ENV_LEFTOVER]: COPY }],
    ["the overlay copy's temporary file", { ".env-orbit": COPY, [OVERLAY_LEFTOVER]: "services: {}\n" }],
    ["both temporary files and the overlay", { ".env-orbit": COPY, "docker-compose.mail.yml": "services: {}\n", [ENV_LEFTOVER]: COPY, [OVERLAY_LEFTOVER]: "services: {}\n" }],
  ]) {
    it(`${label}: the folder is offered, and removed on an exact "yes"`, async () => {
      const targetDir = installedFolder();
      writeFolder(join(backups(targetDir), FOLDER), files);
      const result = await updateOnTerminal(targetDir, "yes\r");
      expect(result.status).toBe(0);
      const output = result.stdout.replace(/\r/gu, "");
      expect(notRemoved(output, FOLDER), mentioning(output, FOLDER).join(" | ")).toBe(false);
      expect(mentioning(output, FOLDER), "the folder is listed").not.toEqual([]);
      expect(removedLine(output, FOLDER)).toBe(true);
      expect(existsSync(join(backups(targetDir), FOLDER))).toBe(false);
    });
  }

  it(`${ENV_FORM}=yes removes it without a terminal; without it, it is listed and kept`, () => {
    const targetDir = installedFolder();
    writeFolder(join(backups(targetDir), FOLDER), { ".env-orbit": COPY, [MARKER]: `copy=orbit-install-backups/${FOLDER}\n`, [ENV_LEFTOVER]: COPY });
    const listed = update(targetDir);
    expect(mentioning(listed.stderr, FOLDER), "listed").not.toEqual([]);
    expect(notRemoved(listed.stderr, FOLDER)).toBe(false);
    expect(existsSync(join(backups(targetDir), FOLDER, ENV_LEFTOVER))).toBe(true);
    const removed = update(targetDir, { [ENV_FORM]: "yes" });
    expect(removed.status).toBe(0);
    expect(existsSync(join(backups(targetDir), FOLDER))).toBe(false);
  });

  for (const name of [ENV_LEFTOVER, OVERLAY_LEFTOVER]) {
    it(`a symlink named ${name} makes the folder "not removed", and the link and its target stay`, () => {
      const targetDir = installedFolder();
      const target = join(mkdtempSync(join(tmpdir(), "orbit-1848-target-")), "target");
      writeFileSync(target, "KEEP\n");
      const folder = join(backups(targetDir), FOLDER);
      writeFolder(folder, { ".env-orbit": COPY });
      symlinkSync(target, join(folder, name));
      const result = update(targetDir, { [ENV_FORM]: "yes" });
      expect(notRemoved(result.stderr, FOLDER), mentioning(result.stderr, FOLDER).join(" | ")).toBe(true);
      expect(existsSync(folder)).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("KEEP\n");
    });
  }

  it("a sub-folder named like a leftover makes the folder not removed", () => {
    const targetDir = installedFolder();
    const folder = join(backups(targetDir), FOLDER);
    writeFolder(folder, { ".env-orbit": COPY });
    mkdirSync(join(folder, ENV_LEFTOVER));
    const result = update(targetDir, { [ENV_FORM]: "yes" });
    expect(notRemoved(result.stderr, FOLDER)).toBe(true);
    expect(existsSync(folder)).toBe(true);
  });

  for (const name of [".env-orbit.smtp-copy.Ab12C", ".env-orbit.smtp-copy.Ab12Cde", ".env-orbit.smtp-copy.Ab-2Cd", "docker-compose.mail.yml.smtp-copy.Ab12C", "docker-compose.mail.yml.smtp-copy.Ab12Cde", "docker-compose.mail.yml.smtp-copy.Ab_2Cd", "notes.txt"]) {
    it(`a file named ${name} (not exactly 6 characters of [A-Za-z0-9], or another name) keeps the folder "not removed"`, () => {
      const targetDir = installedFolder();
      const folder = join(backups(targetDir), FOLDER);
      writeFolder(folder, { ".env-orbit": COPY, [name]: "mine\n" });
      const result = update(targetDir, { [ENV_FORM]: "yes" });
      expect(notRemoved(result.stderr, FOLDER), mentioning(result.stderr, FOLDER).join(" | ")).toBe(true);
      expect(readFileSync(join(folder, name), "utf8")).toBe("mine\n");
    });
  }

  it("the old fixed .env-orbit.smtp-copy.tmp is still accepted", () => {
    const targetDir = installedFolder();
    writeFolder(join(backups(targetDir), FOLDER), { ".env-orbit.smtp-copy.tmp": COPY });
    const result = update(targetDir, { [ENV_FORM]: "yes" });
    expect(existsSync(join(backups(targetDir), FOLDER))).toBe(false);
    expect(notRemoved(result.stderr, FOLDER)).toBe(false);
  });
});

describe("FR-S1b (#1848) install.sh smtp_discard_copy: an update that confirms a retirement repair started", () => {
  const withSmtpLines = (targetDir) => {
    const envPath = join(targetDir, ".env-orbit");
    const block = ["COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml", "SMTP_HOST=smtp.example.test", "SMTP_PORT=587", "SMTP_SECURITY=starttls", "SMTP_USER=orbit@example.test", "SMTP_PASSWORD_FILE=/run/orbit-secrets/orbit-smtp-password", "SMTP_FROM=Orbit <orbit@example.test>", ""];
    writeFileSync(envPath, `${readFileSync(envPath, "utf8")}${block.join("\n")}`, { mode: 0o600 });
    writeFileSync(join(targetDir, ".orbit-secrets", "smtp-password"), "TEST-NOT-A-REAL-PASSWORD", { mode: 0o600 });
  };
  const IMPORTED = "mail-sending source=imported imported-from-environment=true";
  const NONE = "mail-sending source=none imported-from-environment=false";

  it("removes repair's leftovers and the folder once mail sending is confirmed", () => {
    const targetDir = installedFolder();
    withSmtpLines(targetDir);
    // Run 1: the retirement runs but is not confirmed, so the copy and the step record stay.
    const first = update(targetDir, { FAKE_MAIL_SENDING_STATUS: IMPORTED, FAKE_MAIL_SENDING_STATUS_AFTER_SECRET_GONE: NONE });
    expect(first.status).toBe(0);
    const record = readFileSync(join(targetDir, ".orbit-smtp-retirement"), "utf8");
    const copy = record.match(/^copy=(orbit-install-backups\/\S+)$/mu)?.[1];
    expect(copy, record).toBeDefined();
    // A repair run killed mid-write left its temporary files in that folder.
    writeFileSync(join(targetDir, copy, ENV_LEFTOVER), COPY, { mode: 0o600 });
    writeFileSync(join(targetDir, copy, OVERLAY_LEFTOVER), "services: {}\n", { mode: 0o600 });
    // Run 2: the gate holds, so the retirement is confirmed.
    const second = update(targetDir, { FAKE_MAIL_SENDING_STATUS: IMPORTED });
    expect(second.status).toBe(0);
    expect(existsSync(join(targetDir, ".orbit-smtp-retirement"))).toBe(false);
    expect(existsSync(join(targetDir, copy, ENV_LEFTOVER)), "the .env-orbit leftover").toBe(false);
    expect(existsSync(join(targetDir, copy, OVERLAY_LEFTOVER)), "the overlay leftover").toBe(false);
    expect(existsSync(join(targetDir, copy)), "the folder").toBe(false);
  });
});

// #1874 O-F7: repair.sh also writes a temporary file for the copy marker (marker name + ".??????"), and
// smtp_discard_copy removes it; the prune's allowlist must accept it too.
const MARKER_LEFTOVER = `${MARKER}.Ab12Cd`;

describe("#1874 O-F7 install.sh prune: the copy marker's temporary file qualifies", () => {
  for (const [label, files] of [
    ["only the marker's temporary file with .env-orbit", { ".env-orbit": COPY, [MARKER_LEFTOVER]: `copy=orbit-install-backups/${FOLDER}\n` }],
    ["the marker and every temporary name", { ".env-orbit": COPY, [MARKER]: `copy=orbit-install-backups/${FOLDER}\n`, [MARKER_LEFTOVER]: "x\n", [ENV_LEFTOVER]: COPY, [OVERLAY_LEFTOVER]: "services: {}\n" }],
  ]) {
    it(`${label}: the folder is not "not removed", and ${ENV_FORM}=yes removes it`, () => {
      const targetDir = installedFolder();
      writeFolder(join(backups(targetDir), FOLDER), files);
      const listed = update(targetDir);
      expect(mentioning(listed.stderr, FOLDER), "listed").not.toEqual([]);
      expect(notRemoved(listed.stderr, FOLDER), mentioning(listed.stderr, FOLDER).join(" | ")).toBe(false);
      const removed = update(targetDir, { [ENV_FORM]: "yes" });
      expect(removed.status).toBe(0);
      expect(existsSync(join(backups(targetDir), FOLDER))).toBe(false);
    });
  }

  it("a symlink named like the marker's temporary file still makes the folder not removed", () => {
    const targetDir = installedFolder();
    const folder = join(backups(targetDir), FOLDER);
    writeFolder(folder, { ".env-orbit": COPY });
    const target = join(mkdtempSync(join(tmpdir(), "orbit-1874-target-")), "target");
    writeFileSync(target, "KEEP\n");
    symlinkSync(target, join(folder, MARKER_LEFTOVER));
    const result = update(targetDir, { [ENV_FORM]: "yes" });
    expect(notRemoved(result.stderr, FOLDER)).toBe(true);
    expect(existsSync(folder)).toBe(true);
  });

  it("a marker-named file with a 5-character suffix keeps the folder not removed", () => {
    const targetDir = installedFolder();
    writeFolder(join(backups(targetDir), FOLDER), { ".env-orbit": COPY, [`${MARKER}.Ab12C`]: "mine\n" });
    const result = update(targetDir, { [ENV_FORM]: "yes" });
    expect(notRemoved(result.stderr, FOLDER)).toBe(true);
  });
});

// #1874 O-R2: Ctrl-C at the undo-copy prompt must leave the terminal with echo on.
describe("#1874 O-R2 install.sh prune: Ctrl-C at the undo-copy prompt", () => {
  it("restores echo on the terminal", async () => {
    const targetDir = installedFolder();
    writeFolder(join(backups(targetDir), FOLDER), { ".env-orbit": COPY });
    const binDir = makeFakeBin();
    const logDir = mkdtempSync(join(tmpdir(), "orbit-install-log-"));
    const env = { ...baseEnvironment(binDir, logDir), ...updateEnv() };
    const command = `trap : INT; bash ${installScript} --plain --update; printf '\\nSTTY-BEGIN\\n'; stty -a; printf 'STTY-END\\n'`;
    const output = await new Promise((resolve, reject) => {
      const child = spawn("script", ["-qeE", "never", "-c", command, "/dev/null"], { cwd: targetDir, env });
      let stdout = "";
      let sent = false;
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timed out; output so far: ${stdout}`)); }, PROCESS_TEST_TIMEOUT_MS);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (!sent && stdout.includes("CANNOT")) {
          sent = true;
          child.stdin.write("\x03");
        }
      });
      child.on("error", reject);
      child.on("close", () => { clearTimeout(timer); resolve(stdout); });
    });
    const settings = output.replace(/\r/gu, "").split("STTY-BEGIN\n")[1]?.split("STTY-END")[0] ?? "";
    expect(settings, `no stty output in: ${output}`).not.toBe("");
    const flags = settings.split(/[\s;]+/u);
    expect(flags, settings).not.toContain("-echo");
    expect(flags, settings).toContain("echo");
  });
});

// Same prompt, but stdin is not the terminal: the stty state must be saved from /dev/tty, not stdin.
describe("#1874 install.sh prune: Ctrl-C at the undo-copy prompt with stdin redirected", () => {
  it("restores echo on /dev/tty when stdin is /dev/null", async () => {
    const targetDir = installedFolder();
    writeFolder(join(backups(targetDir), FOLDER), { ".env-orbit": COPY });
    const binDir = makeFakeBin();
    const logDir = mkdtempSync(join(tmpdir(), "orbit-install-log-"));
    const env = { ...baseEnvironment(binDir, logDir), ...updateEnv() };
    const command = `trap : INT; bash ${installScript} --plain --update </dev/null; printf '\\nSTTY-BEGIN\\n'; stty -a; printf 'STTY-END\\n'`;
    const output = await new Promise((resolve, reject) => {
      const child = spawn("script", ["-qeE", "never", "-c", command, "/dev/null"], { cwd: targetDir, env });
      let stdout = "";
      let sent = false;
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timed out; output so far: ${stdout}`)); }, PROCESS_TEST_TIMEOUT_MS);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (!sent && stdout.includes("CANNOT")) {
          sent = true;
          child.stdin.write("\x03");
        }
      });
      child.on("error", reject);
      child.on("close", () => { clearTimeout(timer); resolve(stdout); });
    });
    const settings = output.replace(/\r/gu, "").split("STTY-BEGIN\n")[1]?.split("STTY-END")[0] ?? "";
    expect(settings, `no stty output in: ${output}`).not.toBe("");
    const flags = settings.split(/[\s;]+/u);
    expect(flags, settings).not.toContain("-echo");
    expect(flags, settings).toContain("echo");
  });
});

// #1915 O-F1: smtp_discard_copy removes exactly the names the prune's qualifier accepts; a wider glob would also
// take these near-miss names, which must survive (and keep the folder).
describe("#1915 O-F1 install.sh smtp_discard_copy: near-miss names are kept", () => {
  it("a confirmed retirement removes the exact leftovers but not names with 5 or 7 characters, a non-alphanumeric suffix or another prefix", () => {
    const targetDir = installedFolder();
    const envBlock = ["COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml", "SMTP_HOST=smtp.example.test", "SMTP_PORT=587", "SMTP_SECURITY=starttls", "SMTP_USER=orbit@example.test", "SMTP_PASSWORD_FILE=/run/orbit-secrets/orbit-smtp-password", "SMTP_FROM=Orbit <orbit@example.test>", ""];
    const envPath = join(targetDir, ".env-orbit");
    writeFileSync(envPath, `${readFileSync(envPath, "utf8")}${envBlock.join("\n")}`, { mode: 0o600 });
    writeFileSync(join(targetDir, ".orbit-secrets", "smtp-password"), "TEST-NOT-A-REAL-PASSWORD", { mode: 0o600 });
    const IMPORTED = "mail-sending source=imported imported-from-environment=true";
    const NONE = "mail-sending source=none imported-from-environment=false";
    expect(update(targetDir, { FAKE_MAIL_SENDING_STATUS: IMPORTED, FAKE_MAIL_SENDING_STATUS_AFTER_SECRET_GONE: NONE }).status).toBe(0);
    const record = readFileSync(join(targetDir, ".orbit-smtp-retirement"), "utf8");
    const copy = record.match(/^copy=(orbit-install-backups\/\S+)$/mu)?.[1];
    expect(copy, record).toBeDefined();
    const exact = [ENV_LEFTOVER, OVERLAY_LEFTOVER, `${MARKER}.Ab12Cd`];
    const nearMisses = [".env-orbit.smtp-copy.Ab12C", ".env-orbit.smtp-copy.Ab12Cde", ".env-orbit.smtp-copy.Ab-2Cd", "docker-compose.mail.yml.smtp-copy.Ab12C", "docker-compose.mail.yml.smtp-copy.Ab12Cde", "docker-compose.mail.yml.smtp-copy.Ab_2Cd", `${MARKER}.Ab12C`, `${MARKER}.Ab12Cde`, `${MARKER}.Ab-2Cd`, ".env-orbit.smtp-copy.tmp.bak", ".env-orbit.other.Ab12Cd"];
    for (const name of [...exact, ...nearMisses]) writeFileSync(join(targetDir, copy, name), "x\n", { mode: 0o600 });
    expect(update(targetDir, { FAKE_MAIL_SENDING_STATUS: IMPORTED }).status).toBe(0);
    for (const name of exact) expect(existsSync(join(targetDir, copy, name)), `${name} goes`).toBe(false);
    for (const name of nearMisses) expect(readFileSync(join(targetDir, copy, name), "utf8"), `${name} stays`).toBe("x\n");
  });
});

// #1915 O-F1 / O-F3: the discard loop ignored the copy marker's own temporary file (.orbit-smtp-undo.<6>), which the
// prune's qualifier accepts, so a killed repair's folder survived a confirmed retirement.
describe("#1915 O-F1/O-F3 install.sh smtp_discard_copy: the copy marker's temporary file", () => {
  it("is removed with the folder once mail sending is confirmed", () => {
    const targetDir = installedFolder();
    const envBlock = ["COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml", "SMTP_HOST=smtp.example.test", "SMTP_PORT=587", "SMTP_SECURITY=starttls", "SMTP_USER=orbit@example.test", "SMTP_PASSWORD_FILE=/run/orbit-secrets/orbit-smtp-password", "SMTP_FROM=Orbit <orbit@example.test>", ""];
    const envPath = join(targetDir, ".env-orbit");
    writeFileSync(envPath, `${readFileSync(envPath, "utf8")}${envBlock.join("\n")}`, { mode: 0o600 });
    writeFileSync(join(targetDir, ".orbit-secrets", "smtp-password"), "TEST-NOT-A-REAL-PASSWORD", { mode: 0o600 });
    const IMPORTED = "mail-sending source=imported imported-from-environment=true";
    const NONE = "mail-sending source=none imported-from-environment=false";
    const first = update(targetDir, { FAKE_MAIL_SENDING_STATUS: IMPORTED, FAKE_MAIL_SENDING_STATUS_AFTER_SECRET_GONE: NONE });
    expect(first.status, `first update stderr:\n${first.stderr}`).toBe(0);
    const record = readFileSync(join(targetDir, ".orbit-smtp-retirement"), "utf8");
    const copy = record.match(/^copy=(orbit-install-backups\/\S+)$/mu)?.[1];
    expect(copy, record).toBeDefined();
    writeFileSync(join(targetDir, copy, MARKER_LEFTOVER), `copy=${copy}\n`, { mode: 0o600 });
    const second = update(targetDir, { FAKE_MAIL_SENDING_STATUS: IMPORTED });
    expect(second.status, `second update stderr:\n${second.stderr}`).toBe(0);
    expect(existsSync(join(targetDir, ".orbit-smtp-retirement"))).toBe(false);
    expect(existsSync(join(targetDir, copy, MARKER_LEFTOVER)), "the marker's temporary file").toBe(false);
    expect(existsSync(join(targetDir, copy)), "the undo folder").toBe(false);
  });
});

// #1915 O-R1: the exit cleanup restores the terminal with stty, which a background process group must not
// stop on (SIGTTOU). The installer runs as a job in a shell with job control, so it has its own, background group.
describe("#1915 O-R1 install.sh exit cleanup as a background job on a terminal", () => {
  it("finishes instead of stopping on SIGTTOU", async () => {
    const targetDir = installedFolder();
    const binDir = makeFakeBin();
    const logDir = mkdtempSync(join(tmpdir(), "orbit-install-log-"));
    const env = { ...baseEnvironment(binDir, logDir), ...updateEnv() };
    const driver = [
      "set -m",
      `bash ${installScript} --plain --update </dev/null >/dev/null 2>&1 &`,
      "pid=$!",
      "result=timeout",
      "for _ in $(seq 1 150); do",
      "  sleep 0.2",
      '  state="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d " ")"',
      '  case "$state" in',
      '    "" | Z*) result=finished; break ;;',
      "    T*) result=stopped; break ;;",
      "  esac",
      "done",
      'kill -KILL "$pid" 2>/dev/null',
      'printf "\\nBG-RESULT=%s\\n" "$result"',
    ].join("\n");
    const output = await new Promise((resolve, reject) => {
      const child = spawn("script", ["-qeE", "never", "-c", `bash -c '${driver.replaceAll("'", "'\\''")}'`, "/dev/null"], { cwd: targetDir, env });
      let stdout = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timed out; output so far: ${stdout}`)); }, PROCESS_TEST_TIMEOUT_MS);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.on("error", reject);
      child.on("close", () => { clearTimeout(timer); resolve(stdout); });
    });
    expect(output.replace(/\r/gu, "")).toContain("BG-RESULT=finished");
  });
});

// #1915 O-R1, foreground: the same exit cleanup must still restore the terminal when the installer's group owns
// it. A stty shim logs each call, so a restore that never runs (terminal_background_job always true) fails here.
describe("#1915 O-R1 install.sh exit cleanup in the terminal's foreground", () => {
  it("restores the terminal: stty is called with the saved settings and then with echo", async () => {
    const targetDir = installedFolder();
    const binDir = makeFakeBin();
    const logDir = mkdtempSync(join(tmpdir(), "orbit-install-log-"));
    const shim = mkdtempSync(join(tmpdir(), "orbit-stty-shim-"));
    const sttyLog = join(shim, "stty.log");
    const real = spawnSync("bash", ["-c", "command -v stty"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(shim, "stty"), `#!/bin/bash\nprintf '%s\\n' "$*" >> '${sttyLog}'\nexec '${real}' "$@"\n`);
    chmodSync(join(shim, "stty"), 0o755);
    const base = { ...baseEnvironment(binDir, logDir), ...updateEnv() };
    const env = { ...base, PATH: `${shim}:${base.PATH}` };
    await new Promise((resolve, reject) => {
      const child = spawn("script", ["-qeE", "never", "-c", `bash ${installScript} --plain --update </dev/null >/dev/null 2>&1`, "/dev/null"], { cwd: targetDir, env });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("timed out")); }, PROCESS_TEST_TIMEOUT_MS);
      child.on("error", reject);
      child.on("close", () => { clearTimeout(timer); resolve(); });
    });
    const calls = existsSync(sttyLog) ? readFileSync(sttyLog, "utf8").split("\n").filter(Boolean) : [];
    const saved = calls.indexOf("-g");
    expect(saved, calls.join(" | ")).toBeGreaterThanOrEqual(0);
    expect(calls.slice(saved + 1), "the restore after the save").toContain("echo");
    expect(calls.slice(saved + 1).some((call) => call !== "echo" && call !== "-g"), "the saved settings are put back").toBe(true);
  });
});
