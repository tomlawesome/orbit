import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { mailFolder, runOwner } from "./repair-owner-fixtures.mjs";
import { expectStalledStepsEnded, privShims, realTool } from "./repair-priv-shims.mjs";
import { makeFixture, scratchDir } from "./repair-test-harness.mjs";

// #1887 (spec R1-R4): run as root in a folder another user owns, the directory branch of
// restore_transaction_originals_match_live runs `diff -r` as the owner under the owner-step timeout (never as root),
// and smtp_env_sum reads .env-orbit through the bounded no-follow read and digests it with SHA-256 (never `cksum`).
// A failed or timed-out read means "cannot check", never "same". Not root: unchanged, except SHA-256 for the sum.
// Written from the spec alone, on the #1857 shims (simulated root; see repair-owner-writes-1872.test.mjs).

vi.setConfig({ testTimeout: 90_000 });

// #1933 (owner 77a): a stall case is judged by its events, not by how long repair took; restore()'s 40 s cap only
// catches a real hang. 5 s, not 2: the limit is every owner step's, and at 2 s a step that does not stall could
// overrun on a loaded runner (#1928). The flood case stalls nothing and runs under the default limit.
const STALL_SECONDS = 5;
const LIMIT = { ORBIT_REPAIR_OWNER_STEP_TIMEOUT: String(STALL_SECONDS) };
const RUNNING = { db: "running", app: "running" };
const SAME_LINE = /would change nothing/u;
const MAIL_DONE = "execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done";
const STAGING = ".orbit-install-staging.abc123";
const MANAGED = ["docker-compose.yml", "docker-compose.mail.yml", ".env-orbit.example", "config/tika-config.json", "scripts/configure.sh", "scripts/installer-ui.sh", "scripts/backup.sh", "scripts/restore.sh", "scripts/repair.sh", "update.sh", ".env-orbit", ".orbit-secrets", ".orbit-files"];
const DIFF_AS_OWNER = /-- diff\b/u;

const shimsFor = (targetDir, options = {}) => privShims(targetDir, { extraTools: ["diff", "cksum", "sha256sum"], ...options });
const notRoot = (targetDir) => shimsFor(targetDir, { root: false, setpriv: false, getent: "fail" });
const orbitLines = (result) => result.stderr.split("\n").filter((line) => line.startsWith("Orbit repair:"));
const setprivNaming = (shims, re) => shims.setprivCalls().filter((line) => re.test(line));
/** Calls root itself (marker=0) made to `tool`; with `underOnly`, only those that name a path in the folder. */
const rootCalls = (shims, tool, underOnly = false) => shims.toolCalls().filter((line) => line.startsWith(`${tool} `) && / marker=0 /u.test(line) && (!underOnly || / under=1 /u.test(line)));

/** A staging folder whose saved originals are every managed file the folder has, byte for byte and mode for mode (a restore would change nothing); .orbit-secrets is the directory the compare walks. */
function identicalFolder() {
  const targetDir = makeFixture();
  const staging = join(targetDir, STAGING);
  const original = join(staging, "rollback", "original");
  mkdirSync(original, { recursive: true, mode: 0o700 });
  for (const dir of [staging, join(staging, "rollback"), original]) chmodSync(dir, 0o700);
  const present = MANAGED.filter((path) => existsSync(join(targetDir, path)));
  const copied = spawnSync("cp", ["-a", "--parents", ...present, original], { cwd: targetDir, encoding: "utf8" });
  if (copied.status !== 0) throw new Error(copied.stderr);
  return { targetDir, state: { ...RUNNING } };
}

const restore = (shims, folder, options = {}) => runOwner(folder.targetDir, { shims, state: folder.state, args: ["--execute", "--safe-only"], input: "y\n", capSeconds: 40, ...options });

// --- R1: the directory compare ----------------------------------------------------------------------------------------

