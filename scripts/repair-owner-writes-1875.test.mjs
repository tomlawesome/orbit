import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { IMAGE_COMPOSE, composeFolder, runOwner } from "./repair-owner-fixtures.mjs";
import { privShims, realTool } from "./repair-priv-shims.mjs";
import { makeFixture, scratchDir } from "./repair-test-harness.mjs";

// #1875 (spec W1-W5): run as root in a folder another user owns, update-config's rename of the staged password,
// the removal of old credential checkpoints, root's compares of files the owner controls and the checkpoint
// bundle's check run as the owner, through the bounded no-follow read, or not at all. Written from the spec
// alone, on the #1857 shims (simulated root; see repair-owner-writes-1872.test.mjs for how they work).

vi.setConfig({ testTimeout: 90_000 });

const PASSPHRASE = "correct-horse-battery-staple";
const LIMIT = { ORBIT_REPAIR_OWNER_STEP_TIMEOUT: "2" };
const BUDGET_MS = 40_000;
const LOCK = ["backups", ".orbit-backup-restore.lock"];
const EXTRA = ["cp", "install", "touch", "ln", "tee"];
const HEX = /^[0-9a-f]{64}$/u;
const ORIGINAL = `${"a".repeat(64)}\n`;
const DONE = "execute action=rotate-database-credential resolves=database-credential-mismatch result=done";
const STAGED_LINE = /a newly rotated credential is already staged at /u;
const RUNNING = { db: "running", app: "running" };

const shimsFor = (targetDir, options = {}) => privShims(targetDir, { extraTools: EXTRA, ...options });
const orbitLines = (result) => result.stderr.split("\n").filter((line) => line.startsWith("Orbit repair:"));
const lockFree = (targetDir) => !existsSync(join(targetDir, ...LOCK)) || spawnSync("flock", ["-n", join(targetDir, ...LOCK), "true"], { encoding: "utf8" }).status === 0;
const setprivNaming = (shims, re) => shims.setprivCalls().filter((line) => re.test(line));
/** Calls root itself (marker=0) made to `tool` that name a path in the folder. */
const rootCalls = (shims, tool, re = /./u) => shims.toolCalls().filter((line) => line.startsWith(`${tool} `) && / marker=0 /u.test(line) && / under=1 /u.test(line) && re.test(line));
const checkpointsIn = (targetDir) => readdirSync(targetDir).filter((entry) => entry.startsWith(".orbit-repair-checkpoint."));

function mismatchFolder() {
  const targetDir = makeFixture();
  const markers = scratchDir();
  return { targetDir, state: { ...RUNNING, docker: { db: { present: true, ready: true, authResult: "mismatch" }, dbAuthMarkerPath: join(markers, "db-auth-marker") } } };
}

/** A rotation: checkpoint, rotate-credential, update-config, restarts, a clean re-check and the checkpoint's removal. */
function rotate(shims, folder, options = {}) {
  return runOwner(folder.targetDir, { shims, state: folder.state, args: ["--execute", "--dangerous"], input: `rotate\n${PASSPHRASE}\n${PASSPHRASE}\n`, capSeconds: 60, ...options });
}

/** A folder with the backups folder and its lock already there (so the lock steps are not what is under test). */
function prepared(make) {
  const folder = make();
  mkdirSync(join(folder.targetDir, LOCK[0]), { mode: 0o700 });
  writeFileSync(join(folder.targetDir, ...LOCK), "", { mode: 0o600 });
  return folder;
}

function expectBounded(result, folder, reason) {
  expect(result.hung, `repair was still running after the test's own cap:\n${result.stderr.slice(0, 600)}`).toBe(false);
  expect(result.ms, "repair outlived the step limit plus the kill grace").toBeLessThan(BUDGET_MS);
  const named = orbitLines(result).filter((line) => reason.test(line));
  expect(named, `no 'Orbit repair:' line gives the reason ${reason}:\n${result.stderr.slice(0, 1500)}`).not.toEqual([]);
  expect(named.every((line) => line.length < 5000), "a line over the 4096-byte cap").toBe(true);
  expect(result.stderr.length, "the child's words were not capped").toBeLessThan(40_000);
  expect(lockFree(folder.targetDir), "the backup/restore lock is still held").toBe(true);
}

