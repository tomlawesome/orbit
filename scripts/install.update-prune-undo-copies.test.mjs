// scripts/install.sh --plain --update: a one-time clean-up of old undo copies
// (#1834 slice 5). Written from the specification alone (issue #1834, "One-time
// prune of old copies" and "Never touched", and owner decision 10a,
// 2026-11-14: "when we ask the user for a loud yes, we must be abundantly
// clear it CANNOT be undone"), before the change.
//
// The specification:
//  - earlier releases left dated folders in orbit-install-backups/ holding
//    full .env-orbit copies (which can hold secrets) and other undo copies;
//    an update lists each on stderr with its path, date and size, never silently;
//  - a folder qualifies only when it holds nothing but the names the
//    installer and repair.sh write there: .env-orbit, docker-compose.mail.yml
//    (repair.sh's overlay copy), .orbit-smtp-undo and .env-orbit.smtp-copy.tmp.
//    Anything else, a symlink or a sub-folder: listed as "not removed", left alone.
//    The current run's own folder, and a folder named by the live step record
//    (.orbit-smtp-retirement) or a live marker, is never offered;
//  - with a terminal: after the list, one prompt, preceded by a plain
//    statement that removal is permanent and CANNOT be undone. Only an exact
//    "yes" removes, one line per folder; Enter, EOF or anything else is no;
//  - no terminal: list only, remove nothing, one line on how to remove them
//    (re-run interactively, or --remove-old-undo-copies);
//  - --remove-old-undo-copies removes without asking, still lists them and
//    still states that it CANNOT be undone;
//  - never touched: moved/, engine/, originals/, recovery bundles, backup.sh
//    archives, anything outside orbit-install-backups;
//  - nothing to prune: no output; the update's result and exit code are unchanged.
//
// A terminal is simulated with runInstallOnTerminal (util-linux `script`, a
// real pty), as in install.backups.test.mjs; stdout and stderr arrive merged
// there. An answer is typed once the CANNOT line appears; EOF is Ctrl-D (\x04)
// at the start of a line.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { makePreprovisionedDeployment, makeTarget, recognisedVolume, runInstall, runInstallOnTerminal } from "./install-test-support.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS * 2 });

const FLAG = "--remove-old-undo-copies";
const FAKE_PASSWORD = "TEST-NOT-A-REAL-PASSWORD";
const FULL_ENV_COPY = ["APP_URL=https://orbit.example.test", "SMTP_HOST=smtp.example.test", `SMTP_PASSWORD=${FAKE_PASSWORD}`, ""].join("\n");

/** Folders an earlier release left, holding only known undo-copy names: these qualify. */
const QUALIFYING = {
  "20250102T030405Z": { ".env-orbit": FULL_ENV_COPY },
  "20250203T040506Z-repair": { ".env-orbit": "SMTP_HOST=smtp.example.test\n", "docker-compose.mail.yml": "services: {}\n" },
  "20250304T050607Z-2": { ".env-orbit.smtp-copy.tmp": "SMTP_HOST=smtp.example.test\n" },
};
const ISO_DATE = { "20250102T030405Z": "2025-01-02", "20250203T040506Z-repair": "2025-02-03", "20250304T050607Z-2": "2025-03-04" };
/** Dated folders that hold something else: listed as not removed, left alone. */
const OTHER_FILE = "20250405T060708Z";
const SUB_FOLDER = "20250506T070809Z";
const SYMLINKED = "20250607T080910Z";
const NOT_QUALIFYING = [OTHER_FILE, SUB_FOLDER, SYMLINKED];
/** Never touched, whatever they hold. */
const QUARANTINE = { "20250708T091011Z": "moved", "20250809T101112Z": "engine", "20250910T111213Z": "originals" };

const backups = (targetDir) => join(targetDir, "orbit-install-backups");
const stampTime = (name) => {
  const [, y, mo, d, h, mi, s] = name.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z/u);
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
};
const writeFolder = (dir, files) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, { mode: 0o600 });
};

