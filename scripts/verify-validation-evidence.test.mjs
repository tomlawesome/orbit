import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

/*
 * scripts/ci/verify-validation-evidence.sh is the one shared verifier every
 * publishing hop runs before giving a validated digest a consumer-visible
 * name (#661). Each refusal path here is driven with a crafted input and
 * asserted by its *specific message and exit code*, never merely a non-zero
 * exit: an untested failure path is how #659 and ai/orbit-base-image#3 both
 * shipped, and #877 will be held to the same standard when it wires
 * promote_stable to this script.
 *
 * cosign is stubbed on PATH (the scripts/promote-stable.test.mjs pattern):
 * the stub stands in for signature verification only -- everything after
 * "cosign says these envelopes verified" is the real script judging real
 * crafted payloads.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./ci/verify-validation-evidence.sh", import.meta.url).pathname;
const attestScript = new URL("./ci/attest-tested-image.sh", import.meta.url).pathname;

const PREDICATE_TYPE = "https://tomlawson.io/attestations/orbit-validation/v1";
const IMAGE = "registry.tomlawson.io/ai/orbit";
const DIGEST = `sha256:${"1".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"2".repeat(64)}`;
const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);
const POLICY = `sha256:${"3".repeat(64)}`;
const OTHER_POLICY = `sha256:${"4".repeat(64)}`;

const COSIGN_STUB = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  "printf 'cosign\\x1f%s\\x1e' \"$*\" >> \"$STUB_LOG\"",
  'if [ -n "${STUB_COSIGN_FAIL:-}" ]; then',
  "  printf '%s\\n' \"$STUB_COSIGN_FAIL\" >&2",
  "  exit 1",
  "fi",
  'cat "$STUB_COSIGN_OUTPUT"',
  "exit 0",
  "",
].join("\n");

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

/** One verified DSSE envelope line, the shape `cosign verify-attestation` prints. */
function envelope({
  subjectDigest = DIGEST,
  imageDigest = DIGEST,
  commit = COMMIT,
  ref = "preview",
  pipelineId = 4242,
  pipelineUrl = "https://gitlab.tomlawson.io/ai/orbit/-/pipelines/4242",
  policyVersion = POLICY,
  recordedAt = isoDaysAgo(0),
  predicateType = PREDICATE_TYPE,
  predicateOverride = null,
} = {}) {
  const statement = {
    _type: "https://in-toto.io/Statement/v0.1",
    predicateType,
    subject: [{ name: IMAGE, digest: { sha256: subjectDigest.replace(/^sha256:/u, "") } }],
    predicate: predicateOverride ?? {
      commit,
      ref,
      pipelineId,
      pipelineUrl,
      imageDigest,
      policyVersion,
      recordedAt,
    },
  };
  return JSON.stringify({
    payloadType: "application/vnd.in-toto+json",
    payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
    signatures: [{ keyid: "", sig: "c3R1Yg==" }],
  });
}

function run({ lines = [envelope()], cosignFail = null, env = {}, withOutput = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "verify-evidence-"));
  const cosign = join(dir, "cosign");
  writeFileSync(cosign, COSIGN_STUB);
  chmodSync(cosign, 0o755);
  const outputFile = join(dir, "cosign-output");
  writeFileSync(outputFile, lines.join("\n") + (lines.length ? "\n" : ""));
  const logFile = join(dir, "calls.log");
  writeFileSync(logFile, "");
  const publicKey = join(dir, "cosign.pub");
  writeFileSync(publicKey, "-----BEGIN PUBLIC KEY-----\nTEST-NOT-A-REAL-KEY\n-----END PUBLIC KEY-----\n");
  const githubOutput = join(dir, "github-output");
  if (withOutput) writeFileSync(githubOutput, "");

  const result = failOnProcessDeadline(
    spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        ORBIT_IMAGE: IMAGE,
        ORBIT_DIGEST: DIGEST,
        ORBIT_COMMIT: COMMIT,
        ORBIT_REF: "preview",
        ORBIT_POLICY_VERSION: POLICY,
        ORBIT_COSIGN: cosign,
        COSIGN_PUBLIC_KEY: publicKey,
        STUB_LOG: logFile,
        STUB_COSIGN_OUTPUT: outputFile,
        ...(cosignFail ? { STUB_COSIGN_FAIL: cosignFail } : {}),
        ...(withOutput ? { GITHUB_OUTPUT: githubOutput } : {}),
        ...env,
      },
      ...processGuard(),
    }),
    { label: "verify-validation-evidence" },
  );
  const calls = () =>
    readFileSync(logFile, "utf8")
      .split("\x1e")
      .filter(Boolean)
      .map((call) => call.split("\x1f").filter(Boolean));
  const output = () => (withOutput ? readFileSync(githubOutput, "utf8") : "");
  return { result, calls, output };
}