const STAGING = ".orbit-install-staging.abc123";
const MANAGED = ["docker-compose.yml", "docker-compose.mail.yml", ".env-orbit.example", "config/tika-config.json", "scripts/configure.sh", "scripts/installer-ui.sh", "scripts/backup.sh", "scripts/restore.sh", "scripts/repair.sh", "update.sh", ".env-orbit", ".orbit-secrets", ".orbit-files"];

/** A staging folder whose saved originals are every managed file the folder has, byte for byte and mode for mode, so a restore would change nothing. */
function identicalFolder(bytes = "services:\n  orbit-app:\n    image: busybox\n") {
  const targetDir = makeFixture();
  writeFileSync(join(targetDir, "docker-compose.yml"), bytes, { mode: 0o644 });
  chmodSync(join(targetDir, "docker-compose.yml"), 0o644);
  const staging = join(targetDir, STAGING);
  const original = join(staging, "rollback", "original");
  mkdirSync(original, { recursive: true, mode: 0o700 });
  for (const dir of [staging, join(staging, "rollback"), original]) chmodSync(dir, 0o700);
  const present = MANAGED.filter((path) => existsSync(join(targetDir, path)));
  const copied = spawnSync("cp", ["-a", "--parents", ...present, original], { cwd: targetDir, encoding: "utf8" });
  if (copied.status !== 0) throw new Error(copied.stderr);
  return { targetDir, state: { ...RUNNING } };
}

// --- W1: update-config's rename ---------------------------------------------------------------------------------------

describe("#1875 W1: update-config renames the staged password as the owner, under the #1858 limits", () => {
  const RENAME_MATCH = '*" -- mv "*repair-staged-postgres-password*postgres-password';
  const stagedPath = (targetDir) => join(targetDir, ".orbit-secrets", ".repair-staged-postgres-password");

  it("the rename onto postgres-password runs under setpriv with mv -T; root makes no mv in the folder", () => {
    const folder = mismatchFolder();
    const shims = shimsFor(folder.targetDir);
    const result = rotate(shims, folder);
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(setprivNaming(shims, /\bmv\b.* -[a-zA-Z]*T\b.*\.repair-staged-postgres-password\s+\S*postgres-password$/u), "the rename was not done as the owner with mv -T").not.toEqual([]);
    expect(rootCalls(shims, "mv"), "root renamed something in the folder").toEqual([]);
    expect(shims.chownCalls()).toEqual([]);
    const live = join(folder.targetDir, ".orbit-secrets", "postgres-password");
    expect(readFileSync(live, "utf8").trim()).toMatch(HEX);
    expect(readFileSync(live, "utf8")).not.toBe(ORIGINAL);
    expect(existsSync(stagedPath(folder.targetDir))).toBe(false);
  });

  it("a failed owner rename leaves the staged file in place and prints the 'staged password kept' line", () => {
    const folder = mismatchFolder();
    const shims = shimsFor(folder.targetDir, { setprivFail: RENAME_MATCH });
    const result = rotate(shims, folder);
    expect(setprivNaming(shims, / -- mv\b.*repair-staged-postgres-password\s+\S*postgres-password$/u), "the rename never went through setpriv").not.toEqual([]);
    expect(result.stdout).not.toContain(DONE);
    expect(existsSync(stagedPath(folder.targetDir)), "the staged file is gone").toBe(true);
    expect(readFileSync(join(folder.targetDir, ".orbit-secrets", "postgres-password"), "utf8")).toBe(ORIGINAL);
    expect(orbitLines(result).some((line) => STAGED_LINE.test(line)), `no staged-password line:\n${result.stderr.slice(0, 1500)}`).toBe(true);
    expect(rootCalls(shims, "mv")).toEqual([]);
  });

  for (const [kind, reason] of [["stop", /timed out/iu], ["flood", /Orbit repair:/u]]) {
    it(`an owner rename that ${kind === "stop" ? "stalls is timed out" : "floods its output is capped"}: bounded, the staged file stays, the line is printed, no lock held`, () => {
      const folder = prepared(mismatchFolder);
      const shims = shimsFor(folder.targetDir, { variant: { kind, match: RENAME_MATCH } });
      try {
        const result = rotate(shims, folder, { env: LIMIT });
        expect(setprivNaming(shims, / -- mv\b.*repair-staged-postgres-password\s+\S*postgres-password$/u), "the rename never went through setpriv").not.toEqual([]);
        expectBounded(result, folder, reason);
        expect(result.stdout).not.toContain(DONE);
        expect(existsSync(stagedPath(folder.targetDir)), "the staged file is gone").toBe(true);
        expect(readFileSync(join(folder.targetDir, ".orbit-secrets", "postgres-password"), "utf8")).toBe(ORIGINAL);
        expect(orbitLines(result).some((line) => STAGED_LINE.test(line)), `no staged-password line:\n${result.stderr.slice(0, 1500)}`).toBe(true);
        expect(rootCalls(shims, "mv")).toEqual([]);
      } finally {
        shims.cleanup();
      }
    });
  }
});