/** A deployment made by a real plain install, ready to be updated. */
function installedFolder() {
  const targetDir = makeTarget();
  makePreprovisionedDeployment(targetDir);
  expect(runInstall(targetDir, {}, ["--plain", "--install"]).status).toBe(0);
  return targetDir;
}

/** What earlier releases and the operator left: every case the clean-up must sort. */
function withOldCopies(targetDir) {
  const root = backups(targetDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const [name, files] of Object.entries(QUALIFYING)) writeFolder(join(root, name), files);
  writeFolder(join(root, OTHER_FILE), { ".env-orbit": FULL_ENV_COPY, "notes.txt": "the operator's own note\n" });
  writeFolder(join(root, SUB_FOLDER), { ".env-orbit": FULL_ENV_COPY });
  writeFolder(join(root, SUB_FOLDER, "keep"), { "file.txt": "kept\n" });
  mkdirSync(join(root, SYMLINKED), { mode: 0o700 });
  symlinkSync(join(targetDir, ".env-orbit"), join(root, SYMLINKED, ".env-orbit"));
  for (const [name, sub] of Object.entries(QUARANTINE)) writeFolder(join(root, name, sub), { ".env-orbit": FULL_ENV_COPY });
  // An operator's recovery bundle and a backup.sh archive, inside and outside the folder.
  writeFolder(join(root, "operator-recovery"), { "recovery-bundle.orbkek": "bundle\n" });
  writeFileSync(join(root, "orbit-backup-20250101T000000Z.tar"), "archive\n", { mode: 0o600 });
  writeFileSync(join(targetDir, "orbit-backup-20250101T000000Z.tar"), "archive\n", { mode: 0o600 });
  // A dated folder outside orbit-install-backups holding only a known name.
  writeFolder(join(targetDir, "20250102T030405Z"), { ".env-orbit": FULL_ENV_COPY });
  for (const name of [...Object.keys(QUALIFYING), ...NOT_QUALIFYING, ...Object.keys(QUARANTINE)]) {
    const when = stampTime(name);
    for (const path of [join(root, name), ...Object.keys(QUALIFYING[name] ?? {}).map((file) => join(root, name, file))]) utimesSync(path, when, when);
  }
  return targetDir;
}

/** The pre-#1629 SMTP block, as install.update-retire-smtp.test.mjs writes it: a retirement is due. */
function withSmtpLines(targetDir) {
  const envPath = join(targetDir, ".env-orbit");
  const block = [
    "COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml",
    "SMTP_HOST=smtp.example.test",
    "SMTP_PORT=587",
    "SMTP_SECURITY=starttls",
    "SMTP_USER=orbit@example.test",
    "SMTP_PASSWORD_FILE=/run/orbit-secrets/orbit-smtp-password",
    "SMTP_FROM=Orbit <orbit@example.test>",
    "",
  ];
  writeFileSync(envPath, `${readFileSync(envPath, "utf8")}${block.join("\n")}`, { mode: 0o600 });
  writeFileSync(join(targetDir, ".orbit-secrets", "smtp-password"), FAKE_PASSWORD, { mode: 0o600 });
  return targetDir;
}

/** Everything the clean-up must leave as it was, as one comparable string. */
const untouched = (targetDir) =>
  spawnSync(
    "bash",
    [
      "-c",
      'find "$@" -printf "%p %y %m %l\\n" | LC_ALL=C sort; find "$@" -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum',
      "untouched",
      ...[...NOT_QUALIFYING, ...Object.keys(QUARANTINE), "operator-recovery", "orbit-backup-20250101T000000Z.tar"].map((name) => join(backups(targetDir), name)),
      join(targetDir, "orbit-backup-20250101T000000Z.tar"),
      join(targetDir, "20250102T030405Z"),
    ],
    { encoding: "utf8" },
  ).stdout;

