import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { readGolden } from "./__fixtures__/golden";

// Content parity between the engine's write flows and what the retired bash
// scripts/configure.sh wrote, captured from b0ee5929 before it was deleted
// (src/lib/__fixtures__/configure-write, #1210 D10). Snapshots cover
// .env-orbit and .orbit-secrets/* (mode and content); generated secret values
// and VAPID lines are normalised because neither side's randomness compares.

// This file spawns the real CLI; a spawn that takes 0.7s quiet took 4.3s on
// a starved core (#698). Budget and reasoning: scripts/process-budget.mjs.
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

/** A scratch deployment directory for the engine, with the real .env-orbit.example. */
function makeEngineFixture(envOrbitContent?: string): string {
  const targetDir = scratchDir("orbit-configure-parity-engine-");
  writeFileSync(join(targetDir, ENVIRONMENT_EXAMPLE_NAME), readFileSync(join(repoRoot, ENVIRONMENT_EXAMPLE_NAME)));
  if (envOrbitContent !== undefined) {
    writeFileSync(join(targetDir, ENVIRONMENT_FILE_NAME), envOrbitContent);
    chmodSync(join(targetDir, ENVIRONMENT_FILE_NAME), 0o600);
  }
  return targetDir;
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

type Snapshot = Record<string, { mode: number; content: string }>;
const golden = <T>(name: string): T => readGolden<T>("configure-write", name);

describe("fresh --init: engine vs captured bash, byte-for-byte", () => {
  it("configure.sh #11-14 / engine applyGuidedInit produce identical .env-orbit content", () => {
    const bash = golden<{ outputs: Snapshot }>("init-oidc-env-triad");
    const engineDir = makeEngineFixture();
    ensureEnvironmentFile(engineDir);
    applyGuidedInit(engineDir, {
      appUrl: "https://orbit.parity-init.invalid",
      issuer: "https://auth.parity-init.invalid/application/o/orbit/",
      clientId: "parity-client",
    });
    expect(snapshotConfigureOutputs(engineDir)).toEqual(bash.outputs);
  });
});

describe("bare flow re-run: preserves already-generated secrets identically", () => {
  it("configure.sh guarantee #33 / engine runConfigureApply: a second run changes nothing", () => {
    const bash = golden<{ first: Snapshot; second: Snapshot }>("bare-fresh-then-rerun");
    const orbitImage = "orbit-local:abcdef123456";
    const engineDir = makeEngineFixture();
    runConfigureApply(engineDir, orbitImage);
    const firstEngineSnapshot = snapshotConfigureOutputs(engineDir);
    runConfigureApply(engineDir, orbitImage);
    const secondEngineSnapshot = snapshotConfigureOutputs(engineDir);
    expect(secondEngineSnapshot).toEqual(firstEngineSnapshot);
    // Every file the engine owns matches bash's own output structurally
    // (mode, surrounding content; generated-secret values normalised -- see
    // normalizeGeneratedSecretContent).
    expect(firstEngineSnapshot).toEqual(bash.first);
    expect(secondEngineSnapshot).toEqual(bash.second);
  });

  it("each generated secret is a freshly random, valid 64-hex-character value", () => {
    const first = makeEngineFixture();
    const second = makeEngineFixture();
    runConfigureApply(first, "orbit-local:abcdef123456");
    runConfigureApply(second, "orbit-local:abcdef123456");
    const read = (dir: string) => readFileSync(join(dir, SECRETS_DIRECTORY_NAME, "session-secret"), "utf8");
    expect(read(first)).toMatch(/^[0-9a-f]{64}\n$/);
    expect(read(first)).not.toBe(read(second));
  });
});

describe("--set-oidc-secret: engine vs captured bash, byte-for-byte", () => {
  it("configure.sh guarantees #20-23 / engine applySetOidcSecret write identical files", () => {
    const bash = golden<{ secret: string; outputs: Snapshot }>("set-oidc-secret-piped");
    const engineDir = makeEngineFixture();
    ensureEnvironmentFile(engineDir);
    applySetOidcSecret(engineDir, bash.secret);
    expect(snapshotConfigureOutputs(engineDir)).toEqual(bash.outputs);
  });
});

describe("--set-deployment-profile: engine vs captured bash, byte-for-byte", () => {
  it("configure.sh guarantee #10 / engine setDeploymentProfile (ai preset) write identical files", () => {
    const engineDir = makeEngineFixture();
    runConfigureApply(engineDir, "orbit-local:abcdef123456");
    setDeploymentProfile(engineDir, "ai", "llama3:8b");
    expect(snapshotConfigureOutputs(engineDir)).toEqual(golden<{ outputs: Snapshot }>("profile-ai-after-bare").outputs);
  });

  it("configure.sh guarantee #10 / engine setDeploymentProfile (standard preset) write identical files", () => {
    const engineDir = makeEngineFixture();
    runConfigureApply(engineDir, "orbit-local:abcdef123456");
    setDeploymentProfile(engineDir, "standard", undefined);
    expect(snapshotConfigureOutputs(engineDir)).toEqual(golden<{ outputs: Snapshot }>("profile-standard-after-bare").outputs);
  });
});

describe("re-run preserving secrets: an operator hand-edit survives untouched", () => {
  it("a pre-existing valid OIDC secret file is preserved identically", () => {
    const value = "c".repeat(64);
    const bash = golden<{ outputs: Snapshot }>("existing-oidc-secret-preserved");
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
    expect(snapshotConfigureOutputs(engineDir)[`${SECRETS_DIRECTORY_NAME}/oidc-client-secret`]).toEqual(
      bash.outputs[`${SECRETS_DIRECTORY_NAME}/oidc-client-secret`],
    );
  });
});

describe("persistOrbitImage: engine vs captured bash", () => {
  // The bash comparison was a first bare run, then a trusted re-pin of the
  // EXISTING deployment (#1151 O1-S4, #1204): install.sh sets the trust
  // marker alongside ORBIT_IMAGE, the one path that reaches persistOrbitImage.
  it("an existing active ORBIT_IMAGE assignment is updated identically in place", () => {
    const engineDir = makeEngineFixture();
    runConfigureApply(engineDir, "orbit-local:aaaaaaaaaaaa");
    persistOrbitImage(engineDir, "orbit-local:bbbbbbbbbbbb");
    expect(snapshotConfigureOutputs(engineDir)).toEqual(golden<{ outputs: Snapshot }>("trusted-image-repin").outputs);
    expect(readFileSync(join(engineDir, ENVIRONMENT_FILE_NAME), "utf8")).toContain("ORBIT_IMAGE=orbit-local:bbbbbbbbbbbb\n");
  });
});

// The CLI against the captured bash: exit status, stdout, and .env-orbit.
// Refusals keep their wording; the prefix changed from "Orbit
// configuration:" to "orbit:" with the engine.

const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cli = join(repoRoot, "src", "cli", "orbit.ts");

function runCli(dir: string, args: string[], env: Record<string, string> = {}, input = "") {
  const result = failOnProcessDeadline(spawnSync("node", [tsx, cli, "configure", ...args, "--dir", dir], {
    encoding: "utf8",
    input,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    ...processGuard(),
  }), { label: `orbit configure ${args.join(" ")}` });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface CapturedRun {
  result: { status: number; stdout: string; stderr: string };
  env: string | null;
}

const message = (stderr: string): string => stderr.replace(/^(Orbit configuration|orbit): /u, "").trim();

describe("orbit configure against the captured bash runs", () => {
  it("the bare flow prints the same lines, fresh and on a re-run", () => {
    const bash = golden<{ first: { stdout: string }; second: { stdout: string; stderr: string } }>("bare stdout fresh then rerun");
    const dir = makeEngineFixture();
    expect(runCli(dir, [], { ORBIT_IMAGE: "orbit-local:abcdef123456" }).stdout).toBe(bash.first.stdout);
    const second = runCli(dir, [], { ORBIT_IMAGE: "orbit-local:abcdef123456" });
    expect(second.stdout).toBe(bash.second.stdout);
    expect(second.stderr).toBe(bash.second.stderr);
  });

  it("--set-oidc-secret from a pipe prints the same lines and writes the same files", () => {
    const bash = golden<{ secret: string; status: number; stdout: string; outputs: Snapshot }>("set-oidc-secret-piped");
    const dir = makeEngineFixture();
    const run = runCli(dir, ["--set-oidc-secret"], {}, `${bash.secret}\n`);
    expect({ status: run.status, stdout: run.stdout }).toEqual({ status: bash.status, stdout: bash.stdout });
    expect(snapshotConfigureOutputs(dir)).toEqual(bash.outputs);
  });

  it("--init from the environment answers prints the same lines", () => {
    const bash = golden<{ status: number; stdout: string; outputs: Snapshot }>("init-oidc-env-triad");
    const dir = makeEngineFixture();
    const run = runCli(dir, ["--init"], {
      ORBIT_CONFIGURE_APP_URL: "https://orbit.parity-init.invalid",
      ORBIT_CONFIGURE_OIDC_ISSUER: "https://auth.parity-init.invalid/application/o/orbit/",
      ORBIT_CONFIGURE_OIDC_CLIENT_ID: "parity-client",
    });
    expect({ status: run.status, stdout: run.stdout }).toEqual({ status: bash.status, stdout: bash.stdout });
    expect(snapshotConfigureOutputs(dir)).toEqual(bash.outputs);
  });

  it("an untrusted ORBIT_IMAGE on an existing deployment is ignored with the same advisory", () => {
    const bash = golden<CapturedRun>("bare untrusted image on existing deployment");
    const dir = makeEngineFixture();
    runCli(dir, [], { ORBIT_IMAGE: "orbit-local:abcdef123456" });
    const run = runCli(dir, [], { ORBIT_IMAGE: "orbit-local:bbbbbbbbbbbb" });
    expect(run).toEqual({ ...bash.result, stdout: bash.result.stdout });
    expect(normalizeVapidEnvLines(readFileSync(join(dir, ENVIRONMENT_FILE_NAME), "utf8"))).toBe(normalizeVapidEnvLines(bash.env ?? ""));
  });

  it.each([
    ["init local app url only", ["--init"], { ORBIT_CONFIGURE_AUTH_MODE: "local", ORBIT_CONFIGURE_APP_URL: "https://orbit.parity-init.invalid" }, ""],
    ["init partial env set", ["--init"], { ORBIT_CONFIGURE_APP_URL: "https://orbit.parity-init.invalid" }, ""],
    ["init invalid auth mode", ["--init"], { ORBIT_CONFIGURE_AUTH_MODE: "bogus" }, ""],
    [
      "init invalid app url",
      ["--init"],
      { ORBIT_CONFIGURE_APP_URL: "http://127.0.0.1", ORBIT_CONFIGURE_OIDC_ISSUER: "https://auth.parity.invalid/", ORBIT_CONFIGURE_OIDC_CLIENT_ID: "c" },
      "",
    ],
    ["init without terminal or answers", ["--init"], {}, ""],
    ["profile processing fresh", ["--set-deployment-profile", "processing"], {}, ""],
    ["set oidc secret empty", ["--set-oidc-secret"], {}, "\n"],
    ["set oidc secret oversized", ["--set-oidc-secret"], {}, `${"a".repeat(65537)}\n`],
  ] as const)("%s", (name, args, env, input) => {
    const bash = golden<CapturedRun>(name);
    const dir = makeEngineFixture();
    const run = runCli(dir, [...args], env, input);
    expect(run.status).toBe(bash.result.status);
    expect(run.stdout).toBe(bash.result.stdout);
    expect(message(run.stderr)).toBe(message(bash.result.stderr));
    const envPath = join(dir, ENVIRONMENT_FILE_NAME);
    expect(existsSync(envPath) ? readFileSync(envPath, "utf8") : null).toBe(bash.env);
  });

  it.each([["profile invalid preset", ["--set-deployment-profile", "bogus"]], ["profile ai without model", ["--set-deployment-profile", "ai"]]] as const)(
    "%s is a usage error (exit 2) that writes nothing",
    (name, args) => {
      const bash = golden<CapturedRun>(name);
      const dir = makeEngineFixture();
      const run = runCli(dir, [...args]);
      expect(run.status).toBe(bash.result.status);
      expect(existsSync(join(dir, ENVIRONMENT_FILE_NAME))).toBe(bash.env !== null);
    },
  );
});
