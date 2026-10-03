import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard, processWatchdog } from "./process-budget.mjs";

// Findings fixed here (GitLab issue #1151):
//   - SS1-S3: refuse while a document-KEK rotation is open
//     (.orbit-secrets/document-kek-next present), before ever touching the
//     live key.
//   - O2-R1: a Ctrl-C or dropped session between the two `mv` calls that
//     swap the live document-kek for the recovered one must not leave
//     `key_replaced=false` — the EXIT trap (cleanup) must still restore the
//     live key from its own private copy, and must never delete the
//     temporary directory while it is the only remaining copy of a key.
//
// This suite runs the real scripts/import-recovery-bundle.sh under bash,
// from a copied fixture in a scratch directory, with a fake `docker` ahead
// of the real one on PATH (mirroring repair.test.mjs's own convention) so
// no real daemon, container, or crypto image is ever required. The fake
// docker answers the one `compose run ... recovery-crypto.mjs decrypt ...`
// call with a FIXED, valid-looking 64-hex value rather than dispatching to
// the real recovery-crypto.mjs — these tests are about the key-swap and
// preflight logic, not about decryption itself.

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const scriptSource = readFileSync(join(scriptsDir, "import-recovery-bundle.sh"), "utf8");

const scratchDirs = [];
afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-import-recovery-"));
  scratchDirs.push(dir);
  return dir;
}

const ORIGINAL_KEK = "a".repeat(64);
const RECOVERED_KEK = "b".repeat(64);
const PASSPHRASE = "correct-horse-battery-staple";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

// A real fixed-format recovery bundle (checksums.sha256, document-kek.enc,
// manifest, orbit-backup.tar) the script's own preflight (tar listing,
// link/special-file scan, checksum verification, format_version) genuinely
// accepts — document-kek.enc's bytes never matter beyond that, since the
// fake docker below answers the decrypt call with a fixed value regardless
// of input.
function makeRecoveryBundle(dir) {
  const contentsDir = mkdtempSync(join(tmpdir(), "orbit-recovery-bundle-contents-"));
  scratchDirs.push(contentsDir);
  const files = {
    "document-kek.enc": "fake-encrypted-kek-bytes\n",
    manifest: "format_version=1\n",
    "orbit-backup.tar": "fake-inner-backup-bytes\n",
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(contentsDir, name), content);
  }
  const checksums = Object.entries(files)
    .map(([name, content]) => `${sha256(content)}  ${name}`)
    .join("\n") + "\n";
  writeFileSync(join(contentsDir, "checksums.sha256"), checksums);

  const bundlePath = join(dir, "recovery.tar");
  const result = spawnSync(
    "tar",
    ["-cf", bundlePath, "-C", contentsDir, "checksums.sha256", "document-kek.enc", "manifest", "orbit-backup.tar"],
    { encoding: "utf8" },
  );
  expect(result.status, `tar failed: ${result.stderr}`).toBe(0);
  return bundlePath;
}

// Builds a target directory with the real import-recovery-bundle.sh, a
// controllable fake scripts/restore.sh (restore.sh's own logic is out of
// scope here — see the task brief), a minimal .env-orbit, and a
// .orbit-secrets holding a regular, mode-600 document-kek.
function makeFixture({ restoreBehavior = "succeed", documentKekNext = null } = {}) {
  const targetDir = scratchDir();
  mkdirSync(join(targetDir, "scripts"));
  writeFileSync(join(targetDir, "scripts", "import-recovery-bundle.sh"), scriptSource);
  chmodSync(join(targetDir, "scripts", "import-recovery-bundle.sh"), 0o755);

  // restoreBehavior:
  //   "succeed"       - exits 0 (the happy path)
  //   "fail-no-journal" - exits 1, writes nothing (ordinary failure)
  //   anything else is written verbatim as the fake restore.sh body, for
  //   the one test that needs restore.sh to never even run.
  const restoreScripts = {
    succeed: "#!/usr/bin/env bash\nexit 0\n",
    "fail-no-journal": "#!/usr/bin/env bash\nexit 1\n",
  };
  writeFileSync(
    join(targetDir, "scripts", "restore.sh"),
    restoreScripts[restoreBehavior] ?? restoreBehavior,
  );
  chmodSync(join(targetDir, "scripts", "restore.sh"), 0o755);

  writeFileSync(join(targetDir, ".env-orbit"), "COMPOSE_PROJECT_NAME=importrecoverytest\n");
  chmodSync(join(targetDir, ".env-orbit"), 0o600);

  mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
  writeFileSync(join(targetDir, ".orbit-secrets", "document-kek"), ORIGINAL_KEK + "\n");
  chmodSync(join(targetDir, ".orbit-secrets", "document-kek"), 0o600);
  if (documentKekNext) {
    writeFileSync(join(targetDir, ".orbit-secrets", "document-kek-next"), documentKekNext + "\n");
    chmodSync(join(targetDir, ".orbit-secrets", "document-kek-next"), 0o600);
  }

  return targetDir;
}