describe("#1887 R1: the directory compare runs diff -r as the owner, under the owner-step timeout", () => {
  it("an identical tree is 'same'; diff ran as the owner (setpriv) and root ran none", () => {
    const folder = identicalFolder();
    const shims = shimsFor(folder.targetDir);
    const result = restore(shims, folder);
    expect(result.stderr, result.stdout).toMatch(SAME_LINE);
    expect(setprivNaming(shims, DIFF_AS_OWNER), "diff -r never went through setpriv").not.toEqual([]);
    expect(rootCalls(shims, "diff"), "root ran diff over the owner's tree").toEqual([]);
  });

  it("a FIFO in the owner's tree (saved and live) is never 'same'; bounded; root runs no diff", () => {
    const folder = identicalFolder();
    for (const base of [folder.targetDir, join(folder.targetDir, STAGING, "rollback", "original")]) {
      expect(spawnSync("mkfifo", [join(base, ".orbit-secrets", "pipe")]).status).toBe(0);
    }
    const shims = shimsFor(folder.targetDir);
    const result = restore(shims, folder, { env: LIMIT });
    expect(result.hung, "root blocked on a FIFO").toBe(false);
    expect(result.stderr, "a tree holding a FIFO was compared as the same").not.toMatch(SAME_LINE);
    expect(rootCalls(shims, "diff"), "root ran diff over the owner's tree").toEqual([]);
  });

  for (const [kind, reason] of [["stop", /timed out/iu], ["flood", /./u]]) {
    it(`a diff that ${kind === "stop" ? "stalls gets TERM and is timed out" : "floods its output fails"}: 'cannot check', never 'same', root runs no diff`, () => {
      const folder = identicalFolder();
      const shims = shimsFor(folder.targetDir, { variant: { kind, match: '*" -- diff "*' } });
      try {
        const result = restore(shims, folder, kind === "stop" ? { env: LIMIT } : {});
        expect(setprivNaming(shims, DIFF_AS_OWNER), "diff -r never went through setpriv").not.toEqual([]);
        expect(result.hung, "repair was still running after the test's own cap").toBe(false);
        if (kind === "stop") expectStalledStepsEnded(shims.stalledSteps(), result, STALL_SECONDS);
        expect(result.stderr, "a diff that did not finish was compared as the same").not.toMatch(SAME_LINE);
        expect(orbitLines(result).some((line) => reason.test(line)), `no 'Orbit repair:' line ${reason}:\n${result.stderr.slice(0, 1200)}`).toBe(true);
        expect(rootCalls(shims, "diff"), "root ran diff over the owner's tree").toEqual([]);
      } finally {
        shims.cleanup();
      }
    });
  }

  it("a diff that fails as the owner (unreadable entry, any error) is 'cannot check', never 'same'", () => {
    const folder = identicalFolder();
    const shims = shimsFor(folder.targetDir, { setprivFail: '*" -- diff "*' });
    const result = restore(shims, folder);
    expect(setprivNaming(shims, DIFF_AS_OWNER), "diff -r never went through setpriv").not.toEqual([]);
    expect(result.stderr, "a failed diff was compared as the same").not.toMatch(SAME_LINE);
    expect(rootCalls(shims, "diff"), "root ran diff over the owner's tree").toEqual([]);
  });
});

// --- CRC32 forging (as in repair-owner-writes-1875.test.mjs): a different file with the same `cksum` ----------------------

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

