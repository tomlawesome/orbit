import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

/*
 * scripts/ci/attest-tested-image.sh mints the validation attestation (#661).
 * Its likeliest failures are configuration -- the signing key material is
 * scoped to the validation-signing protected environment and silently absent
 * anywhere else -- so the preflight refusals must name the missing variable
 * and where it comes from, not just fail. cosign is stubbed on PATH; the
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
  "printf 'cosign\\x1f%s\\x1e' \"$*\" >> \"$STUB_LOG\"",
  'while [ "$#" -gt 0 ]; do',
  '  if [ "$1" = "--predicate" ]; then cp "$2" "$STUB_PREDICATE_COPY"; shift; fi',
  "  shift",
  "done",
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
  return { result, calls, predicate, keyFile };
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

  it("refuses without COSIGN_PRIVATE_KEY, naming the variable and its protected environment", () => {
    const { result } = run({ dropEnv: ["COSIGN_PRIVATE_KEY"] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("COSIGN_PRIVATE_KEY is not set");
    expect(result.stderr).toContain("validation-signing");
    expect(result.stderr).toContain("owner setup");
  });

  it("refuses a COSIGN_PRIVATE_KEY that is not a readable file", () => {
    const { result } = run({ env: { COSIGN_PRIVATE_KEY: "/nonexistent/cosign.key" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("COSIGN_PRIVATE_KEY does not point at a readable file");
    expect(result.stderr).toContain("File variable");
  });

  it("refuses without COSIGN_PASSWORD, naming the variable", () => {
    const { result } = run({ dropEnv: ["COSIGN_PASSWORD"] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("COSIGN_PASSWORD is not set");
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