// --- W2: checkpoint removal -------------------------------------------------------------------------------------------

describe("#1875 W2: old credential checkpoints are removed as the owner, under the #1858 limits", () => {
  const RM_MATCH = '*" -- rm "*orbit-repair-checkpoint*';

  it("the removal runs under setpriv; root runs no rm on a checkpoint; the folder is gone", () => {
    const folder = mismatchFolder();
    const shims = shimsFor(folder.targetDir);
    const result = rotate(shims, folder);
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(setprivNaming(shims, / -- rm\b.*orbit-repair-checkpoint/u), "the checkpoint was not removed as the owner").not.toEqual([]);
    expect(rootCalls(shims, "rm", /orbit-repair-checkpoint/u), "root removed a checkpoint").toEqual([]);
    expect(checkpointsIn(folder.targetDir)).toEqual([]);
  });

  it("an owner removal that fails keeps the folder and names it", () => {
    const folder = mismatchFolder();
    const shims = shimsFor(folder.targetDir, { setprivFail: RM_MATCH });
    const result = rotate(shims, folder);
    expect(setprivNaming(shims, / -- rm\b.*orbit-repair-checkpoint/u), "the removal never went through setpriv").not.toEqual([]);
    const kept = checkpointsIn(folder.targetDir);
    expect(kept, "the checkpoint was removed anyway").toHaveLength(1);
    expect(orbitLines(result).filter((line) => line.includes(kept[0]) && /kept/u.test(line)), `no line says the checkpoint ${kept[0]} was kept:\n${result.stderr.slice(0, 1500)}`).not.toEqual([]);
    expect(rootCalls(shims, "rm", /orbit-repair-checkpoint/u)).toEqual([]);
  });

  for (const [kind, reason] of [["stop", /timed out/iu], ["flood", /Orbit repair:/u]]) {
    it(`an owner removal that ${kind === "stop" ? "stalls is timed out" : "floods its output is capped"}: bounded, the folder is kept and named, no lock held`, () => {
      const folder = prepared(mismatchFolder);
      const shims = shimsFor(folder.targetDir, { variant: { kind, match: RM_MATCH } });
      try {
        const result = rotate(shims, folder, { env: LIMIT });
        expect(setprivNaming(shims, / -- rm\b.*orbit-repair-checkpoint/u), "the removal never went through setpriv").not.toEqual([]);
        expectBounded(result, folder, reason);
        const kept = checkpointsIn(folder.targetDir);
        expect(kept, "the checkpoint was removed anyway").toHaveLength(1);
        expect(orbitLines(result).filter((line) => line.includes(kept[0]) && /kept/u.test(line)), `no line says the checkpoint ${kept[0]} was kept:\n${result.stderr.slice(0, 1500)}`).not.toEqual([]);
        expect(rootCalls(shims, "rm", /orbit-repair-checkpoint/u)).toEqual([]);
      } finally {
        shims.cleanup();
      }
    });
  }
});

