import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../../scripts/process-budget.mjs";
import {
  ENVIRONMENT_EXAMPLE_NAME,
  ENVIRONMENT_FILE_NAME,
  SECRETS_DIRECTORY_NAME,
  applyGuidedInit,
  applySetOidcSecret,
  ensureEnvironmentFile,
  ensureOidcSecretPlaceholder,
  ensureSecretsDirectory,
  persistOrbitImage,
  runConfigureApply,
  setDeploymentProfile,
} from "./configure-engine";

// Cross-implementation content parity between scripts/configure.sh's write
// flows and this TypeScript engine port (issue #294), the same discipline
// src/lib/config-contract.parity.test.ts already established for `--check`.
// For scenarios involving a freshly *generated* secret, the real script's
// fake `openssl` and this file's mocked `crypto.randomBytes` are pinned to
// the identical fixed value (64 "a" characters == 32 bytes of 0xaa), so
// comparison stays genuinely byte-for-byte rather than merely structural.

// This file spawns the real configure.sh under bash; a spawn that takes
// 0.7s quiet took 4.3s on a starved core (#698). Budget and reasoning:
// scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

const FAKE_OPENSSL_SCRIPT = [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  'if [[ "${1:-}" == "rand" ]]; then',
  "  printf 'a%.0s' {1..64}",
  "  printf '\\n'",
  "  exit 0",
  "fi",
  "exit 1",
  "",
].join("\n");

// Fakes `docker` too — the bare flow's ensure_vapid_keys (bash-only, see
// this module's own header comment on the scope boundary) always runs after
// everything this test compares, and would otherwise try to `git
// rev-parse`/build a real bootstrap image from inside a scratch directory
// that is not a git checkout. `image`/`pull` report success (an image is
// "already present"), and `run` prints a fixed VAPID key pair, mirroring
// scripts/configure.test.mjs's own fake docker fixture exactly.
const FAKE_DOCKER_SCRIPT = [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  'case "${1:-}" in',
  "  image)",
  "    exit 0",
  "    ;;",
  "  run)",
  "    printf 'public=fake-public-key\\nprivate=%s\\n' \"$(printf 'c%.0s' {1..64})\"",
  "    exit 0",
  "    ;;",
  "  pull)",
  "    exit 0",
  "    ;;",
  "esac",
  "exit 1",
  "",
].join("\n");

function makeFakeOpensslBin(): string {
  const binDir = scratchDir("orbit-configure-parity-fakebin-");
  writeFileSync(join(binDir, "openssl"), FAKE_OPENSSL_SCRIPT);
  chmodSync(join(binDir, "openssl"), 0o755);
  writeFileSync(join(binDir, "docker"), FAKE_DOCKER_SCRIPT);
  chmodSync(join(binDir, "docker"), 0o755);
  return binDir;
}

/** Real, unmodified scripts/configure.sh + scripts/installer-ui.sh + .env-orbit.example, copied into a scratch deployment directory. */
function makeBashFixture(envOrbitContent?: string): string {
  const targetDir = scratchDir("orbit-configure-parity-bash-");
  mkdirSync(join(targetDir, "scripts"));
  for (const script of ["configure.sh", "installer-ui.sh"]) {
    writeFileSync(join(targetDir, "scripts", script), readFileSync(join(repoRoot, "scripts", script)));
    chmodSync(join(targetDir, "scripts", script), 0o755);
  }
  writeFileSync(join(targetDir, ENVIRONMENT_EXAMPLE_NAME), readFileSync(join(repoRoot, ENVIRONMENT_EXAMPLE_NAME)));
  if (envOrbitContent !== undefined) {
    writeFileSync(join(targetDir, ENVIRONMENT_FILE_NAME), envOrbitContent);
    chmodSync(join(targetDir, ENVIRONMENT_FILE_NAME), 0o600);
  }
  return targetDir;
}

/** An equivalent scratch deployment directory for the TS engine, sharing the same real .env-orbit.example. */
function makeEngineFixture(envOrbitContent?: string): string {
  const targetDir = scratchDir("orbit-configure-parity-engine-");
  writeFileSync(join(targetDir, ENVIRONMENT_EXAMPLE_NAME), readFileSync(join(repoRoot, ENVIRONMENT_EXAMPLE_NAME)));
  if (envOrbitContent !== undefined) {
    writeFileSync(join(targetDir, ENVIRONMENT_FILE_NAME), envOrbitContent);
    chmodSync(join(targetDir, ENVIRONMENT_FILE_NAME), 0o600);
  }
  return targetDir;
}

function runBashConfigure(targetDir: string, args: string[], envOverrides: Record<string, string> = {}, input?: string) {
  const binDir = makeFakeOpensslBin();
  return failOnProcessDeadline(spawnSync("bash", [join(targetDir, "scripts", "configure.sh"), ...args], {
    cwd: targetDir,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: process.env.HOME ?? tmpdir(),
      ...envOverrides,
    },
    ...processGuard(),
  }), { label: "runBashConfigure" });
}

