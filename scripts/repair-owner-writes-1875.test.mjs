import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { IMAGE_COMPOSE, composeFolder, runOwner } from "./repair-owner-fixtures.mjs";
import { expectStalledStepsEnded, privShims, realTool } from "./repair-priv-shims.mjs";
import { makeFixture, scratchDir } from "./repair-test-harness.mjs";

// #1875 (spec W1-W5): run as root in a folder another user owns, update-config's rename of the staged password,
// the removal of old credential checkpoints, root's compares of files the owner controls and the checkpoint
// bundle's check run as the owner, through the bounded no-follow read, or not at all. Written from the spec
// alone, on the #1857 shims (simulated root; see repair-owner-writes-1872.test.mjs for how they work).

vi.setConfig({ testTimeout: 90_000 });

const PASSPHRASE = "correct-horse-battery-staple";
// #1933 (owner 77a): stall cases are judged by events, not by how long repair took; rotate()'s 60 s cap only
// catches a real hang. 5 s, not 2: the limit is every owner step's, and at 2 s a step before the stalled one could
// overrun on a loaded runner (the rename was then never reached). Flood cases stall nothing: default limit.
const STALL_SECONDS = 5;
const LIMIT = { ORBIT_REPAIR_OWNER_STEP_TIMEOUT: String(STALL_SECONDS) };
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

// --- CRC32 forging (#1875 W3): a different file with the same `cksum` -----------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n << 24;
  for (let k = 0; k < 8; k += 1) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  return c >>> 0;
});

/** POSIX cksum's CRC: the bytes, then the length (low byte first), then the complement. */
function cksumCrc(buf) {
  let crc = 0;
  const feed = (b) => {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  };
  for (const b of buf) feed(b);
  for (let len = buf.length; len > 0; len = Math.floor(len / 256)) feed(len & 0xff);
  return ~crc >>> 0;
}

/** `head` plus four bytes chosen so the whole has the CRC32 (and, being the same length, the cksum) of `target`: the CRC is affine over GF(2) in those bytes, so solve the 32x32 system. */
function forgeToCrc(head, target) {
  const build = (word) => Buffer.concat([head, Buffer.from([word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff])]);
  const base = cksumCrc(build(0));
  const rows = Array.from({ length: 32 }, () => 0n); // rows[out bit] = bitmask over input bits, bit 32 = right-hand side
  const want = BigInt((cksumCrc(target) ^ base) >>> 0);
  for (let i = 0; i < 32; i += 1) {
    const col = BigInt((cksumCrc(build((1 << i) >>> 0)) ^ base) >>> 0);
    for (let o = 0; o < 32; o += 1) if ((col >> BigInt(o)) & 1n) rows[o] |= 1n << BigInt(i);
  }
  for (let o = 0; o < 32; o += 1) if ((want >> BigInt(o)) & 1n) rows[o] |= 1n << 32n;
  for (let col = 0, r = 0; col < 32; col += 1) {
    const pivot = rows.findIndex((row, idx) => idx >= r && (row >> BigInt(col)) & 1n);
    if (pivot < 0) continue;
    [rows[r], rows[pivot]] = [rows[pivot], rows[r]];
    for (let k = 0; k < 32; k += 1) if (k !== r && (rows[k] >> BigInt(col)) & 1n) rows[k] ^= rows[r];
    r += 1;
  }
  let word = 0;
  for (let col = 0; col < 32; col += 1) {
    const row = rows.find((x) => (x & 0xffffffffn) === 1n << BigInt(col));
    if (row && (row >> 32n) & 1n) word |= 1 << col;
  }
  const forged = build(word >>> 0);
  if (cksumCrc(forged) !== cksumCrc(target)) throw new Error("CRC32 forge failed");
  return forged;
}

/** A different file of the same length and the same CRC32 as `original`: some bytes changed, the last four forged. */
const crcTwin = (original) => forgeToCrc(Buffer.concat([original.subarray(0, 30), Buffer.from("!changed bytes!"), original.subarray(45, original.length - 4)]), original);

