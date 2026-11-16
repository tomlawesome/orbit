import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

/*
 * scripts/ci/attest-tested-image.sh mints the validation attestation (#661).
 * Its likeliest failures are configuration -- the signing key material
 * exists only on the orbit-signing runner's host mount and is silently
 * absent anywhere else -- so the preflight refusals must name the missing
 * piece and where it comes from, not just fail. cosign is stubbed on PATH; the
 * stub copies the --predicate file before the script's cleanup trap removes
 * it, so the test can judge exactly what would have been signed.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./ci/attest-tested-image.sh", import.meta.url).pathname;

const PREDICATE_TYPE = "https://tomlawson.io/attestations/orbit-validation/v1";
const DIGEST = `sha256:${"1".repeat(64)}`;
const REFERENCE = `registry.tomlawson.io/ai/orbit@${DIGEST}`;
const COMMIT = "a".repeat(40);
const POLICY = `sha256:${"3".repeat(64)}`;

const COSIGN_STUB = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  "# cosign is a Cobra CLI: an unknown subcommand and an unknown flag both exit",
  "# 1, printing `unknown command \"x\" for \"cosign\"` / `unknown flag: --x`.",
  "# Checked against the pinned cosign v3.1.3 binary on 2026-09-08",
  "# (scripts/ci/ensure-cosign.sh names the pin); scripts/tool-parity.test.mjs",
  "# re-asserts it whenever a cosign of that version is on PATH. Before #616",
  "# this stub answered every subcommand and every flag alike, so the caller",
  "# could have grown a flag cosign has never had and stayed green.",
  "refuse() {",
  "  printf 'Error: %s\\n' \"$1\" >&2",
  "  printf 'error during command execution: %s\\n' \"$1\" >&2",
  "  exit 1",
  "}",
  "printf 'cosign\\x1f%s\\x1e' \"$*\" >> \"$STUB_LOG\"",
  '[ "${1:-}" = "attest" ] || refuse "unknown command \\"${1:-}\\" for \\"cosign\\""',
  "shift",
  '# scripts/ci/attest-tested-image.sh issues exactly --predicate, --type,',
  '# --key, --use-signing-config=false, --tlog-upload=false and --yes, then the',
  '# reference. Anything else is a drift this stub must refuse rather than',
  '# absorb; the two =false flags have to be given together on cosign v3, which',
  '# is why the caller carries both.',
  'while [ "$#" -gt 0 ]; do',
  '  case "$1" in',
  '    --predicate)',
  '      [ "$#" -ge 2 ] || refuse "flag needs an argument: --predicate"',
  '      predicate_path="$2"',
  "      shift 2",
  "      ;;",
  '    --type)',
  '      [ "$#" -ge 2 ] || refuse "flag needs an argument: $1"',
  '      attest_type="$2"',
  "      shift 2",
  "      ;;",
  '    --key)',
  '      [ "$#" -ge 2 ] || refuse "flag needs an argument: $1"',
  "      shift 2",
  "      ;;",
  '    --use-signing-config|--use-signing-config=*|--tlog-upload|--tlog-upload=*)',
  '      case "$1" in *=*) shift ;; *) shift 2 ;; esac',
  "      ;;",
  '    -y|--yes) shift ;;',
  '    --*) refuse "unknown flag: ${1%%=*}" ;;',
  "    *) shift ;;",
  "  esac",
  "done",
  '# D-S6 43a: the script now attests two predicates (validation record and',
  '# SPDX SBOM). The validation predicate lands in $STUB_PREDICATE_COPY, the',
  '# SBOM one in $STUB_PREDICATE_COPY.spdxjson.',
  'case "${attest_type:-}" in',
  '  spdxjson) cp "${predicate_path:?}" "$STUB_PREDICATE_COPY.spdxjson" ;;',
  '  *) cp "${predicate_path:?}" "$STUB_PREDICATE_COPY" ;;',
  "esac",
  '[ "${attest_type:-}" != "${STUB_FAIL_TYPE:-}" ] || refuse "crafted failure attesting ${attest_type}"',
  'exit "${STUB_COSIGN_EXIT:-0}"',
  "",
].join("\n");

function run({ args = [REFERENCE, DIGEST], env = {}, dropEnv = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "attest-tested-"));
  const cosign = join(dir, "cosign");
  writeFileSync(cosign, COSIGN_STUB);
  chmodSync(cosign, 0o755);
  const logFile = join(dir, "calls.log");
  writeFileSync(logFile, "");
  const keyFile = join(dir, "cosign.key");
  writeFileSync(keyFile, "TEST-PRIVATE-KEY-NOT-REAL\n");
  const predicateCopy = join(dir, "predicate.json");

  const fullEnv = {
    PATH: process.env.PATH,
    COSIGN_PRIVATE_KEY: keyFile,
    COSIGN_PASSWORD: "TEST-PASSWORD-NOT-REAL",
    CI_COMMIT_SHA: COMMIT,
    CI_COMMIT_REF_NAME: "preview",
    CI_PIPELINE_ID: "4242",
    CI_PIPELINE_URL: "https://gitlab.tomlawson.io/ai/orbit/-/pipelines/4242",
    ORBIT_POLICY_VERSION: POLICY,
    ORBIT_COSIGN: cosign,
    STUB_LOG: logFile,
    STUB_PREDICATE_COPY: predicateCopy,
    ...env,
  };
  for (const name of dropEnv) delete fullEnv[name];

  const result = failOnProcessDeadline(
    spawnSync("bash", [script, ...args], { encoding: "utf8", env: fullEnv, ...processGuard() }),
    { label: "attest-tested-image" },
  );
  const calls = () =>
    readFileSync(logFile, "utf8")
      .split("\x1e")
      .filter(Boolean)
      .map((call) => call.split("\x1f").filter(Boolean));
  const predicate = () => (existsSync(predicateCopy) ? JSON.parse(readFileSync(predicateCopy, "utf8")) : null);
  const sbomPredicate = () => (existsSync(`${predicateCopy}.spdxjson`) ? readFileSync(`${predicateCopy}.spdxjson`, "utf8") : null);
  return { result, calls, predicate, sbomPredicate, keyFile };
}

describe("attest-tested-image.sh", () => {
  it("attests the digest with the pinned predicate type, no tlog, and the scoped key", () => {
    const { result, calls, keyFile } = run();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`attested ${DIGEST} (policy ${POLICY})`);
    const [cosignCall] = calls();
    expect(cosignCall[1]).toContain("attest");
    expect(cosignCall[1]).toContain(`--type ${PREDICATE_TYPE}`);
    expect(cosignCall[1]).toContain(`--key ${keyFile}`);
    expect(cosignCall[1]).toContain("--tlog-upload=false");
    // Both are required together on cosign v3: --use-signing-config defaults
    // to true and cosign refuses --tlog-upload=false alongside it.
    expect(cosignCall[1]).toContain("--use-signing-config=false");
    expect(cosignCall[1]).toContain(REFERENCE);
  });

  it("binds the commit, ref, pipeline, digest and policy version into the predicate", () => {
    const { predicate } = run();
    const written = predicate();
    expect(written).toMatchObject({
      commit: COMMIT,
      ref: "preview",
      pipelineId: 4242,
      pipelineUrl: "https://gitlab.tomlawson.io/ai/orbit/-/pipelines/4242",
      imageDigest: DIGEST,
      policyVersion: POLICY,
    });
    expect(written.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
  });

  // D-S6 43a (#1848): the SBOM is attested itself, as a second cosign
  // attestation (--type spdxjson) over the same digest with the same key and
  // flags; the validation predicate no longer carries sbomSha256 (#1824).
  // The SBOM file is still named by ORBIT_SBOM_FILE.
  describe("the SBOM attestation (D-S6 43a)", () => {
    const content = '{"spdxVersion":"SPDX-2.3","name":"the genuine one"}\n';
    const sbomFile = () => {
      const sbom = join(mkdtempSync(join(tmpdir(), "attest-sbom-")), "image.spdx.json");
      writeFileSync(sbom, content);
      return sbom;
    };

    it("attests the SBOM as spdxjson over the same digest, with the same key and flags as the validation record", () => {
      const { result, calls, keyFile, sbomPredicate } = run({ env: { ORBIT_SBOM_FILE: sbomFile() } });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const all = calls().map((call) => call[1]);
      expect(all).toHaveLength(2);
      const sbomCall = all.find((call) => /--type spdxjson(\s|$)/u.test(call));
      const validationCall = all.find((call) => call.includes(`--type ${PREDICATE_TYPE}`));
      expect(sbomCall, "an spdxjson attestation").toBeDefined();
      expect(validationCall, "the validation attestation").toBeDefined();
      for (const call of [sbomCall, validationCall]) {
        expect(call).toMatch(/^attest\b/u);
        expect(call).toContain(`--key ${keyFile}`);
        expect(call).toContain("--tlog-upload=false");
        expect(call).toContain("--use-signing-config=false");
        expect(call).toContain("--yes");
        expect(call.endsWith(REFERENCE)).toBe(true);
      }
      // The attested predicate is the SBOM file, byte for byte.
      expect(sbomPredicate()).toBe(content);
    });

    it("leaves sbomSha256 out of the validation predicate, whatever the SBOM", () => {
      const { predicate } = run({ env: { ORBIT_SBOM_FILE: sbomFile() } });
      expect(predicate()).not.toHaveProperty("sbomSha256");
      expect(predicate()).toMatchObject({ commit: COMMIT, ref: "preview", imageDigest: DIGEST, policyVersion: POLICY });
      expect(readFileSync(script, "utf8")).not.toContain("sbomSha256");
    });

    it("without an SBOM file attests the validation record only, as before", () => {
      const { result, calls, sbomPredicate } = run();
      expect(result.status).toBe(0);
      expect(calls()).toHaveLength(1);
      expect(sbomPredicate()).toBeNull();
    });

    it("fails, naming the SBOM, when cosign cannot attest it, and does not report success", () => {
      const { result } = run({ env: { ORBIT_SBOM_FILE: sbomFile(), STUB_FAIL_TYPE: "spdxjson" } });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/SBOM|spdxjson/u);
      expect(result.stdout).not.toContain(`attested ${DIGEST}`);
    });
  });

  it("refuses an ORBIT_SBOM_FILE that cannot be read, signing nothing", () => {
    const { result, calls } = run({ env: { ORBIT_SBOM_FILE: "/nonexistent/image.spdx.json" } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ORBIT_SBOM_FILE");
    expect(calls()).toEqual([]);
  });

  it("takes both key and password from ORBIT_SIGNING_DIR, the runner mount, when set", () => {
    // How CI actually runs it: sign_evidence passes only the mount path, so
    // no COSIGN_ value ever appears in the pipeline configuration.
    const signingDir = mkdtempSync(join(tmpdir(), "orbit-signing-"));
    writeFileSync(join(signingDir, "cosign.key"), "TEST-PRIVATE-KEY-NOT-REAL\n");
    writeFileSync(join(signingDir, "password"), "TEST-PASSWORD-NOT-REAL\n");
    const { result, calls } = run({
      env: { ORBIT_SIGNING_DIR: signingDir },
      dropEnv: ["COSIGN_PRIVATE_KEY", "COSIGN_PASSWORD"],
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const [cosignCall] = calls();
    expect(cosignCall[1]).toContain(`--key ${join(signingDir, "cosign.key")}`);
  });

  it("refuses an ORBIT_SIGNING_DIR that is not a directory, naming the runner and the mount", () => {
    const { result } = run({
      env: { ORBIT_SIGNING_DIR: "/nonexistent/orbit-signing" },
      dropEnv: ["COSIGN_PRIVATE_KEY", "COSIGN_PASSWORD"],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ORBIT_SIGNING_DIR is not a directory");
    expect(result.stderr).toContain("orbit-signing runner");
    expect(result.stderr).toContain("owner setup");
  });

  it("refuses an ORBIT_SIGNING_DIR with no password file, naming the missing file", () => {
    const signingDir = mkdtempSync(join(tmpdir(), "orbit-signing-"));
    writeFileSync(join(signingDir, "cosign.key"), "TEST-PRIVATE-KEY-NOT-REAL\n");
    const { result } = run({
      env: { ORBIT_SIGNING_DIR: signingDir },
      dropEnv: ["COSIGN_PRIVATE_KEY", "COSIGN_PASSWORD"],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ORBIT_SIGNING_DIR has no password file");
    expect(result.stderr).toContain(`${signingDir}/password`);
  });

  it("refuses without COSIGN_PRIVATE_KEY, naming both ways the key can arrive", () => {
    const { result } = run({ dropEnv: ["COSIGN_PRIVATE_KEY"] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("COSIGN_PRIVATE_KEY is not set and ORBIT_SIGNING_DIR is not set either");
    expect(result.stderr).toContain("signing runner mount");
  });

  it("refuses a COSIGN_PRIVATE_KEY that is not a readable file", () => {
    const { result } = run({ env: { COSIGN_PRIVATE_KEY: "/nonexistent/cosign.key" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("COSIGN_PRIVATE_KEY does not point at a readable file");
    expect(result.stderr).toContain("ORBIT_SIGNING_DIR/cosign.key");
  });

  it("refuses without COSIGN_PASSWORD, naming where it comes from", () => {
    const { result } = run({ dropEnv: ["COSIGN_PASSWORD"] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("COSIGN_PASSWORD is not set");
    expect(result.stderr).toContain("ORBIT_SIGNING_DIR/password");
  });

  it("refuses a malformed digest and a reference naming a different digest", () => {
    const malformed = run({ args: [REFERENCE, "sha256:short"] });
    expect(malformed.result.status).toBe(1);
    expect(malformed.result.stderr).toContain("image digest is not an immutable manifest digest");

    const disagreeing = run({
      args: [`registry.tomlawson.io/ai/orbit@sha256:${"2".repeat(64)}`, DIGEST],
    });
    expect(disagreeing.result.status).toBe(1);
    expect(disagreeing.result.stderr).toContain(`does not name digest ${DIGEST}`);
  });

  it("fails when cosign fails, rather than reporting an attestation that was not made", () => {
    const { result } = run({ env: { STUB_COSIGN_EXIT: "1" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`cosign could not attest ${REFERENCE}`);
  });
});