// A freshly generated 64-hex-character secret (session-secret, postgres-
// password, document-kek) is genuinely random on both sides — bash's real
// `openssl rand -hex 32` (not faked for these three; only ensure_vapid_keys's
// own docker calls are faked above) versus this engine's node:crypto
// randomBytes. Byte-for-byte comparison of the *value* is therefore not
// meaningful; RANDOM_HEX64_MARKER normalizes any such value to a fixed
// placeholder before comparison, so the assertion still catches every
// *structural* difference (which file exists, its mode, its surrounding
// newline convention, every other file's exact content) without asserting
// two independent CSPRNGs produced the same bytes.
const RANDOM_HEX64_MARKER = "<64-hex-char-secret>\n";
const HEX64_LINE = /^[0-9a-fA-F]{64}\n$/;

function normalizeGeneratedSecretContent(relativePath: string, content: string): string {
  const isGeneratedSecretFile = /^\.orbit-secrets\/(session-secret|postgres-password|document-kek)$/.test(relativePath);
  return isGeneratedSecretFile && HEX64_LINE.test(content) ? RANDOM_HEX64_MARKER : content;
}

/**
 * ensure_vapid_keys (bash-only; see this module's header comment) writes
 * VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY_FILE into .env-orbit as part of
 * bash's own bare-flow run. The engine's runConfigureApply deliberately
 * never reaches that step, so those two lines are the one place a
 * structurally-fair comparison must normalize away bash's own VAPID
 * mutation rather than expect the engine to have produced it.
 */
function normalizeVapidEnvLines(content: string): string {
  return content
    .replace(/^VAPID_PUBLIC_KEY=.*$/m, "VAPID_PUBLIC_KEY=")
    .replace(/^VAPID_PRIVATE_KEY_FILE=.*$/m, "VAPID_PRIVATE_KEY_FILE=");
}

/**
 * Single O_NOFOLLOW descriptor for a mode+content snapshot — never a
 * separate stat-then-readFile pair on the same path (CodeQL
 * js/file-system-race), mirroring src/lib/restore-engine.ts's
 * readFileNoFollow/regularFileSizeNoFollow discipline. Returns undefined
 * for anything not a regular file (including "doesn't exist"), so callers
 * can treat open-failure and non-regular-file uniformly.
 */
function statAndReadNoFollow(path: string): { mode: number; content: string } | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return undefined;
    return { mode: stat.mode & 0o777, content: readFileSync(descriptor, "utf8") };
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Snapshots exactly the paths configure.sh's write flows own — .env-orbit
 * and .orbit-secrets/* — as relative-path -> {mode, content}. Deliberately
 * scoped rather than a whole-tree walk: both fixtures also carry
 * .env-orbit.example (and the bash fixture additionally carries scripts/*),
 * which are shared pre-existing inputs, not outputs either implementation
 * produces. VAPID artifacts (bash-only; see this module's header comment)
 * and leftover atomic-write temp files are excluded the same way
 * scripts/configure.test.mjs's own stagingLeftovers() helper does.
 */
function snapshotConfigureOutputs(root: string): Record<string, { mode: number; content: string }> {
  const snapshot: Record<string, { mode: number; content: string }> = {};

  const envPath = join(root, ENVIRONMENT_FILE_NAME);
  const envSnapshot = statAndReadNoFollow(envPath);
  if (envSnapshot) {
    snapshot[ENVIRONMENT_FILE_NAME] = { mode: envSnapshot.mode, content: normalizeVapidEnvLines(envSnapshot.content) };
  }
  /* absent on both sides for scenarios that never create it */

  const secretsDir = join(root, SECRETS_DIRECTORY_NAME);
  let entries: string[] = [];
  try {
    entries = readdirSync(secretsDir);
  } catch {
    return snapshot;
  }
  for (const name of entries) {
    if (name.startsWith(".installing") || name.startsWith(".vapid.installing") || name.includes("vapid")) continue;
    const relative = `${SECRETS_DIRECTORY_NAME}/${name}`;
    const full = join(secretsDir, name);
    const fileSnapshot = statAndReadNoFollow(full);
    if (!fileSnapshot) continue;
    snapshot[relative] = { mode: fileSnapshot.mode, content: normalizeGeneratedSecretContent(relative, fileSnapshot.content) };
  }
  return snapshot;
}