// --- W3: root's compares ----------------------------------------------------------------------------------------------

describe("#1875 W3: root compares the folder's files only through the bounded, no-follow read", () => {
  const SAME_LINE = /would change nothing/u;

  const restore = (shims, folder, options = {}) => runOwner(folder.targetDir, { shims, state: folder.state, args: ["--execute", "--safe-only"], input: "y\n", capSeconds: 30, ...options });

  /** A `stat` that, once repair has looked at the folder's docker-compose.yml, swaps it for a symlink or a FIFO. */
  function swapStat(targetDir, kind) {
    const dir = scratchDir("orbit-1875-stat-");
    const outside = scratchDir("orbit-1875-outside-");
    const target = join(targetDir, "docker-compose.yml");
    const swap = kind === "symlink" ? `cp -- '${target}' '${outside}/copy' && rm -f -- '${target}' && ln -s '${outside}/copy' '${target}'` : `rm -f -- '${target}' && mkfifo '${target}'`;
    writeFileSync(
      join(dir, "stat"),
      `#!/usr/bin/env bash\nout="$('${realTool("stat")}' "$@")" || exit $?\nlast="\${@: -1}"\ncase "$last" in */orbit-install-staging*) ;; docker-compose.yml|./docker-compose.yml|'${target}') if [[ ! -e '${outside}/swapped' ]]; then : > '${outside}/swapped'; ${swap}; fi;; esac\nprintf '%s\\n' "$out"\n`,
    );
    chmodSync(join(dir, "stat"), 0o755);
    return dir;
  }

  it("control: identical files are 'same': the restore is skipped as changing nothing", () => {
    const folder = identicalFolder();
    const shims = shimsFor(folder.targetDir);
    const result = restore(shims, folder);
    expect(result.stderr, result.stdout).toMatch(SAME_LINE);
    expect(existsSync(join(folder.targetDir, STAGING))).toBe(false);
  });

  it("a file over 1 MiB is never 'same', even identical to its saved original; root does not block", () => {
    const folder = identicalFolder(`services:\n  orbit-app:\n    image: busybox\n${"# padding padding padding padding padding\n".repeat(30_000)}`);
    expect(statSync(join(folder.targetDir, "docker-compose.yml")).size).toBeGreaterThan(1024 * 1024);
    const shims = shimsFor(folder.targetDir);
    const result = restore(shims, folder);
    expect(result.hung).toBe(false);
    expect(result.stderr, "an oversized file was compared as the same").not.toMatch(SAME_LINE);
  });

  it("a symlink swapped in after the checks is never 'same'", () => {
    const folder = identicalFolder();
    const shims = shimsFor(folder.targetDir);
    const result = restore(shims, folder, { env: { PATH: `${swapStat(folder.targetDir, "symlink")}:${shims.env.PATH}` } });
    expect(result.hung).toBe(false);
    expect(result.stderr, "a symlink was compared as the same").not.toMatch(SAME_LINE);
  });

  it("a FIFO swapped in after the checks is never 'same' and root does not block", () => {
    const folder = identicalFolder();
    const shims = shimsFor(folder.targetDir);
    const result = restore(shims, folder, { env: { PATH: `${swapStat(folder.targetDir, "fifo")}:${shims.env.PATH}` } });
    expect(result.hung, "root blocked on a FIFO").toBe(false);
    expect(result.ms).toBeLessThan(BUDGET_MS);
    expect(result.stderr).not.toMatch(SAME_LINE);
  });

  // The compose file against the image's copy (diagnosis, --check).
  function composeIdentical() {
    const folder = composeFolder();
    writeFileSync(join(folder.targetDir, "docker-compose.yml"), IMAGE_COMPOSE, { mode: 0o644 });
    chmodSync(join(folder.targetDir, "docker-compose.yml"), 0o644);
    return folder;
  }

  /** A docker that swaps the folder's compose file when it is asked to read the image (after the file was checked, before the compare). */
  function swapDocker(folder, kind) {
    const dir = scratchDir("orbit-1875-docker-");
    const outside = scratchDir("orbit-1875-outside-");
    const target = join(folder.targetDir, "docker-compose.yml");
    const swap = kind === "symlink" ? `cp -- '${target}' '${outside}/copy' && rm -f -- '${target}' && ln -s '${outside}/copy' '${target}'` : `rm -f -- '${target}' && mkfifo '${target}'`;
    writeFileSync(join(dir, "docker"), `#!/usr/bin/env bash\nif [[ "$1" == run && ! -e '${outside}/swapped' ]]; then : > '${outside}/swapped'; ${swap}; fi\nexec '${join(folder.fakeBin, "docker")}' "$@"\n`);
    chmodSync(join(dir, "docker"), 0o755);
    return dir;
  }

  const check = (shims, folder, fakeBin) => runOwner(folder.targetDir, { shims, state: folder.state, fakeBin, env: { PATH: `${folder.fakeBin}:${shims.env.PATH}` }, args: ["--check"], capSeconds: 30 });
  const DRIFT = "finding class=compose-file-drift";
  const notRead = (result) => orbitLines(result).some((line) => /not a regular file|changed while it was being opened|was not read|too large/u.test(line));

  it("control: a compose file identical to the image's raises no drift", () => {
    const folder = composeIdentical();
    const shims = shimsFor(folder.targetDir);
    const result = check(shims, folder, folder.fakeBin);
    expect(result.stdout, result.stderr).not.toContain(DRIFT);
    expect(result.hung).toBe(false);
  });

  for (const kind of ["symlink", "fifo"]) {
    it(`a compose file swapped for a ${kind} before the compare is 'different' or 'cannot check', never 'same'; root does not block`, () => {
      const folder = composeIdentical();
      const shims = shimsFor(folder.targetDir);
      const result = check(shims, folder, swapDocker(folder, kind));
      expect(result.hung, "root blocked or never finished").toBe(false);
      expect(result.ms).toBeLessThan(BUDGET_MS);
      expect(result.stdout.includes(DRIFT) || notRead(result), `the swapped file was compared as the same:\n${result.stdout}\n${result.stderr.slice(0, 800)}`).toBe(true);
    });
  }
});

