import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../process-budget.mjs";

/*
 * scripts/ci/sign-release-manifest.sh mints the second signature
 * sign_evidence produces (ADR-0031 #4), over the release manifest slice 3
 * wrote. Its likeliest failures are the same as attest-tested-image.sh's --
 * the signing key material exists only on the orbit-signing runner's host
 * mount -- plus one this script alone can make: signing a manifest that
 * names a digest other than the one this pipeline actually tested. cosign is
 * stubbed on PATH the same way attest-tested-image.test.mjs stubs it, so the
 * test can judge exactly what would have been signed without a real key.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./sign-release-manifest.sh", import.meta.url).pathname;

const DIGEST = `sha256:${"1".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"2".repeat(64)}`;

const COSIGN_STUB = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  "refuse() {",
  "  printf 'Error: %s\\n' \"$1\" >&2",
  "  printf 'error during command execution: %s\\n' \"$1\" >&2",
  "  exit 1",
  "}",
  "printf 'cosign\\x1f%s\\x1e' \"$*\" >> \"$STUB_LOG\"",
  '[ "${1:-}" = "sign-blob" ] || refuse "unknown command \\"${1:-}\\" for \\"cosign\\""',
  "shift",
  "output=",
  "subject=",
  'while [ "$#" -gt 0 ]; do',
  '  case "$1" in',
  '    --key)',
  '      [ "$#" -ge 2 ] || refuse "flag needs an argument: --key"',
  "      shift 2",
  "      ;;",
  '    --output-signature)',
  '      [ "$#" -ge 2 ] || refuse "flag needs an argument: --output-signature"',
  '      output="$2"',
  "      shift 2",
  "      ;;",
  '    --tlog-upload|--tlog-upload=*|--use-signing-config|--use-signing-config=*)',
  '      case "$1" in *=*) shift ;; *) shift 2 ;; esac',
  "      ;;",
  '    -y|--yes) shift ;;',
  '    --*) refuse "unknown flag: ${1%%=*}" ;;',
  '    *) subject="$1"; shift ;;',
  "  esac",
  "done",
  'if [ -n "${STUB_COSIGN_EXIT:-}" ] && [ "${STUB_COSIGN_EXIT}" != "0" ]; then',
  '  exit "$STUB_COSIGN_EXIT"',
  "fi",
  '[ -n "$output" ] || refuse "no --output-signature given"',
  '[ -n "$subject" ] || refuse "no file to sign given"',
  '# A stand-in signature: real cosign writes base64 of a DER ECDSA signature.',
  "# The stub writes a deterministic marker instead -- slice 5's test",
  '# exercises the real openssl-compatible bytes against a throwaway key; this',
  '# one only needs to prove sign-release-manifest.sh wired the flags right',
  '# and wrote whatever cosign returned.',
  'printf \'STUB-SIGNATURE-OF\\x1f%s\' "$(cat "$subject")" | base64 > "$output"',
  'exit 0',
  "",
].join("\n");

function run({ manifestPath, args, env = {}, dropEnv = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sign-release-manifest-"));
  const cosign = join(dir, "cosign");
  writeFileSync(cosign, COSIGN_STUB);
  chmodSync(cosign, 0o755);
  const logFile = join(dir, "calls.log");
  writeFileSync(logFile, "");
  const keyFile = join(dir, "cosign.key");
  writeFileSync(keyFile, "TEST-PRIVATE-KEY-NOT-REAL\n");

  const fullEnv = {
    PATH: process.env.PATH,
    COSIGN_PRIVATE_KEY: keyFile,
    COSIGN_PASSWORD: "TEST-PASSWORD-NOT-REAL",
    ORBIT_COSIGN: cosign,
    STUB_LOG: logFile,
    ...env,
  };
  for (const name of dropEnv) delete fullEnv[name];

  const result = failOnProcessDeadline(
    spawnSync("bash", [script, ...(args ?? [manifestPath, DIGEST])], {
      encoding: "utf8",
      env: fullEnv,
      ...processGuard(),
    }),
    { label: "sign-release-manifest" },
  );
  const calls = () =>
    readFileSync(logFile, "utf8")
      .split("\x1e")
      .filter(Boolean)
      .map((call) => call.split("\x1f").filter(Boolean));
  return { result, calls, keyFile, dir };
}

function manifestFixture(dir, digest = DIGEST) {
  const manifestPath = join(dir, "orbit-release-manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schema: "https://tomlawson.io/schemas/orbit-release-manifest/v1",
      version: "1.4.0",
      channel: "preview",
      commit: "a".repeat(40),
      image: { repository: "registry.example/ai/orbit", digest },
      launcher: { tag: "v1.2.3", commit: "b".repeat(40) },
      files: {},
      recordedAt: "2026-09-24T00:00:00Z",
    }),
  );
  return manifestPath;
}

describe("sign-release-manifest.sh", () => {
  it("signs the manifest with the pinned flags, no tlog, and the scoped key", () => {
    const dir = mkdtempSync(join(tmpdir(), "sign-fixture-"));
    const manifestPath = manifestFixture(dir);
    const { result, calls, keyFile } = run({ manifestPath });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`signed ${manifestPath}`);
    expect(result.stdout).toContain(`${manifestPath}.sig`);
    const [cosignCall] = calls();
    expect(cosignCall[1]).toContain("sign-blob");
    expect(cosignCall[1]).toContain(`--key ${keyFile}`);
    expect(cosignCall[1]).toContain("--tlog-upload=false");
    expect(cosignCall[1]).toContain("--use-signing-config=false");
    expect(cosignCall[1]).toContain(`--output-signature ${manifestPath}.sig`);
    expect(cosignCall[1]).toContain(manifestPath);
    expect(existsSync(`${manifestPath}.sig`)).toBe(true);
    expect(readFileSync(`${manifestPath}.sig`, "utf8").trim().length).toBeGreaterThan(0);
  });

  it("takes both key and password from ORBIT_SIGNING_DIR, the runner mount, when set", () => {
    const dir = mkdtempSync(join(tmpdir(), "sign-fixture-"));
    const manifestPath = manifestFixture(dir);
    const signingDir = mkdtempSync(join(tmpdir(), "orbit-signing-"));
    writeFileSync(join(signingDir, "cosign.key"), "TEST-PRIVATE-KEY-NOT-REAL\n");
    writeFileSync(join(signingDir, "password"), "TEST-PASSWORD-NOT-REAL\n");
    const { result, calls } = run({
      manifestPath,
      env: { ORBIT_SIGNING_DIR: signingDir },
      dropEnv: ["COSIGN_PRIVATE_KEY", "COSIGN_PASSWORD"],
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const [cosignCall] = calls();
    expect(cosignCall[1]).toContain(`--key ${join(signingDir, "cosign.key")}`);
  });

  it("refuses an ORBIT_SIGNING_DIR that is not a directory, naming the runner and the mount", () => {
    const dir = mkdtempSync(join(tmpdir(), "sign-fixture-"));
    const manifestPath = manifestFixture(dir);
    const { result } = run({
      manifestPath,
      env: { ORBIT_SIGNING_DIR: "/nonexistent/orbit-signing" },
      dropEnv: ["COSIGN_PRIVATE_KEY", "COSIGN_PASSWORD"],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ORBIT_SIGNING_DIR is not a directory");
    expect(result.stderr).toContain("orbit-signing runner");
  });

  it("refuses without COSIGN_PRIVATE_KEY, naming both ways the key can arrive", () => {
    const dir = mkdtempSync(join(tmpdir(), "sign-fixture-"));
    const manifestPath = manifestFixture(dir);
    const { result } = run({ manifestPath, dropEnv: ["COSIGN_PRIVATE_KEY"] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("COSIGN_PRIVATE_KEY is not set and ORBIT_SIGNING_DIR is not set either");
  });

  it("refuses without COSIGN_PASSWORD, naming where it comes from", () => {
    const dir = mkdtempSync(join(tmpdir(), "sign-fixture-"));
    const manifestPath = manifestFixture(dir);
    const { result } = run({ manifestPath, dropEnv: ["COSIGN_PASSWORD"] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("COSIGN_PASSWORD is not set");
  });

  it("refuses a missing manifest path argument", () => {
    const { result } = run({ args: [] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("a manifest path is required");
  });

  it("refuses a manifest path that does not exist", () => {
    const { result } = run({ args: ["/nonexistent/orbit-release-manifest.json", DIGEST] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no manifest at");
  });

  it("refuses a missing or malformed expected digest argument", () => {
    const dir = mkdtempSync(join(tmpdir(), "sign-fixture-"));
    const manifestPath = manifestFixture(dir);
    const missing = run({ args: [manifestPath] });
    expect(missing.result.status).toBe(1);
    expect(missing.result.stderr).toContain("an expected image digest is required");

    const malformed = run({ args: [manifestPath, "sha256:short"] });
    expect(malformed.result.status).toBe(1);
    expect(malformed.result.stderr).toContain("not an immutable manifest digest");
  });

  it("refuses a manifest whose image digest differs from what this pipeline tested", () => {
    const dir = mkdtempSync(join(tmpdir(), "sign-fixture-"));
    const manifestPath = manifestFixture(dir, OTHER_DIGEST);
    const { result } = run({ manifestPath, args: [manifestPath, DIGEST] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`differs from the digest this pipeline tested (${DIGEST})`);
    expect(existsSync(`${manifestPath}.sig`)).toBe(false);
  });

  it("refuses a manifest with no well-formed image.digest", () => {
    const dir = mkdtempSync(join(tmpdir(), "sign-fixture-"));
    const manifestPath = join(dir, "orbit-release-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ image: { digest: "not-a-digest" } }));
    const { result } = run({ manifestPath });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no well-formed image.digest");
  });

  it("fails when cosign fails, rather than reporting a signature that was not made", () => {
    const dir = mkdtempSync(join(tmpdir(), "sign-fixture-"));
    const manifestPath = manifestFixture(dir);
    const { result } = run({ manifestPath, env: { STUB_COSIGN_EXIT: "1" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`cosign could not sign ${manifestPath}`);
    expect(existsSync(`${manifestPath}.sig`)).toBe(false);
  });
});