const updateEnv = (extra = {}) => {
  const own = recognisedVolume("orbit");
  return { FAKE_VOLUMES: own.volume, FAKE_PS: JSON.stringify(own.ps), FAKE_CONTAINER_IMAGES: JSON.stringify(own.images), ...extra };
};
const update = (targetDir, args = [], extra = {}) => runInstall(targetDir, updateEnv(extra), ["--plain", "--update", ...args]);
const updateOnTerminal = (targetDir, answer) =>
  runInstallOnTerminal(targetDir, updateEnv(), answer === undefined ? [] : [{ after: "CANNOT", input: answer }], ["--plain", "--update"]);

const lines = (text) => text.replace(/\r/gu, "").split("\n");
const mentioning = (text, name) => lines(text).filter((entry) => entry.includes(`orbit-install-backups/${name}`));
const removedLines = (text, name) => mentioning(text, name).filter((entry) => /removed/iu.test(entry) && !/not removed/iu.test(entry));
const cannotLines = (text) => lines(text).filter((entry) => entry.includes("CANNOT") && /undone/iu.test(entry));
const resultBlock = (text) => text.replace(/\r/gu, "").slice(text.replace(/\r/gu, "").lastIndexOf("Orbit is ready."));
const SIZE = /\b\d+(?:[.,]\d+)?\s?(?:B|bytes?|K|KB|KiB|M|MB|MiB)\b/u;

function expectListed(text) {
  for (const name of Object.keys(QUALIFYING)) {
    const listed = mentioning(text, name);
    expect(listed, `${name} is listed`).not.toEqual([]);
    expect(listed.some((entry) => entry.includes(ISO_DATE[name]) && SIZE.test(entry)), `${name} is listed with its date and size: ${listed.join(" | ")}`).toBe(true);
  }
}
function expectNotRemovedListed(text) {
  for (const name of NOT_QUALIFYING) {
    expect(mentioning(text, name).some((entry) => /not removed/iu.test(entry)), `${name} is listed as not removed`).toBe(true);
  }
}
const qualifyingLeft = (targetDir) => Object.keys(QUALIFYING).filter((name) => existsSync(join(backups(targetDir), name)));

describe("install.sh --plain --update: old undo copies, unattended (#1834 slice 5)", () => {
  it("lists each qualifying folder on stderr with its path, date and size, and removes nothing", () => {
    const targetDir = withOldCopies(installedFolder());
    const before = untouched(targetDir);
    const result = update(targetDir);
    expect(result.status).toBe(0);
    expectListed(result.stderr);
    expect(qualifyingLeft(targetDir)).toEqual(Object.keys(QUALIFYING));
    expect(readFileSync(join(backups(targetDir), "20250102T030405Z", ".env-orbit"), "utf8")).toBe(FULL_ENV_COPY);
    expect(untouched(targetDir)).toBe(before);
  });

  it("prints exactly one line saying how to remove them: re-run interactively, or pass the flag", () => {
    const targetDir = withOldCopies(installedFolder());
    const result = update(targetDir);
    const how = lines(result.stderr).filter((entry) => entry.includes(FLAG));
    expect(how).toHaveLength(1);
    expect(how[0]).toMatch(/interactiv|terminal/iu);
    for (const name of Object.keys(QUALIFYING)) expect(removedLines(result.stderr, name)).toEqual([]);
  });

  it("lists a folder holding another file, a sub-folder or a symlink as not removed", () => {
    const targetDir = withOldCopies(installedFolder());
    const result = update(targetDir);
    expectNotRemovedListed(result.stderr);
  });

  it("lists a lone dated folder that does not qualify as not removed, with its path, and leaves it", () => {
    const targetDir = installedFolder();
    const lone = join(backups(targetDir), OTHER_FILE);
    writeFolder(lone, { ".env-orbit": FULL_ENV_COPY, "notes.txt": "the operator's own note\n" });
    const result = update(targetDir);
    expect(result.status).toBe(0);
    const listed = mentioning(result.stderr, OTHER_FILE);
    expect(listed.some((entry) => /not removed/iu.test(entry)), `listed as not removed: ${listed.join(" | ")}`).toBe(true);
    expect(removedLines(result.stderr, OTHER_FILE)).toEqual([]);
    expect(readFileSync(join(lone, ".env-orbit"), "utf8")).toBe(FULL_ENV_COPY);
    expect(readFileSync(join(lone, "notes.txt"), "utf8")).toBe("the operator's own note\n");
  });

  it("leaves the update's result and exit code as an update without old copies has them", () => {
    const plain = update(installedFolder());
    const withCopies = update(withOldCopies(installedFolder()));
    expect(plain.status).toBe(0);
    expect(withCopies.status).toBe(plain.status);
    expect(resultBlock(withCopies.stdout)).toBe(resultBlock(plain.stdout));
    expectListed(withCopies.stderr);
  });
});