// --- W4: the checkpoint bundle without a bind mount ---------------------------------------------------------------------

describe("#1875 W4: the checkpoint bundle reaches the container on standard input, not through --volume", () => {
  /** A docker in front of the harness's own that copies the standard input of the decrypt call to a file. */
  function capture() {
    const dir = scratchDir("orbit-1875-capture-");
    const file = join(dir, "decrypt-stdin");
    writeFileSync(join(dir, "docker"), `#!/usr/bin/env bash\nPATH="\${PATH#'${dir}':}"\nif [[ "$*" == *decrypt* ]]; then tee '${file}' | docker "$@"; exit "\${PIPESTATUS[1]}"; fi\nexec docker "$@"\n`);
    chmodSync(join(dir, "docker"), 0o755);
    return { dir, file };
  }

  it("no recorded docker argument binds the folder or the bundle, and the bundle is on the decrypt call's standard input", () => {
    const folder = mismatchFolder();
    const shims = shimsFor(folder.targetDir);
    const { dir, file } = capture();
    const result = rotate(shims, folder, { fakeBin: dir });
    expect(result.stdout, result.stderr).toContain(DONE);
    const decrypts = result.argv.filter((line) => /\bdecrypt\b/u.test(line));
    expect(decrypts.length, `the bundle was never checked:\n${result.argv.join("\n")}`).toBeGreaterThan(0);
    const binds = result.argv.filter((line) => /--volume|\s-v\s/u.test(line) && (line.includes(folder.targetDir) || /orbit-repair-checkpoint|orbkek|postgres-password/u.test(line)));
    expect(binds, "the folder or the bundle was bind-mounted").toEqual([]);
    expect(existsSync(file), "nothing was read from the decrypt call's standard input").toBe(true);
    expect(readFileSync(file).includes("ORBKEK01"), "the bundle did not reach the decrypt call on standard input").toBe(true);
  });
});