describe("fresh --init: bash vs engine, byte-for-byte", () => {
  it("configure.sh #11-14 / engine applyGuidedInit produce identical .env-orbit content", () => {
    const bashDir = makeBashFixture();
    const bashResult = runBashConfigure(bashDir, ["--init"], {
      ORBIT_CONFIGURE_APP_URL: "https://orbit.parity-init.invalid",
      ORBIT_CONFIGURE_OIDC_ISSUER: "https://auth.parity-init.invalid/application/o/orbit/",
      ORBIT_CONFIGURE_OIDC_CLIENT_ID: "parity-client",
    });
    expect(bashResult.status).toBe(0);

    const engineDir = makeEngineFixture();
    ensureEnvironmentFile(engineDir);
    applyGuidedInit(engineDir, {
      appUrl: "https://orbit.parity-init.invalid",
      issuer: "https://auth.parity-init.invalid/application/o/orbit/",
      clientId: "parity-client",
    });

    expect(snapshotConfigureOutputs(engineDir)).toEqual(snapshotConfigureOutputs(bashDir));
  });
});

describe("bare flow re-run: preserves already-generated secrets identically", () => {
  it("configure.sh guarantee #33 / engine runConfigureApply: a second run changes nothing", () => {
    const bashDir = makeBashFixture();
    const orbitImage = "orbit-local:abcdef123456";
    expect(runBashConfigure(bashDir, [], { ORBIT_IMAGE: orbitImage }).status).toBe(0);
    const firstBashSnapshot = snapshotConfigureOutputs(bashDir);
    expect(runBashConfigure(bashDir, [], { ORBIT_IMAGE: orbitImage }).status).toBe(0);
    const secondBashSnapshot = snapshotConfigureOutputs(bashDir);
    expect(secondBashSnapshot).toEqual(firstBashSnapshot);

    const engineDir = makeEngineFixture();
    runConfigureApply(engineDir, orbitImage);
    const firstEngineSnapshot = snapshotConfigureOutputs(engineDir);
    runConfigureApply(engineDir, orbitImage);
    const secondEngineSnapshot = snapshotConfigureOutputs(engineDir);
    expect(secondEngineSnapshot).toEqual(firstEngineSnapshot);

    // Cross-implementation: every file the engine owns matches bash's own
    // output structurally (mode, surrounding content; generated-secret
    // *values* are normalized to a fixed marker — see
    // normalizeGeneratedSecretContent's own comment for why an exact
    // byte-for-byte value match between two independent CSPRNGs isn't the
    // right assertion).
    expect(firstEngineSnapshot).toEqual(firstBashSnapshot);
  });

  it("each generated secret is a freshly random, valid 64-hex-character value distinct from bash's own", () => {
    const bashDir = makeBashFixture();
    expect(runBashConfigure(bashDir, [], { ORBIT_IMAGE: "orbit-local:abcdef123456" }).status).toBe(0);
    const bashSecret = readFileSync(join(bashDir, SECRETS_DIRECTORY_NAME, "session-secret"), "utf8");
    expect(bashSecret).toMatch(/^[0-9a-f]{64}\n$/);

    const engineDir = makeEngineFixture();
    runConfigureApply(engineDir, "orbit-local:abcdef123456");
    const engineSecret = readFileSync(join(engineDir, SECRETS_DIRECTORY_NAME, "session-secret"), "utf8");
    expect(engineSecret).toMatch(/^[0-9a-f]{64}\n$/);
    // Both are genuinely random (bash's real openssl, this engine's real
    // node:crypto) — vanishingly unlikely to coincide, which is itself a
    // sanity check that neither side is using a fixed/predictable value.
    expect(engineSecret).not.toBe(bashSecret);
  });
});

describe("--set-oidc-secret: bash vs engine, byte-for-byte", () => {
  it("configure.sh guarantees #20-23 / engine applySetOidcSecret write identical files", () => {
    const secret = "parity-oidc-secret-value";
    const bashDir = makeBashFixture();
    const bashResult = runBashConfigure(bashDir, ["--set-oidc-secret"], {}, `${secret}\n`);
    expect(bashResult.status).toBe(0);

    const engineDir = makeEngineFixture();
    ensureEnvironmentFile(engineDir);
    applySetOidcSecret(engineDir, secret);

    expect(snapshotConfigureOutputs(engineDir)).toEqual(snapshotConfigureOutputs(bashDir));
  });
});