// A fake `docker` answering exactly the three invocations
// import-recovery-bundle.sh issues: `compose ... stop orbit-app`,
// `compose ... start orbit-app`, and `compose ... run ... recovery-crypto.mjs
// decrypt ...` (answered with a fixed value, never dispatched to the real
// script — see the file header).
function makeFakeBin({ stopFails = false } = {}) {
  const binDir = mkdtempSync(join(tmpdir(), "orbit-import-recovery-fakebin-"));
  scratchDirs.push(binDir);
  const script = [
    "#!/usr/bin/env bash",
    'if [[ "${1:-}" == "compose" ]]; then',
    '  args=("$@")',
    '  is_run=0; is_stop=0; is_start=0',
    '  for a in "${args[@]}"; do',
    '    [[ "$a" == "run" ]] && is_run=1',
    '    [[ "$a" == "stop" ]] && is_stop=1',
    '    [[ "$a" == "start" ]] && is_start=1',
    "  done",
    '  if [[ "$is_run" == 1 ]]; then',
    `    printf '%s' '${RECOVERED_KEK}'`,
    "    exit 0",
    "  fi",
    stopFails ? '  if [[ "$is_stop" == 1 ]]; then exit 1; fi' : "  true",
    '  if [[ "$is_stop" == 1 || "$is_start" == 1 ]]; then exit 0; fi',
    "  exit 0",
    "fi",
    "exit 1",
  ].join("\n");
  writeFileSync(join(binDir, "docker"), script);
  chmodSync(join(binDir, "docker"), 0o755);
  return binDir;
}

function runImport(targetDir, bundlePath, dockerOptions = {}, { input, env } = {}) {
  const binDir = makeFakeBin(dockerOptions);
  return failOnProcessDeadline(
    spawnSync("bash", [join(targetDir, "scripts", "import-recovery-bundle.sh"), bundlePath], {
      cwd: targetDir,
      encoding: "utf8",
      input,
      env: { PATH: `${binDir}:${process.env.PATH}`, HOME: process.env.HOME ?? tmpdir(), ...env },
      ...processGuard(),
    }),
    { label: "runImport" },
  );
}

const happyPathInput = `${PASSPHRASE}\nIMPORT RECOVERY\n`;
const happyPathEnv = { ORBIT_RECOVERY_TEST_MODE: "true" };

describe("scripts/import-recovery-bundle.sh: baseline", () => {
  it("completes successfully: live key replaced, old key cleaned up, staging removed", () => {
    const targetDir = makeFixture({ restoreBehavior: "succeed" });
    const bundlePath = makeRecoveryBundle(targetDir);

    const result = runImport(targetDir, bundlePath, {}, { input: happyPathInput, env: happyPathEnv });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("completed successfully");
    expect(readFileSync(join(targetDir, ".orbit-secrets", "document-kek"), "utf8").trim()).toBe(RECOVERED_KEK);
    expect(readdirSync(targetDir).some((name) => name.startsWith("orbit-recovery-import."))).toBe(false);
  });

  it("reverts the live key and reports failure when the inner restore fails with no durable evidence", () => {
    const targetDir = makeFixture({ restoreBehavior: "fail-no-journal" });
    const bundlePath = makeRecoveryBundle(targetDir);

    const result = runImport(targetDir, bundlePath, {}, { input: happyPathInput, env: happyPathEnv });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the previous document key was restored");
    expect(readFileSync(join(targetDir, ".orbit-secrets", "document-kek"), "utf8").trim()).toBe(ORIGINAL_KEK);
  });
});

// --- SS1-S3: refuse while a document-KEK rotation is open ------------------

describe("scripts/import-recovery-bundle.sh: SS1-S3 (#1151) — open document-KEK rotation", () => {
  it("refuses outright when .orbit-secrets/document-kek-next is present, before touching anything", () => {
    const targetDir = makeFixture({ restoreBehavior: "succeed", documentKekNext: "c".repeat(64) });
    const bundlePath = makeRecoveryBundle(targetDir);

    const result = runImport(targetDir, bundlePath, {}, { input: happyPathInput, env: happyPathEnv });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("a document-KEK rotation is open");
    // Names how to finish or abort it, per the task brief.
    expect(result.stderr).toContain("rewrap-kek");
    expect(result.stderr).toContain("docker-compose.kek-rotation.yml");
    // Refused before the live key was ever touched.
    expect(readFileSync(join(targetDir, ".orbit-secrets", "document-kek"), "utf8").trim()).toBe(ORIGINAL_KEK);
  });

  it("proceeds normally once the rotation evidence is gone", () => {
    const targetDir = makeFixture({ restoreBehavior: "succeed" }); // no document-kek-next
    const bundlePath = makeRecoveryBundle(targetDir);

    const result = runImport(targetDir, bundlePath, {}, { input: happyPathInput, env: happyPathEnv });

    expect(result.status).toBe(0);
  });
});

