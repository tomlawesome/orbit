import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../process-budget.mjs";

/*
 * scripts/ci/verify-release-manifest.sh (ADR-0031 #4/#5, implementation
 * slice 5): the shared two-way verifier publish_channel runs before it
 * tags, and every later consumer of the release manifest (publish-from-
 * gitlab.yml, release-on-tag.yml) will call. Both cosign and openssl must
 * pass. cosign is stubbed on PATH, the way every other cosign-calling
 * script's test stubs it -- but openssl stays real: a throwaway P-256 key
 * pair is generated per test, the manifest is signed with
 * `openssl dgst -sha256 -sign` and the DER base64-encoded, which is the
 * exact byte shape cosign sign-blob's own output takes (verified by hand
 * against a real openssl round-trip). That is what proves the script's
 * openssl half actually verifies real signatures, accepts the right one and
 * refuses a tampered manifest, a signature from a different key, and a
 * missing/empty .sig -- not just that the script prints the right words.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./verify-release-manifest.sh", import.meta.url).pathname;

/** cosign is stubbed to answer verify-blob the way this script calls it. */
const COSIGN_STUB = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  "refuse() {",
  "  printf 'Error: %s\\n' \"$1\" >&2",
  "  printf 'error during command execution: %s\\n' \"$1\" >&2",
  "  exit 1",
  "}",
  '[ "${1:-}" = "verify-blob" ] || refuse "unknown command \\"${1:-}\\" for \\"cosign\\""',
  "shift",
  'while [ "$#" -gt 0 ]; do',
  '  case "$1" in',
  '    --key|--signature)',
  '      [ "$#" -ge 2 ] || refuse "flag needs an argument: $1"',
  "      shift 2",
  "      ;;",
  '    --insecure-ignore-tlog|--insecure-ignore-tlog=*)',
  '      case "$1" in *=*) shift ;; *) shift 2 ;; esac',
  "      ;;",
  '    --*) refuse "unknown flag: ${1%%=*}" ;;',
  "    *) shift ;;",
  "  esac",
  "done",
  'exit "${STUB_COSIGN_EXIT:-0}"',
  "",
].join("\n");

const directories = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop(), { recursive: true, force: true });
});
function makeDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