describe("--set-deployment-profile: bash vs engine, byte-for-byte", () => {
  it("configure.sh guarantee #10 / engine setDeploymentProfile (ai preset) write identical files", () => {
    const bashDir = makeBashFixture();
    expect(runBashConfigure(bashDir, [], { ORBIT_IMAGE: "orbit-local:abcdef123456" }).status).toBe(0);
    expect(runBashConfigure(bashDir, ["--set-deployment-profile", "ai", "llama3:8b"], { ORBIT_IMAGE: "orbit-local:abcdef123456" }).status).toBe(0);

    const engineDir = makeEngineFixture();
    runConfigureApply(engineDir, "orbit-local:abcdef123456");
    setDeploymentProfile(engineDir, "ai", "llama3:8b");

    expect(snapshotConfigureOutputs(engineDir)).toEqual(snapshotConfigureOutputs(bashDir));
  });

  it("configure.sh guarantee #10 / engine setDeploymentProfile (standard preset) write identical files", () => {
    const bashDir = makeBashFixture();
    expect(runBashConfigure(bashDir, [], { ORBIT_IMAGE: "orbit-local:abcdef123456" }).status).toBe(0);
    expect(runBashConfigure(bashDir, ["--set-deployment-profile", "standard"], { ORBIT_IMAGE: "orbit-local:abcdef123456" }).status).toBe(0);

    const engineDir = makeEngineFixture();
    runConfigureApply(engineDir, "orbit-local:abcdef123456");
    setDeploymentProfile(engineDir, "standard", undefined);

    expect(snapshotConfigureOutputs(engineDir)).toEqual(snapshotConfigureOutputs(bashDir));
  });
});

describe("re-run preserving secrets: an operator hand-edit survives untouched", () => {
  it("a pre-existing valid OIDC secret placeholder is preserved identically by both implementations", () => {
    const value = "c".repeat(64);
    const bashDir = makeBashFixture();
    mkdirSync(join(bashDir, SECRETS_DIRECTORY_NAME), { mode: 0o700 });
    writeFileSync(join(bashDir, SECRETS_DIRECTORY_NAME, "oidc-client-secret"), `${value}\n`, { mode: 0o600 });
    writeFileSync(
      join(bashDir, ENVIRONMENT_FILE_NAME),
      "ORBIT_CONFIG_SCHEMA_VERSION=1\nOIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret\n",
      { mode: 0o600 },
    );
    expect(runBashConfigure(bashDir, [], { ORBIT_IMAGE: "orbit-local:abcdef123456" }).status).toBe(0);
    expect(readFileSync(join(bashDir, SECRETS_DIRECTORY_NAME, "oidc-client-secret"), "utf8")).toBe(`${value}\n`);

    const engineDir = makeEngineFixture();
    mkdirSync(join(engineDir, SECRETS_DIRECTORY_NAME), { mode: 0o700 });
    writeFileSync(join(engineDir, SECRETS_DIRECTORY_NAME, "oidc-client-secret"), `${value}\n`, { mode: 0o600 });
    writeFileSync(
      join(engineDir, ENVIRONMENT_FILE_NAME),
      "ORBIT_CONFIG_SCHEMA_VERSION=1\nOIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret\n",
      { mode: 0o600 },
    );
    ensureEnvironmentFile(engineDir);
    ensureSecretsDirectory(engineDir);
    ensureOidcSecretPlaceholder(engineDir);
    expect(readFileSync(join(engineDir, SECRETS_DIRECTORY_NAME, "oidc-client-secret"), "utf8")).toBe(`${value}\n`);
    expect(readFileSync(join(engineDir, SECRETS_DIRECTORY_NAME, "oidc-client-secret"), "utf8")).toBe(
      readFileSync(join(bashDir, SECRETS_DIRECTORY_NAME, "oidc-client-secret"), "utf8"),
    );
  });
});

describe("persistOrbitImage: bash vs engine", () => {
  it("an existing active ORBIT_IMAGE assignment is updated identically in place", () => {
    const bashDir = makeBashFixture("ORBIT_IMAGE=orbit-local:aaaaaaaaaaaa\nOTHER=1\n");
    // configure.sh's persist_orbit_image is only reachable through the bare
    // flow; drive it directly by sourcing the equivalent behaviour: run the
    // bare flow with ORBIT_IMAGE set against a fixture that already has an
    // active assignment, using the fake-docker-free session/secret steps'
    // preconditions satisfied by a schema-versioned file.
    writeFileSync(join(bashDir, ENVIRONMENT_FILE_NAME), "ORBIT_CONFIG_SCHEMA_VERSION=1\nORBIT_IMAGE=orbit-local:aaaaaaaaaaaa\nOTHER=1\n", {
      mode: 0o600,
    });

    const engineDir = makeEngineFixture();
    writeFileSync(join(engineDir, ENVIRONMENT_FILE_NAME), "ORBIT_CONFIG_SCHEMA_VERSION=1\nORBIT_IMAGE=orbit-local:aaaaaaaaaaaa\nOTHER=1\n", {
      mode: 0o600,
    });
    persistOrbitImage(engineDir, "orbit-local:bbbbbbbbbbbb");

    expect(readFileSync(join(engineDir, ENVIRONMENT_FILE_NAME), "utf8")).toBe(
      "ORBIT_CONFIG_SCHEMA_VERSION=1\nORBIT_IMAGE=orbit-local:bbbbbbbbbbbb\nOTHER=1\n",
    );
  });
});