/** `head` plus four bytes chosen so the whole has the cksum of `target` (the CRC is affine over GF(2) in those bytes). */
function forgeToCrc(head, target) {
  const build = (word) => Buffer.concat([head, Buffer.from([word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff])]);
  const base = cksumCrc(build(0));
  const rows = Array.from({ length: 32 }, () => 0n);
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

const printable = (buf) => buf.every((b) => b >= 0x21 && b <= 0x7e);
const cksumOf = (buf) => spawnSync("cksum", [], { input: buf, encoding: "utf8" }).stdout.trim();

/** Two .env-orbit files of one length and one cksum that differ: the original ends in a comment line, and the twin's last four bytes are forged (printable, so the file stays a valid env file). */
function envTwins(base) {
  const original = Buffer.concat([base, Buffer.from("# pad: aaaaaaaaaaaaaaaa abcd")]);
  for (let i = 0; i < 20_000; i += 1) {
    const head = Buffer.concat([base, Buffer.from(`# pad: ${i.toString(36).padStart(16, "b")} `)]);
    const twin = forgeToCrc(head, original);
    if (printable(twin.subarray(twin.length - 4))) {
      expect(twin.equals(original)).toBe(false);
      expect(cksumOf(twin)).toBe(cksumOf(original));
      return { original, twin };
    }
  }
  throw new Error("no printable CRC twin found");
}

// --- R2 (and R3's SHA-256): smtp_env_sum --------------------------------------------------------------------------------

describe("#1887 R2: smtp_env_sum reads .env-orbit through the bounded read and digests it with SHA-256", () => {
  const run = (shims, targetDir, options = {}) => runOwner(targetDir, { shims, state: RUNNING, capSeconds: 25, ...options });
  const envPath = (targetDir) => join(targetDir, ".env-orbit");

  /** A `grep` that, once repair has asked whether .env-orbit still has SMTP lines (the call just before its first sum), swaps .env-orbit for a symlink or a FIFO. */
  function swapGrep(targetDir, kind) {
    const dir = scratchDir("orbit-1887-grep-");
    const outside = scratchDir("orbit-1887-outside-");
    writeFileSync(join(outside, "root-only"), "ROOT-ONLY-SECRET=1\n", { mode: 0o600 });
    const swap = kind === "symlink" ? `rm -f -- .env-orbit && ln -s '${outside}/root-only' .env-orbit` : "rm -f -- .env-orbit && mkfifo .env-orbit";
    writeFileSync(
      join(dir, "grep"),
      `#!/usr/bin/env bash\n'${realTool("grep")}' "$@"; rc=$?\ncase "$*" in *'^SMTP_(HOST'*.env-orbit) n=$(( $(cat '${outside}/n' 2>/dev/null || echo 0) + 1 )); echo $n > '${outside}/n'; [[ $n == 2 ]] && { ${swap}; };; esac\nexit $rc\n`,
    );
    chmodSync(join(dir, "grep"), 0o755);
    return dir;
  }

  it("an unchanged .env-orbit is retired; root's sum is a SHA-256 (sha256sum ran, cksum did not)", () => {
    const targetDir = mailFolder();
    const shims = shimsFor(targetDir);
    const result = run(shims, targetDir);
    expect(result.stdout, result.stderr).toContain(MAIL_DONE);
    expect(rootCalls(shims, "cksum"), "root still sums .env-orbit with cksum").toEqual([]);
    expect(rootCalls(shims, "sha256sum"), "no SHA-256 of .env-orbit was made").not.toEqual([]);
  });

  for (const kind of ["symlink", "fifo"]) {
    it(`a .env-orbit swapped for a ${kind} before the sum is not read through by root: refused, bounded, no cksum`, () => {
      const targetDir = mailFolder();
      const shims = shimsFor(targetDir);
      const result = run(shims, targetDir, { env: { PATH: `${swapGrep(targetDir, kind)}:${shims.env.PATH}` }, capSeconds: 30 });
      expect(result.hung, "root blocked on .env-orbit").toBe(false);
      expect(orbitLines(result).filter((line) => /timed out/iu.test(line)), "root blocked until a step limit stopped it").toEqual([]);
      expect(result.stdout, "the swapped file was retired").not.toContain(MAIL_DONE);
      expect(rootCalls(shims, "cksum"), "root ran cksum on the swapped .env-orbit").toEqual([]);
      expect(orbitLines(result).some((line) => /not a regular file|not read|refused/u.test(line)), `no refusal line:\n${result.stderr.slice(0, 1200)}`).toBe(true);
    });
  }

  it("a .env-orbit over 1 MiB is refused as too large to read: no cksum, not retired", () => {
    const targetDir = mailFolder();
    // Over 1 MiB as 1,100 comment lines of about 1 KiB, not one 1.1 MB line: repair's per-line checks of .env-orbit
    // before the sum (environment_file_ok_now's regex) took 12 s or more on one such line, so the run's 25 s cap
    // timed those checks rather than the bounded read under test. The read still sees a file over 1 MiB.
    writeFileSync(envPath(targetDir), `${readFileSync(envPath(targetDir), "utf8")}${`# ${"padding ".repeat(125)}\n`.repeat(1_100)}`, { mode: 0o600 });
    expect(readFileSync(envPath(targetDir)).length).toBeGreaterThan(1024 * 1024);
    chmodSync(envPath(targetDir), 0o600);
    const shims = shimsFor(targetDir);
    const result = run(shims, targetDir);
    expect(result.hung).toBe(false);
    expect(result.stdout).not.toContain(MAIL_DONE);
    expect(rootCalls(shims, "cksum"), "root ran cksum on an oversized .env-orbit").toEqual([]);
    expect(orbitLines(result).some((line) => /too large|not read|refused/u.test(line)), `no refusal line:\n${result.stderr.slice(0, 1200)}`).toBe(true);
  });

  /** A cksum and a sha256sum in front of the harness's: right after the first sum of .env-orbit (read on stdin; cksum before #1887, sha256sum after), .env-orbit is replaced in place by `twin`, a different file with the same length and cksum. */
  function swapAfterSum(targetDir, twin) {
    const dir = scratchDir("orbit-1887-sum-");
    const outside = scratchDir("orbit-1887-twin-");
    writeFileSync(join(outside, "twin"), twin);
    for (const tool of ["cksum", "sha256sum"]) {
      writeFileSync(
        join(dir, tool),
        `#!/usr/bin/env bash\n'${realTool(tool)}' "$@"; rc=$?\nif [[ $# -eq 0 && ! -e '${outside}/done' ]]; then : > '${outside}/done'; cat '${outside}/twin' > '${join(targetDir, ".env-orbit")}'; fi\nexit $rc\n`,
      );
      chmodSync(join(dir, tool), 0o755);
    }
    return dir;
  }

  function twinFolder() {
    const targetDir = mailFolder();
    const { original, twin } = envTwins(readFileSync(envPath(targetDir)));
    writeFileSync(envPath(targetDir), original, { mode: 0o600 });
    chmodSync(envPath(targetDir), 0o600);
    return { targetDir, twin };
  }

  it("a .env-orbit swapped for a different file with the same CRC32 and length counts as changed (root)", () => {
    const { targetDir, twin } = twinFolder();
    const shims = shimsFor(targetDir);
    const result = run(shims, targetDir, { env: { PATH: `${swapAfterSum(targetDir, twin)}:${shims.env.PATH}` } });
    expect(result.hung).toBe(false);
    expect(result.stdout, "a same-cksum swap was counted as unchanged and the file retired").not.toContain(MAIL_DONE);
    expect(orbitLines(result).some((line) => /changed while it was being (read|rewritten)/u.test(line)), `no 'changed' line:\n${result.stderr.slice(0, 1200)}`).toBe(true);
    expect(readFileSync(envPath(targetDir)).equals(twin), ".env-orbit was overwritten").toBe(true);
  });
});

// --- R3: not root -----------------------------------------------------------------------------------------------------

describe("#1887 R3: not root, nothing changes except that the env sum is a SHA-256", () => {
  it("a restore whose saved tree matches the live one is skipped as changing nothing, with diff run directly (pin)", () => {
    const folder = identicalFolder();
    const shims = notRoot(folder.targetDir);
    const result = restore(shims, folder);
    expect(result.stderr, result.stdout).toMatch(SAME_LINE);
    expect(shims.setprivCalls()).toEqual([]);
    expect(existsSync(join(folder.targetDir, STAGING))).toBe(false);
  });

  it("a restore whose live tree differs from the saved one is not skipped (pin)", () => {
    const folder = identicalFolder();
    writeFileSync(join(folder.targetDir, ".orbit-secrets", "session-secret"), `${"b".repeat(64)}\n`, { mode: 0o600 });
    const result = restore(notRoot(folder.targetDir), folder);
    expect(result.hung).toBe(false);
    expect(result.stderr).not.toMatch(SAME_LINE);
  });

  it("retire-smtp-lines retires an unchanged .env-orbit as before (pin)", () => {
    const targetDir = mailFolder();
    const shims = notRoot(targetDir);
    const result = runOwner(targetDir, { shims, state: RUNNING, capSeconds: 25 });
    expect(result.stdout, result.stderr).toContain(MAIL_DONE);
    expect(shims.setprivCalls()).toEqual([]);
  });

  it("the env sum is a SHA-256: sha256sum ran on .env-orbit and cksum did not", () => {
    const targetDir = mailFolder();
    const shims = notRoot(targetDir);
    const result = runOwner(targetDir, { shims, state: RUNNING, capSeconds: 25 });
    expect(result.stdout, result.stderr).toContain(MAIL_DONE);
    expect(rootCalls(shims, "cksum"), "the sum still uses cksum").toEqual([]);
    expect(rootCalls(shims, "sha256sum"), "no SHA-256 of .env-orbit was made").not.toEqual([]);
  });
});