const cksumOf = (buf) => spawnSync("cksum", [], { input: buf, encoding: "utf8" }).stdout.trim();

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
        const result = rotate(shims, folder, kind === "stop" ? { env: LIMIT } : {});
        expect(setprivNaming(shims, / -- mv\b.*repair-staged-postgres-password\s+\S*postgres-password$/u), "the rename never went through setpriv").not.toEqual([]);
        expectBounded(result, folder, reason);
        if (kind === "stop") expectStalledStepsEnded(shims.stalledSteps(), result, STALL_SECONDS);
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
        const result = rotate(shims, folder, kind === "stop" ? { env: LIMIT } : {});
        expect(setprivNaming(shims, / -- rm\b.*orbit-repair-checkpoint/u), "the removal never went through setpriv").not.toEqual([]);
        expectBounded(result, folder, reason);
        if (kind === "stop") expectStalledStepsEnded(shims.stalledSteps(), result, STALL_SECONDS);
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

  /** A restore whose live compose file differs from its saved original but has the same CRC32 and length. */
  function sameCksumFolder() {
    const original = Buffer.from(`services:\n  orbit-app:\n    image: busybox\n# ${"x".repeat(40)}\n`);
    const folder = identicalFolder(original);
    const live = join(folder.targetDir, "docker-compose.yml");
    const forged = crcTwin(original);
    expect(forged.length).toBe(original.length);
    expect(forged.equals(original), "the forged file is the original").toBe(false);
    expect(cksumOf(forged), "the forged file does not have the original's cksum").toBe(cksumOf(original));
    writeFileSync(live, forged);
    chmodSync(live, 0o644);
    expect(readFileSync(join(folder.targetDir, STAGING, "rollback", "original", "docker-compose.yml")).equals(original)).toBe(true);
    return { ...folder, original, forged };
  }

  it("a live file with the saved original's CRC32 and length is still different: the restore is not skipped (root)", () => {
    const folder = sameCksumFolder();
    const shims = shimsFor(folder.targetDir);
    const result = restore(shims, folder);
    expect(result.hung).toBe(false);
    expect(result.stderr, "a different file with the same cksum was compared as the same").not.toMatch(SAME_LINE);
    expect(existsSync(join(folder.targetDir, STAGING, "rollback")) || readFileSync(join(folder.targetDir, "docker-compose.yml")).equals(folder.original), "the restore neither ran nor was refused").toBe(true);
  });

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
    expect(orbitLines(result).filter((line) => /timed out/iu.test(line)), "root blocked until a step limit stopped it").toEqual([]);
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
      expect(orbitLines(result).filter((line) => /timed out/iu.test(line)), "root blocked until a step limit stopped it").toEqual([]);
      expect(result.stdout.includes(DRIFT) || notRead(result), `the swapped file was compared as the same:\n${result.stdout}\n${result.stderr.slice(0, 800)}`).toBe(true);
    });
  }
});

// --- W4: the checkpoint bundle is mounted from a private copy outside the folder -----------------------------------------

