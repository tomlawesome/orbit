import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// This suite spawns the real mailbox-acceptance checker; a spawn that takes
// tens of milliseconds quiet takes seconds on a starved core (#698). Budget
// and reasoning: scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = fileURLToPath(new URL("./acceptance-mailbox.mjs", import.meta.url));
const digest = `sha256:${"a".repeat(64)}`;
const revision = "b".repeat(40);

function run(overrides = {}) {
  const result = failOnProcessDeadline(spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ORBIT_EXPECTED_DIGEST: digest,
      ORBIT_IMAGE_DIGEST: digest,
      ORBIT_EXPECTED_REVISION: revision,
      ORBIT_IMAGE_REVISION: revision,
      ...overrides,
    },
    ...processGuard(),
  }), { label: "run" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ...result, record: output ? JSON.parse(output) : undefined };
}

describe("mailbox acceptance evidence", () => {
  it("rejects an exact image digest mismatch", () => {
    const result = run({ ORBIT_IMAGE_DIGEST: `sha256:${"c".repeat(64)}` });
    expect(result.status).toBe(1);
    expect(result.record).toEqual({ result: "failed", code: "exact_image_digest_mismatch" });
  });

  it("rejects an exact revision mismatch", () => {
    const result = run({ ORBIT_IMAGE_REVISION: "c".repeat(40) });
    expect(result.status).toBe(1);
    expect(result.record).toEqual({ result: "failed", code: "exact_revision_mismatch" });
  });

  it("rejects malformed and incomplete live proofs", () => {
    const malformed = run({ ORBIT_ACCEPTANCE_MODE: "live", ORBIT_ACCEPTANCE_PROOF: "not-json" });
    expect(malformed.status).toBe(1);
    expect(malformed.record).toEqual({ result: "failed", code: "invalid_sanitized_proof" });
    const invalidShape = run({ ORBIT_ACCEPTANCE_MODE: "live", ORBIT_ACCEPTANCE_PROOF: "null" });
    expect(invalidShape.status).toBe(1);
    expect(invalidShape.record).toEqual({ result: "failed", code: "invalid_sanitized_proof" });
    const incomplete = run({ ORBIT_ACCEPTANCE_MODE: "live", ORBIT_ACCEPTANCE_PROOF: JSON.stringify({ tls_verification: true }) });
    expect(incomplete.status).toBe(1);
    expect(incomplete.record.code).toBe("provider_acceptance_incomplete");
    expect(incomplete.record.mode).toBe("live");
    expect(Object.values(incomplete.record.stages).filter(Boolean)).toHaveLength(1);
  });

  it("classifies fake mode as synthetic and emits only sanitized evidence", () => {
    const result = run({
      ORBIT_ACCEPTANCE_MODE: "fake",
      ORBIT_ACCEPTANCE_PROOF: JSON.stringify({ smtpPassword: "must-not-appear" }),
    });
    expect(result.status).toBe(0);
    expect(result.record).toMatchObject({
      result: "synthetic_pass",
      code: "synthetic_only",
      classification: "synthetic_non_representative",
      mode: "fake",
      digest,
      revision,
    });
    expect(JSON.stringify(result.record)).not.toContain("must-not-appear");
    expect(result.record.stages).toEqual({
      tls_verification: true,
      envelope_recipient_preservation: true,
      reconnect_restart: true,
      idempotent_receipt: true,
      authenticated_review_link: true,
      content_free_notification: true,
      recovery: true,
    });
  });

  it("rejects arrays, unknown fields, and non-boolean stage values", () => {
    const proof = {
      tls_verification: true,
      envelope_recipient_preservation: true,
      reconnect_restart: true,
      idempotent_receipt: true,
      authenticated_review_link: true,
      content_free_notification: true,
      recovery: true,
    };
    const array = run({ ORBIT_ACCEPTANCE_MODE: "live", ORBIT_ACCEPTANCE_PROOF: JSON.stringify([]) });
    expect(array.status).toBe(1);
    expect(array.record).toEqual({ result: "failed", code: "invalid_sanitized_proof" });
    const unknown = run({ ORBIT_ACCEPTANCE_MODE: "live", ORBIT_ACCEPTANCE_PROOF: JSON.stringify({ ...proof, smtpPassword: "must-not-appear", providerResponse: "private provider details" }) });
    expect(unknown.status).toBe(1);
    expect(unknown.record).toEqual({ result: "failed", code: "invalid_sanitized_proof" });
    const nonBoolean = run({ ORBIT_ACCEPTANCE_MODE: "live", ORBIT_ACCEPTANCE_PROOF: JSON.stringify({ ...proof, recovery: "true" }) });
    expect(nonBoolean.status).toBe(1);
    expect(nonBoolean.record).toEqual({ result: "failed", code: "invalid_sanitized_proof" });
  });

  it("sanitizes a complete live proof to fixed fields only", () => {
    const proof = {
      tls_verification: true,
      envelope_recipient_preservation: true,
      reconnect_restart: true,
      idempotent_receipt: true,
      authenticated_review_link: true,
      content_free_notification: true,
      recovery: true,
    };
    const result = run({ ORBIT_ACCEPTANCE_MODE: "live", ORBIT_ACCEPTANCE_PROOF: JSON.stringify(proof) });
    expect(result.status).toBe(0);
    expect(result.record).toMatchObject({ result: "passed", code: "ok", mode: "live", digest, revision });
    expect(Object.keys(result.record)).toEqual(["result", "code", "mode", "digest", "revision", "stages"]);
  });
});