describe("install.sh --plain --update: old undo copies, on a terminal (#1834 slice 5)", () => {
  it('after the list, says plainly it CANNOT be undone, and an exact "yes" removes exactly the qualifying folders, one line each', async () => {
    const targetDir = withOldCopies(installedFolder());
    const before = untouched(targetDir);
    const result = await updateOnTerminal(targetDir, "yes\r");
    expect(result.status).toBe(0);
    const output = result.stdout.replace(/\r/gu, "");
    expectListed(output);
    expect(cannotLines(output).length).toBeGreaterThanOrEqual(1);
    expect(output).toMatch(/permanent/iu);
    const cannotAt = output.indexOf(cannotLines(output)[0]);
    for (const name of Object.keys(QUALIFYING)) expect(output.indexOf(`orbit-install-backups/${name}`)).toBeLessThan(cannotAt);
    expect(result.promptedInteractions).toBe(1);
    expect(qualifyingLeft(targetDir)).toEqual([]);
    for (const name of Object.keys(QUALIFYING)) expect(removedLines(output, name), `one removal line for ${name}`).toHaveLength(1);
    for (const name of NOT_QUALIFYING) expect(removedLines(output, name)).toEqual([]);
    expect(untouched(targetDir)).toBe(before);
    expect(resultBlock(output)).toContain("Orbit is ready.");
  });

  for (const [label, answer] of [
    ["Enter (the default)", "\r"],
    ["EOF", "\x04"],
    ['"y"', "y\r"],
    ['"YES"', "YES\r"],
    ['"no"', "no\r"],
  ]) {
    it(`${label} means no: the prompt is shown, nothing is removed, and the update still succeeds`, async () => {
      const targetDir = withOldCopies(installedFolder());
      const before = untouched(targetDir);
      const result = await updateOnTerminal(targetDir, answer);
      expect(result.status).toBe(0);
      const output = result.stdout.replace(/\r/gu, "");
      expect(cannotLines(output).length).toBeGreaterThanOrEqual(1);
      expect(result.promptedInteractions).toBe(1);
      expect(qualifyingLeft(targetDir)).toEqual(Object.keys(QUALIFYING));
      for (const name of Object.keys(QUALIFYING)) expect(removedLines(output, name)).toEqual([]);
      expect(untouched(targetDir)).toBe(before);
    });
  }
});