describe("verify-validation-evidence.sh", () => {
  it("accepts one fresh matching attestation and reports what it accepted", () => {
    const { result, calls, output } = run({ withOutput: true });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`accepted ${DIGEST}`);
    expect(result.stdout).toContain(`commit ${COMMIT}`);
    expect(result.stdout).toContain(`policy ${POLICY}`);
    expect(output()).toContain("pipeline_url=https://gitlab.tomlawson.io/ai/orbit/-/pipelines/4242");
    expect(output()).toContain(`policy_version=${POLICY}`);
    // The verification cosign was asked for: committed key, expected type,
    // no transparency log (the attestor signs without uploading to one), and
    // the exact digest -- never a tag.
    const [cosignCall] = calls();
    expect(cosignCall[1]).toContain("verify-attestation");
    expect(cosignCall[1]).toContain(`--type ${PREDICATE_TYPE}`);
    expect(cosignCall[1]).toContain("--insecure-ignore-tlog=true");
    expect(cosignCall[1]).toContain(`${IMAGE}@${DIGEST}`);
  });

  it("refuses (mismatch, exit 10) evidence naming a different digest", () => {
    const { result } = run({ lines: [envelope({ imageDigest: OTHER_DIGEST })] });
    expect(result.status).toBe(10);
    expect(result.stderr).toContain(
      `refused (mismatch): evidence names digest ${OTHER_DIGEST}, not the digest being published (${DIGEST})`,
    );
  });

  it("refuses (mismatch, exit 10) an attestation whose subject is another digest", () => {
    const { result } = run({ lines: [envelope({ subjectDigest: OTHER_DIGEST })] });
    expect(result.status).toBe(10);
    expect(result.stderr).toContain("refused (mismatch)");
    expect(result.stderr).toContain(`not the digest being published (${DIGEST})`);
  });

  it("refuses (mismatch, exit 10) evidence for another commit", () => {
    const { result } = run({ lines: [envelope({ commit: OTHER_COMMIT })] });
    expect(result.status).toBe(10);
    expect(result.stderr).toContain(
      `refused (mismatch): evidence is for commit ${OTHER_COMMIT}, not the commit being published (${COMMIT})`,
    );
  });

  it("refuses (mismatch, exit 10) evidence for another ref when ORBIT_REF is set", () => {
    const { result } = run({ lines: [envelope({ ref: "dev" })] });
    expect(result.status).toBe(10);
    expect(result.stderr).toContain(
      "refused (mismatch): evidence is for ref dev, not the ref being published (preview)",
    );
  });

  it("refuses (mismatch, exit 10) evidence judged under an older policy, and says to re-validate", () => {
    const { result } = run({ lines: [envelope({ policyVersion: OTHER_POLICY })] });
    expect(result.status).toBe(10);
    expect(result.stderr).toContain("refused (mismatch): the policy changed since validation");
    expect(result.stderr).toContain(`judged under policy ${OTHER_POLICY}`);
    expect(result.stderr).toContain(`this checkout carries ${POLICY}`);
    expect(result.stderr).toContain("re-validate the digest");
  });

  it("refuses (missing, exit 11) when cosign verifies nothing, and shows cosign's reason", () => {
    const { result } = run({ cosignFail: "no matching attestations: crafted registry error" });
    expect(result.status).toBe(11);
    expect(result.stderr).toContain("cosign: no matching attestations: crafted registry error");
    expect(result.stderr).toContain(
      `refused (missing): no verifiable validation attestation of type ${PREDICATE_TYPE} for ${IMAGE}@${DIGEST}`,
    );
  });

  it("refuses (missing, exit 11) a digest the registry cannot resolve", () => {
    // The registry answering MANIFEST_UNKNOWN and the digest having no
    // attestation are one ground to a publisher: no evidence for this exact
    // digest. Both must land on `missing`, never on a pass.
    const { result } = run({
      cosignFail: "GET https://registry.tomlawson.io/v2/ai/orbit/manifests/sha256:...: MANIFEST_UNKNOWN",
    });
    expect(result.status).toBe(11);
    expect(result.stderr).toContain("cosign: ");
    expect(result.stderr).toContain("MANIFEST_UNKNOWN");
    expect(result.stderr).toContain(
      `refused (missing): no verifiable validation attestation of type ${PREDICATE_TYPE} for ${IMAGE}@${DIGEST}`,
    );
  });

  it("refuses (missing, exit 11) verified attestations of only some other predicate type", () => {
    const { result } = run({
      lines: [envelope({ predicateType: "https://slsa.dev/provenance/v1" })],
    });
    expect(result.status).toBe(11);
    expect(result.stderr).toContain(
      `refused (missing): cosign verified 1 attestation(s) for the digest, but none carries predicate type ${PREDICATE_TYPE}`,
    );
  });

  it("refuses (missing, exit 11) a verified attestation whose predicate is malformed", () => {
    const { result } = run({
      lines: [envelope({ predicateOverride: { commit: COMMIT, recordedAt: "yesterday-ish" } })],
    });
    expect(result.status).toBe(11);
    expect(result.stderr).toContain("refused (missing):");
    expect(result.stderr).toContain("no well-formed");
    expect(result.stderr).toContain("unusable as evidence");
  });

  it("refuses (ambiguous, exit 12) two verified attestations that disagree", () => {
    const { result } = run({
      lines: [envelope({ pipelineId: 4242 }), envelope({ pipelineId: 9999 })],
    });
    expect(result.status).toBe(12);
    expect(result.stderr).toContain(
      "refused (ambiguous): 2 verified attestations make 2 conflicting claims about what was validated",
    );
    expect(result.stderr).toContain("refusing to choose between them");
  });

  it("treats identical claims differing only in recordedAt as one item, newest governing expiry", () => {
    // The older stamp is past the window; the newest is fresh. A retried
    // attesting job must not be read as a conflict, and must not expire the
    // evidence its retry refreshed.
    const { result } = run({
      lines: [envelope({ recordedAt: isoDaysAgo(8) }), envelope({ recordedAt: isoDaysAgo(1) })],
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`accepted ${DIGEST}`);
  });

  it("refuses (expired, exit 13) evidence eight days old, and says to re-validate", () => {
    const stamp = isoDaysAgo(8);
    const { result } = run({ lines: [envelope({ recordedAt: stamp })] });
    expect(result.status).toBe(13);
    expect(result.stderr).toContain(
      `refused (expired): evidence recorded at ${stamp} is older than 7 days; re-validate the digest before publishing`,
    );
  });

  it("refuses (expired, exit 13) evidence stamped in the future", () => {
    const stamp = isoDaysAgo(-1);
    const { result } = run({ lines: [envelope({ recordedAt: stamp })] });
    expect(result.status).toBe(13);
    expect(result.stderr).toContain(
      `refused (expired): evidence recorded at ${stamp} is in the future; refusing evidence from a skewed clock`,
    );
  });

  it("fails closed, naming the file, when the committed public key is absent", () => {
    const { result } = run({ env: { COSIGN_PUBLIC_KEY: "/nonexistent/cosign.pub" } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("the validation public key is not at /nonexistent/cosign.pub");
    expect(result.stderr).toContain("without it nothing can be verified");
  });

  it("rejects a malformed digest as misconfiguration, not a refusal", () => {
    const { result } = run({ env: { ORBIT_DIGEST: "sha256:short" } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ORBIT_DIGEST is not an immutable manifest digest");
  });

  it("carries the same predicate type as the attestor, so the two cannot drift", () => {
    const constant = (path) =>
      readFileSync(path, "utf8").match(/PREDICATE_TYPE="([^"]+)"/u)?.[1];
    expect(constant(script)).toBe(PREDICATE_TYPE);
    expect(constant(attestScript)).toBe(PREDICATE_TYPE);
  });
});