// --- not root: unchanged ----------------------------------------------------------------------------------------------

describe("#1875: not root, nothing changes", () => {
  const notRoot = (targetDir) => shimsFor(targetDir, { root: false, setpriv: false, getent: "fail" });

  it("a rotation finishes, renames the staged password and removes its checkpoint as before", () => {
    const folder = mismatchFolder();
    const shims = notRoot(folder.targetDir);
    const result = rotate(shims, folder);
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(shims.setprivCalls()).toEqual([]);
    expect(readFileSync(join(folder.targetDir, ".orbit-secrets", "postgres-password"), "utf8").trim()).toMatch(HEX);
    expect(existsSync(join(folder.targetDir, ".orbit-secrets", ".repair-staged-postgres-password"))).toBe(false);
    expect(checkpointsIn(folder.targetDir)).toEqual([]);
  });

  it("a restore whose originals match the live files is skipped as changing nothing, as before", () => {
    const folder = identicalFolder();
    const result = runOwner(folder.targetDir, { shims: notRoot(folder.targetDir), state: folder.state, args: ["--execute", "--safe-only"], input: "y\n", capSeconds: 30 });
    expect(result.stderr, result.stdout).toMatch(/would change nothing/u);
  });

  it("a compose file identical to the image's raises no drift, as before", () => {
    const folder = composeFolder();
    writeFileSync(join(folder.targetDir, "docker-compose.yml"), IMAGE_COMPOSE, { mode: 0o644 });
    const shims = notRoot(folder.targetDir);
    const result = runOwner(folder.targetDir, { shims, state: folder.state, fakeBin: folder.fakeBin, args: ["--check"], capSeconds: 30 });
    expect(result.stdout, result.stderr).not.toContain("finding class=compose-file-drift");
    expect(result.hung).toBe(false);
  });
});

// --- W5 ---------------------------------------------------------------------------------------------------------------

describe("#1875 W5: guarantee 59 names these steps", () => {
  const text = readFileSync(new URL("../docs/installer-guarantees.md", import.meta.url), "utf8");
  const section = /^59\. `smtp-lines-retirable`.*$/mu.exec(text)?.[0] ?? "";

  it("the repair guarantee 59 (smtp-lines-retirable) is there", () => {
    expect(section).not.toBe("");
  });

  const passage = section;
  const WORDING = {
    "update-config's rename of the staged password is the owner's, with mv -T": /update-config[^;]*staged[^;]*(\bas the owner\b|owner's)[^;]*mv -T|update-config[^;]*mv -T[^;]*(\bas the owner\b|owner)/u,
    "the removal of old credential checkpoints is the owner's": /(removal|removes)[^;]*checkpoint[^;]*(\bas the owner\b|owner's)|checkpoint[^;]*(removal|removed)[^;]*(\bas the owner\b|by the owner)/u,
    "root's compares read the folder's file through the bounded no-follow read (regular files, 1 MiB, time limit)": /(compare|cmp)[^;]*(bounded|no-follow|no symlink)[^;]*1 MiB|(bounded|no-follow)[^;]*(compare|cmp)[^;]*1 MiB/u,
    "a file that fails the read is never 'same'": /never (counts as |treated as |compared as )?["`]?same/u,
    "the bundle check gets the bundle on standard input and no longer through --volume": /(standard input[^;]*bundle|bundle[^;]*standard input)[^;]*(--volume|bind mount)|(--volume|bind mount)[^;]*(standard input)/u,
  };
  for (const [what, re] of Object.entries(WORDING)) {
    it(what, () => {
      expect(passage).toMatch(re);
    });
  }
});