describe(`install.sh --plain --update ${FLAG} (#1834 slice 5)`, () => {
  it("removes the qualifying folders without asking, still lists them, and still states it CANNOT be undone", () => {
    const targetDir = withOldCopies(installedFolder());
    const before = untouched(targetDir);
    const result = update(targetDir, [FLAG]);
    expect(result.status).toBe(0);
    expectListed(result.stderr);
    expect(cannotLines(result.stderr).length).toBeGreaterThanOrEqual(1);
    expect(qualifyingLeft(targetDir)).toEqual([]);
    for (const name of Object.keys(QUALIFYING)) expect(removedLines(result.stderr, name)).toHaveLength(1);
    expectNotRemovedListed(result.stderr);
    expect(untouched(targetDir)).toBe(before);
    expect(resultBlock(result.stdout)).toContain("Orbit is ready.");
  });

  it("never offers a folder named by a live step record (.orbit-smtp-retirement)", () => {
    const targetDir = withOldCopies(installedFolder());
    const live = "20251011T121314Z";
    writeFolder(join(backups(targetDir), live), { ".env-orbit": "SMTP_HOST=smtp.example.test\n", ".orbit-smtp-undo": `copy=orbit-install-backups/${live}\n` });
    writeFileSync(join(targetDir, ".orbit-smtp-retirement"), `step=backed-up\ncopy=orbit-install-backups/${live}\n`, { mode: 0o600 });
    // No status command (an older image): the retirement waits, its record stays live.
    const result = update(targetDir, [FLAG]);
    expect(result.status).toBe(0);
    expect(qualifyingLeft(targetDir)).toEqual([]);
    expect(existsSync(join(backups(targetDir), live, ".env-orbit"))).toBe(true);
    expect(removedLines(result.stderr, live)).toEqual([]);
  });

  it("never offers a marked undo copy while its retirement is still due", () => {
    const targetDir = withOldCopies(installedFolder());
    const marked = "20251112T131415Z";
    writeFolder(join(backups(targetDir), marked), { ".env-orbit": "SMTP_HOST=smtp.example.test\n", ".orbit-smtp-undo": `copy=orbit-install-backups/${marked}\n` });
    withSmtpLines(targetDir);
    const result = update(targetDir, [FLAG]);
    expect(result.status).toBe(0);
    expect(qualifyingLeft(targetDir)).toEqual([]);
    expect(existsSync(join(backups(targetDir), marked, ".env-orbit"))).toBe(true);
    expect(removedLines(result.stderr, marked)).toEqual([]);
  });

  it("never offers the current run's own undo copy", () => {
    const targetDir = withOldCopies(installedFolder());
    withSmtpLines(targetDir);
    // The retirement runs, but mail sending is not confirmed afterwards: this run's copy is kept.
    const result = update(targetDir, [FLAG], {
      FAKE_MAIL_SENDING_STATUS: "mail-sending source=imported imported-from-environment=true",
      FAKE_MAIL_SENDING_STATUS_AFTER_SECRET_GONE: "mail-sending source=none imported-from-environment=false",
    });
    expect(result.status).toBe(0);
    expect(qualifyingLeft(targetDir)).toEqual([]);
    const record = readFileSync(join(targetDir, ".orbit-smtp-retirement"), "utf8");
    const own = record.match(/^copy=orbit-install-backups\/(\S+)$/mu)?.[1];
    expect(own).toBeDefined();
    expect(existsSync(join(backups(targetDir), own, ".env-orbit"))).toBe(true);
    expect(removedLines(result.stderr, own)).toEqual([]);
  });
});

describe("install.sh --plain --update: nothing to prune (#1834 slice 5)", () => {
  const quiet = (text) =>
    lines(text).filter((entry) => entry.includes("orbit-install-backups") || entry.includes(FLAG) || entry.includes("CANNOT"));

  it("prints nothing about old copies when there is no orbit-install-backups folder, with or without the flag", () => {
    const targetDir = installedFolder();
    for (const args of [[], [FLAG]]) {
      const result = update(targetDir, args);
      expect(result.status).toBe(0);
      expect(quiet(result.stderr)).toEqual([]);
      expect(quiet(result.stdout)).toEqual([]);
    }
  });

  it("prints nothing when orbit-install-backups is empty, and leaves it", () => {
    const targetDir = installedFolder();
    mkdirSync(backups(targetDir), { mode: 0o700 });
    const result = update(targetDir, [FLAG]);
    expect(result.status).toBe(0);
    expect(quiet(result.stderr)).toEqual([]);
    expect(existsSync(backups(targetDir))).toBe(true);
  });
});