// --- O2-R1: atomic swap from cleanup's point of view ------------------------

// Spawns import-recovery-bundle.sh with a shimmed `mv` ahead of the real one:
// the shim runs the REAL mv, and if this is specifically the FIRST of the
// two key-swap renames (its destination is "previous-document-kek" — the
// second rename's destination is the live document-kek path, which does not
// match), it sleeps before returning. That holds the process open exactly
// in the window between the two renames, long enough for the test to detect
// the first rename's on-disk side effect and send SIGTERM — a deterministic
// trigger on the precondition itself, never a fixed guess at timing (the
// same technique repair.test.mjs's own EXIT-trap signal tests use).
function makeSlowMvShim(dockerBinDir) {
  const shimDir = mkdtempSync(join(tmpdir(), "orbit-import-recovery-mv-shim-"));
  scratchDirs.push(shimDir);
  writeFileSync(
    join(shimDir, "mv"),
    [
      "#!/usr/bin/env bash",
      '/bin/mv "$@"; rc=$?',
      'for a in "$@"; do',
      '  case "$a" in',
      "    *previous-document-kek) sleep 2 ;;",
      "  esac",
      "done",
      'exit "$rc"',
    ].join("\n"),
    { mode: 0o755 },
  );
  return `${shimDir}:${dockerBinDir}`;
}

function spawnImport(targetDir, bundlePath, pathPrefix, env) {
  const child = spawn("bash", [join(targetDir, "scripts", "import-recovery-bundle.sh"), bundlePath], {
    cwd: targetDir,
    env: { PATH: `${pathPrefix}:${process.env.PATH}`, HOME: process.env.HOME ?? tmpdir(), ...env },
  });
  let stdout = "";
  let stderr = "";
  const watchdog = processWatchdog({ label: "spawnImport", kill: () => child.kill("SIGKILL") });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    watchdog.touch();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    watchdog.touch();
  });
  const exited = new Promise((resolve) => {
    child.on("close", (status, signal) => {
      watchdog.stop();
      resolve({ status, signal });
    });
  });
  return { child, exited, stdoutSoFar: () => stdout, stderrSoFar: () => stderr };
}

describe("scripts/import-recovery-bundle.sh: O2-R1 (#1151) — interrupted between the two key renames", () => {
  it("SIGTERM between the two renames still restores the live key, and never deletes its only remaining copy", async () => {
    const targetDir = makeFixture({ restoreBehavior: "succeed" });
    const bundlePath = makeRecoveryBundle(targetDir);
    const dockerBinDir = makeFakeBin({});
    const pathPrefix = makeSlowMvShim(dockerBinDir);

    const spawned = spawnImport(targetDir, bundlePath, pathPrefix, happyPathEnv);
    spawned.child.stdin.write(happyPathInput);

    try {
      // The first rename has landed exactly when the live document-kek path
      // no longer exists (moved to previous-document-kek inside the
      // temporary directory) — poll for that, then signal while the shim is
      // still holding the process open.
      const deadline = Date.now() + 10_000;
      let windowReached = false;
      while (Date.now() < deadline) {
        const stillLive = readdirSync(join(targetDir, ".orbit-secrets")).includes("document-kek");
        if (!stillLive) {
          windowReached = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(windowReached, "never observed the live key missing mid-swap").toBe(true);

      spawned.child.kill("SIGTERM");
      const { signal } = await failOnProcessDeadline(spawned.exited, { label: "import-recovery-bundle SIGTERM" });
      expect(signal).toBe("SIGTERM");
    } finally {
      spawned.child.stdin.end();
    }

    // The live key must be back — restored from the temporary directory's
    // own copy by cleanup's EXIT trap — with its ORIGINAL content, never
    // left missing and never left on the recovered (never-applied) value.
    const liveKek = readFileSync(join(targetDir, ".orbit-secrets", "document-kek"), "utf8").trim();
    expect(liveKek).toBe(ORIGINAL_KEK);

    // And the temporary directory that held the only remaining copy of the
    // old key during the swap must be gone now that the restore succeeded
    // — cleanup removes it once the key is safely back, not before.
    expect(readdirSync(targetDir).some((name) => name.startsWith("orbit-recovery-import."))).toBe(false);
  }, PROCESS_TEST_TIMEOUT_MS);
});