describe("#1875 W4: the checkpoint bundle is mounted from a private copy outside the folder", () => {
  const MOUNT = /(?:--volume|\s-v)[= ]([^:\s]+):\/recovery\/postgres-password\.enc/u;

  /** A docker in front of the harness's own that, on the decrypt call, records the mount's source, whether it exists then, and its mode. */
  function spy() {
    const dir = scratchDir("orbit-1875-spy-");
    const record = join(dir, "mount-record");
    writeFileSync(
      join(dir, "docker"),
      `#!/usr/bin/env bash\nPATH="\${PATH#'${dir}':}"\nif [[ "$*" == *decrypt* ]]; then\n  prev=""\n  for a in "$@"; do\n    case "$prev" in --volume|-v) src="\${a%%:*}"; { printf '%s\\n' "$src"; if [[ -f "$src" && ! -L "$src" ]]; then printf 'regular %s\\n' "$(stat -c %a -- "$src")"; else printf 'absent\\n'; fi; } >> '${record}';; esac\n    case "$a" in --volume=*) src="\${a#--volume=}"; src="\${src%%:*}"; { printf '%s\\n' "$src"; if [[ -f "$src" && ! -L "$src" ]]; then printf 'regular %s\\n' "$(stat -c %a -- "$src")"; else printf 'absent\\n'; fi; } >> '${record}';; esac\n    prev="$a"\n  done\nfi\nexec docker "$@"\n`,
    );
    chmodSync(join(dir, "docker"), 0o755);
    return { dir, record };
  }

  const decryptLines = (result) => result.argv.filter((line) => /\bdecrypt\b/u.test(line));
  const insideFolder = (path, folder) => [folder.targetDir, realpathSync(folder.targetDir)].some((root) => path === root || path.startsWith(`${root}/`));

  it("no --volume or -v source of repair's decrypt call is inside the deployment folder", () => {
    const folder = mismatchFolder();
    const shims = shimsFor(folder.targetDir);
    const result = rotate(shims, folder, { fakeBin: spy().dir });
    expect(result.stdout, result.stderr).toContain(DONE);
    const decrypts = decryptLines(result);
    expect(decrypts.length, `the bundle was never checked:\n${result.argv.join("\n")}`).toBeGreaterThan(0);
    const inside = decrypts.filter((line) => {
      const source = MOUNT.exec(line)?.[1];
      return source === undefined ? /orbit-repair-checkpoint|orbkek/u.test(line) || line.includes(folder.targetDir) : insideFolder(source, folder);
    });
    expect(inside, "the decrypt call mounts a path inside the owner's folder").toEqual([]);
  });

  it("the mounted source is a private (mode 600) file outside the folder and is gone after the run", () => {
    const folder = mismatchFolder();
    const shims = shimsFor(folder.targetDir);
    const { dir, record } = spy();
    const result = rotate(shims, folder, { fakeBin: dir });
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(existsSync(record), "the decrypt call mounted no bundle at /recovery/postgres-password.enc").toBe(true);
    const [source, state] = readFileSync(record, "utf8").split("\n");
    expect(insideFolder(source, folder), `the mounted source ${source} is inside the folder`).toBe(false);
    expect(state, "the mounted source was not a regular file when docker ran").toMatch(/^regular 600$/u);
    expect(existsSync(source), "the private copy was left behind").toBe(false);
  });

  /** A `stat` that, once repair has looked at the checkpoint bundle, swaps it for a symlink or a FIFO. */
  function swapBundle(kind) {
    const dir = scratchDir("orbit-1875-bundle-stat-");
    const outside = scratchDir("orbit-1875-outside-");
    const swap = kind === "symlink" ? `cp -- "$last" '${outside}/copy' && rm -f -- "$last" && ln -s '${outside}/copy' "$last"` : `rm -f -- "$last" && mkfifo "$last"`;
    writeFileSync(
      join(dir, "stat"),
      `#!/usr/bin/env bash\nout="$('${realTool("stat")}' "$@")" || exit $?\nlast="\${@: -1}"\ncase "$last" in */.orbit-repair-checkpoint.*/postgres-password.orbkek) if [[ ! -e '${outside}/swapped' ]]; then : > '${outside}/swapped'; ${swap}; fi;; esac\nprintf '%s\\n' "$out"\n`,
    );
    chmodSync(join(dir, "stat"), 0o755);
    return dir;
  }

  for (const kind of ["symlink", "fifo"]) {
    it(`a ${kind} swapped in at the bundle path gives 'cannot check', never a pass; root does not block`, () => {
      const folder = mismatchFolder();
      const shims = shimsFor(folder.targetDir);
      const { dir, record } = spy();
      const result = rotate(shims, folder, { fakeBin: dir, env: { PATH: `${swapBundle(kind)}:${shims.env.PATH}` } });
      expect(result.hung, "root blocked on the bundle").toBe(false);
      expect(orbitLines(result).filter((line) => /timed out/iu.test(line)), "root blocked until a step limit stopped it").toEqual([]);
      expect(result.stdout, "the swapped bundle passed the check and the rotation finished").not.toContain(DONE);
      expect(orbitLines(result).some((line) => /cannot check|could not check|not a regular file|changed while it was being opened|was not read|failed verification/u.test(line)), `no line says the bundle could not be checked:\n${result.stderr.slice(0, 1200)}`).toBe(true);
      expect(existsSync(record) ? readFileSync(record, "utf8") : "", "docker was still given a mount for the swapped bundle").toBe("");
    });
  }
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

  it("a live file with the saved original's CRC32 and length is still different: the restore is not skipped", () => {
    const original = Buffer.from(`services:\n  orbit-app:\n    image: busybox\n# ${"x".repeat(40)}\n`);
    const folder = identicalFolder(original);
    const live = join(folder.targetDir, "docker-compose.yml");
    const forged = crcTwin(original);
    expect(cksumOf(forged)).toBe(cksumOf(original));
    expect(forged.equals(original)).toBe(false);
    writeFileSync(live, forged);
    chmodSync(live, 0o644);
    const result = runOwner(folder.targetDir, { shims: notRoot(folder.targetDir), state: folder.state, args: ["--execute", "--safe-only"], input: "y\n", capSeconds: 30 });
    expect(result.stderr, "a different file with the same cksum was compared as the same").not.toMatch(/would change nothing/u);
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
    "the bundle check mounts a private copy outside the folder": /bundle[^;]*(private|temporary) (copy|file)[^;]*outside (the|that|this) (deployment )?folder|(private|temporary) (copy|file)[^;]*outside[^;]*folder[^;]*bundle|bundle[^;]*mounted[^;]*(private|temporary) (copy|file)/u,
  };
  for (const [what, re] of Object.entries(WORDING)) {
    it(what, () => {
      expect(passage).toMatch(re);
    });
  }
});