/** A throwaway P-256 key pair (the same curve as the real cosign.pub). */
function generateKeyPair(dir, name = "key") {
  const privatePem = join(dir, `${name}.pem`);
  const publicPem = join(dir, `${name}.pub.pem`);
  execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", privatePem]);
  execFileSync("openssl", ["ec", "-in", privatePem, "-pubout", "-out", publicPem], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return { privatePem, publicPem };
}

/** Signs `path` with `privatePem`, returning the DER bytes cosign sign-blob would base64. */
function sign(path, privatePem) {
  return execFileSync("openssl", ["dgst", "-sha256", "-sign", privatePem, path]);
}

function writeSignature(sigPath, derBuffer) {
  writeFileSync(sigPath, derBuffer.toString("base64"));
}

function run({ manifestPath, sigPath, args, env = {}, dropEnv = [] } = {}) {
  const dir = makeDir("verify-release-manifest-");
  const cosign = join(dir, "cosign");
  writeFileSync(cosign, COSIGN_STUB);
  chmodSync(cosign, 0o755);

  const fullEnv = {
    PATH: process.env.PATH,
    ORBIT_COSIGN: cosign,
    ...env,
  };
  for (const name of dropEnv) delete fullEnv[name];

  const finalArgs = args ?? [manifestPath, sigPath];
  return failOnProcessDeadline(
    spawnSync("bash", [script, ...finalArgs], { encoding: "utf8", env: fullEnv, ...processGuard() }),
    { label: "verify-release-manifest" },
  );
}

describe("verify-release-manifest.sh", () => {
  it("accepts a real signature from the committed key with both cosign and openssl", () => {
    const dir = makeDir("fixture-");
    const { privatePem, publicPem } = generateKeyPair(dir);
    const manifestPath = join(dir, "orbit-release-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ hello: "orbit" }));
    const sigPath = `${manifestPath}.sig`;
    writeSignature(sigPath, sign(manifestPath, privatePem));

    const result = run({ manifestPath, sigPath, env: { COSIGN_PUBLIC_KEY: publicPem } });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("verified");
    expect(result.stdout).toContain("cosign and openssl");
  });

  it("refuses a tampered manifest even though the signature is well-formed", () => {
    const dir = makeDir("fixture-");
    const { privatePem, publicPem } = generateKeyPair(dir);
    const manifestPath = join(dir, "orbit-release-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ hello: "orbit" }));
    const sigPath = `${manifestPath}.sig`;
    writeSignature(sigPath, sign(manifestPath, privatePem));

    // Tamper after signing: the manifest on disk no longer matches what was
    // signed, the way a corrupted or substituted download would look.
    writeFileSync(manifestPath, JSON.stringify({ hello: "tampered" }));

    const result = run({ manifestPath, sigPath, env: { COSIGN_PUBLIC_KEY: publicPem } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("openssl could not verify");
  });

  it("refuses a signature made with a different key", () => {
    const dir = makeDir("fixture-");
    const { publicPem } = generateKeyPair(dir, "committed");
    const { privatePem: otherPrivate } = generateKeyPair(dir, "attacker");
    const manifestPath = join(dir, "orbit-release-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ hello: "orbit" }));
    const sigPath = `${manifestPath}.sig`;
    writeSignature(sigPath, sign(manifestPath, otherPrivate));

    const result = run({ manifestPath, sigPath, env: { COSIGN_PUBLIC_KEY: publicPem } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("openssl could not verify");
  });

  it("refuses a missing signature file", () => {
    const dir = makeDir("fixture-");
    const { publicPem } = generateKeyPair(dir);
    const manifestPath = join(dir, "orbit-release-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ hello: "orbit" }));
    const sigPath = join(dir, "orbit-release-manifest.json.sig");

    const result = run({ manifestPath, sigPath, env: { COSIGN_PUBLIC_KEY: publicPem } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no signature at");
  });

  it("refuses an empty signature file", () => {
    const dir = makeDir("fixture-");
    const { publicPem } = generateKeyPair(dir);
    const manifestPath = join(dir, "orbit-release-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ hello: "orbit" }));
    const sigPath = `${manifestPath}.sig`;
    writeFileSync(sigPath, "");

    const result = run({ manifestPath, sigPath, env: { COSIGN_PUBLIC_KEY: publicPem } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is empty");
  });

  it("refuses a missing manifest", () => {
    const dir = makeDir("fixture-");
    const { publicPem } = generateKeyPair(dir);
    const result = run({
      manifestPath: join(dir, "missing.json"),
      sigPath: join(dir, "missing.json.sig"),
      env: { COSIGN_PUBLIC_KEY: publicPem },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no manifest at");
  });

  it("defaults the signature path to <manifest>.sig", () => {
    const dir = makeDir("fixture-");
    const { privatePem, publicPem } = generateKeyPair(dir);
    const manifestPath = join(dir, "orbit-release-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ hello: "orbit" }));
    writeSignature(`${manifestPath}.sig`, sign(manifestPath, privatePem));

    const result = run({ args: [manifestPath], env: { COSIGN_PUBLIC_KEY: publicPem } });
    expect(result.status).toBe(0);
  });

  it("refuses when cosign fails even though openssl would accept", () => {
    const dir = makeDir("fixture-");
    const { privatePem, publicPem } = generateKeyPair(dir);
    const manifestPath = join(dir, "orbit-release-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ hello: "orbit" }));
    const sigPath = `${manifestPath}.sig`;
    writeSignature(sigPath, sign(manifestPath, privatePem));

    const result = run({
      manifestPath,
      sigPath,
      env: { COSIGN_PUBLIC_KEY: publicPem, STUB_COSIGN_EXIT: "1" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cosign could not verify");
  });

  it("refuses a signature that is not valid base64", () => {
    const dir = makeDir("fixture-");
    const { publicPem } = generateKeyPair(dir);
    const manifestPath = join(dir, "orbit-release-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ hello: "orbit" }));
    const sigPath = `${manifestPath}.sig`;
    writeFileSync(sigPath, "not valid base64 !!! @@@");

    const result = run({ manifestPath, sigPath, env: { COSIGN_PUBLIC_KEY: publicPem } });
    expect(result.status).toBe(1);
  });

  it("refuses a missing public key", () => {
    const dir = makeDir("fixture-");
    const manifestPath = join(dir, "orbit-release-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ hello: "orbit" }));
    writeFileSync(`${manifestPath}.sig`, "AA==");

    const result = run({
      manifestPath,
      sigPath: `${manifestPath}.sig`,
      env: { COSIGN_PUBLIC_KEY: join(dir, "nonexistent.pub") },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("validation public key is not at");
  });
});
