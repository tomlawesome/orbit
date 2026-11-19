// #1848: install.sh's SMTP retirement writes its step record (smtp_write_record) and its undo copy of
// .env-orbit (smtp_write_copy) through a fresh mktemp file beside the target, as retire_smtp_steps does for
// .env-orbit itself (d931a64a) and repair.sh does (FIX-S1). A file or link at the old fixed names
// (.orbit-smtp-retirement.tmp, <undo folder>/.env-orbit.smtp-copy.tmp) is never followed, overwritten or
// removed, and no temporary file is left behind on success or failure. A `mv` shim on PATH logs every
// rename (and fails the ones a test names), so the temporary name is seen, not guessed.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { copyInstalledFolder, makeFakeBin, makePreprovisionedDeployment, makeTarget, recognisedVolume, runInstall } from "./install-test-support.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS, hookTimeout: PROCESS_TEST_TIMEOUT_MS });

const IMPORTED = "mail-sending source=imported imported-from-environment=true";
const NONE_AFTER = { FAKE_MAIL_SENDING_STATUS_AFTER_SECRET_GONE: "mail-sending source=none imported-from-environment=false" };
const RECORD = ".orbit-smtp-retirement";
const COPY_TMP = ".env-orbit.smtp-copy";
const VICTIM_TEXT = "victim: must stay exactly as it is\n";
const BACKUPS = "orbit-install-backups";

let template;
beforeAll(() => {
  template = makeTarget();
  makePreprovisionedDeployment(template);
  expect(runInstall(template, {}, ["--plain", "--install"]).status).toBe(0);
});

function folderWithSmtp() {
  const targetDir = copyInstalledFolder(template);
  const lines = ["COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml", "SMTP_HOST=smtp.example.test", "SMTP_PORT=587", "SMTP_USER=orbit@example.test", "SMTP_PASSWORD_FILE=/run/orbit-secrets/orbit-smtp-password", "SMTP_FROM=Orbit <orbit@example.test>", ""];
  const envPath = join(targetDir, ".env-orbit");
  writeFileSync(envPath, `${readFileSync(envPath, "utf8")}${lines.join("\n")}`, { mode: 0o600 });
  writeFileSync(join(targetDir, ".orbit-secrets", "smtp-password"), "TEST-NOT-A-REAL-PASSWORD", { mode: 0o600 });
  return targetDir;
}

/** Updates with a mv shim in front: `failDest` is a bash case pattern; a rename whose destination matches it fails. Returns the renames seen as {src, dest}, relative to the folder. */
function update(targetDir, { failDest, extraEnv = {} } = {}) {
  const shim = mkdtempSync(join(tmpdir(), "orbit-mv-shim-"));
  const log = join(shim, "mv.log");
  const real = spawnSync("bash", ["-c", "command -v mv"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(
    join(shim, "mv"),
    `#!/bin/bash\nfiles=(); for a in "$@"; do case "$a" in -*) ;; *) files+=("$a");; esac; done\nprintf '%s\\t%s\\n' "\${files[0]}" "\${files[1]}" >> '${log}'\ncase "\${files[1]}" in ${failDest ?? "__never__"}) exit 1;; esac\nexec '${real}' "$@"\n`,
  );
  chmodSync(join(shim, "mv"), 0o755);
  const own = recognisedVolume("orbit");
  const stateDir = mkdtempSync(join(tmpdir(), "orbit-retire-temp-state-"));
  const result = runInstall(
    targetDir,
    {
      FAKE_VOLUMES: own.volume,
      FAKE_PS: JSON.stringify(own.ps),
      FAKE_CONTAINER_IMAGES: JSON.stringify(own.images),
      FAKE_STATE_DIR: stateDir,
      XDG_STATE_HOME: join(stateDir, "state"),
      FAKE_MAIL_SENDING_STATUS: IMPORTED,
      PATH: `${shim}:${makeFakeBin()}:${process.env.PATH}`,
      ...extraEnv,
    },
    ["--plain", "--update"],
  );
  const rel = (path) => path.replace(`${targetDir}/`, "").replace(/^\.\//u, "");
  const renames = existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((row) => {
        const [src, dest] = row.split("\t");
        return { src: rel(src), dest: rel(dest) };
      })
    : [];
  return { ...result, renames };
}

const victimIn = () => {
  const path = join(mkdtempSync(join(tmpdir(), "orbit-victim-")), "victim");
  writeFileSync(path, VICTIM_TEXT);
  return path;
};
const recordLeftovers = (targetDir) => readdirSync(targetDir).filter((name) => name.startsWith(`${RECORD}.`));
const undoFolders = (targetDir) => (existsSync(join(targetDir, BACKUPS)) ? readdirSync(join(targetDir, BACKUPS)).map((name) => join(targetDir, BACKUPS, name)) : []);
const copyLeftovers = (targetDir) => undoFolders(targetDir).flatMap((folder) => readdirSync(folder).filter((name) => name.startsWith(`${COPY_TMP}.`)));
/** An undo folder a killed run left, which the next run adopts (marker naming itself, no step record). */
function orphanUndoFolder(targetDir) {
  const name = "20250101T000000Z";
  const folder = join(targetDir, BACKUPS, name);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, ".orbit-smtp-undo"), `copy=${BACKUPS}/${name}\n`, { mode: 0o600 });
  return folder;
}

describe("#1848 smtp_write_record: the step record goes through a fresh temporary file", () => {
  it("every record write renames a fresh .orbit-smtp-retirement.<6 characters> file from the same folder, never the old fixed name", () => {
    const targetDir = folderWithSmtp();
    const result = update(targetDir);
    expect(result.status).toBe(0);
    const writes = result.renames.filter((entry) => entry.dest === RECORD);
    expect(writes.length).toBeGreaterThanOrEqual(3);
    for (const { src } of writes) expect(src).toMatch(/^\.orbit-smtp-retirement\.[A-Za-z0-9]{6}$/u);
    expect(new Set(writes.map((entry) => entry.src)).size).toBe(writes.length);
  });

  it("a symlink at the old fixed name is never followed or replaced: its target and the link stay", () => {
    const targetDir = folderWithSmtp();
    const victim = victimIn();
    symlinkSync(victim, join(targetDir, `${RECORD}.tmp`));
    const result = update(targetDir, { extraEnv: NONE_AFTER });
    expect(result.status).toBe(0);
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_TEXT);
    expect(lstatSync(join(targetDir, `${RECORD}.tmp`)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(targetDir, `${RECORD}.tmp`))).toBe(victim);
    expect(readFileSync(join(targetDir, RECORD), "utf8")).toMatch(/^step=retired$/mu);
  });

  it("a directory at the old fixed name neither blocks the record nor is touched", () => {
    const targetDir = folderWithSmtp();
    mkdirSync(join(targetDir, `${RECORD}.tmp`));
    writeFileSync(join(targetDir, `${RECORD}.tmp`, "keep"), "not the installer's\n");
    const result = update(targetDir, { extraEnv: NONE_AFTER });
    expect(result.status).toBe(0);
    expect(readFileSync(join(targetDir, `${RECORD}.tmp`, "keep"), "utf8")).toBe("not the installer's\n");
    expect(readFileSync(join(targetDir, RECORD), "utf8")).toMatch(/^step=retired$/mu);
  });

  it("leaves no temporary record file when the rename fails", () => {
    const targetDir = folderWithSmtp();
    update(targetDir, { failDest: RECORD });
    expect(recordLeftovers(targetDir)).toEqual([]);
  });

  it("leaves no temporary record file after a completed retirement", () => {
    const targetDir = folderWithSmtp();
    const result = update(targetDir);
    expect(result.status).toBe(0);
    expect(recordLeftovers(targetDir)).toEqual([]);
  });
});

describe("#1848 smtp_write_copy: the undo copy of .env-orbit goes through a fresh temporary file", () => {
  it("renames a fresh .env-orbit.smtp-copy.<6 characters> file from the undo folder over its .env-orbit, never the old fixed name", () => {
    const targetDir = folderWithSmtp();
    const result = update(targetDir, { extraEnv: NONE_AFTER });
    expect(result.status).toBe(0);
    const writes = result.renames.filter((entry) => /^orbit-install-backups\/[^/]+\/\.env-orbit$/u.test(entry.dest));
    expect(writes).toHaveLength(1);
    expect(writes[0].src).toMatch(/^orbit-install-backups\/[^/]+\/\.env-orbit\.smtp-copy\.[A-Za-z0-9]{6}$/u);
    expect(readFileSync(writes[0].dest.replace(/^/u, `${targetDir}/`), "utf8")).toContain("SMTP_HOST=smtp.example.test");
  });

  it("a symlink at the old fixed name in an adopted undo folder is never followed, replaced or removed", () => {
    const targetDir = folderWithSmtp();
    const folder = orphanUndoFolder(targetDir);
    const victim = victimIn();
    symlinkSync(victim, join(folder, `${COPY_TMP}.tmp`));
    const result = update(targetDir, { extraEnv: NONE_AFTER });
    expect(result.status).toBe(0);
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_TEXT);
    expect(lstatSync(join(folder, `${COPY_TMP}.tmp`)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(folder, `${COPY_TMP}.tmp`))).toBe(victim);
    expect(readFileSync(join(folder, ".env-orbit"), "utf8")).toContain("SMTP_HOST=smtp.example.test");
  });

  it("a directory at the old fixed name in an adopted undo folder neither blocks the copy nor is touched", () => {
    const targetDir = folderWithSmtp();
    const folder = orphanUndoFolder(targetDir);
    mkdirSync(join(folder, `${COPY_TMP}.tmp`));
    writeFileSync(join(folder, `${COPY_TMP}.tmp`, "keep"), "not the installer's\n");
    const result = update(targetDir, { extraEnv: NONE_AFTER });
    expect(result.status).toBe(0);
    expect(readFileSync(join(folder, `${COPY_TMP}.tmp`, "keep"), "utf8")).toBe("not the installer's\n");
    expect(readFileSync(join(folder, ".env-orbit"), "utf8")).toContain("SMTP_HOST=smtp.example.test");
  });

  it("leaves no temporary copy file when the rename fails, and the SMTP lines stay in .env-orbit", () => {
    const targetDir = folderWithSmtp();
    update(targetDir, { failDest: "*/.env-orbit" });
    expect(copyLeftovers(targetDir)).toEqual([]);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toContain("SMTP_HOST=smtp.example.test");
  });

  it("leaves no temporary copy file once the undo copy is kept after a completed retirement", () => {
    const targetDir = folderWithSmtp();
    const result = update(targetDir, { extraEnv: NONE_AFTER });
    expect(result.status).toBe(0);
    expect(copyLeftovers(targetDir)).toEqual([]);
  });
});
