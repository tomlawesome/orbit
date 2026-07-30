#!/usr/bin/env node

/**
 * Sanitized production-like mailbox acceptance record.
 *
 * The operator supplies ORBIT_EXPECTED_DIGEST and ORBIT_IMAGE_DIGEST from the
 * exact immutable image under test, plus ORBIT_EXPECTED_REVISION and
 * ORBIT_IMAGE_REVISION. In fake mode, deterministic adapter evidence is
 * explicitly synthetic and non-representative; it is never reported as live
 * provider acceptance. In live mode, an external provider harness supplies
 * only boolean stage proofs in JSON; credentials, addresses, headers, and
 * provider responses are intentionally not accepted as inputs or emitted as
 * evidence.
 */

import { writeFileSync } from "node:fs";

const stages = [
  "tls_verification",
  "envelope_recipient_preservation",
  "reconnect_restart",
  "idempotent_receipt",
  "authenticated_review_link",
  "content_free_notification",
  "recovery",
];

function fail(code) {
  const record = { result: "failed", code };
  emit(record);
  process.exitCode = 1;
}

function emit(record) {
  const serialized = `${JSON.stringify(record)}\n`;
  const target = process.env.ORBIT_ACCEPTANCE_EVIDENCE_FILE;
  if (target) writeFileSync(target, serialized, { encoding: "utf8", mode: 0o600 });
  else process.stdout.write(serialized);
}

const expectedDigest = process.env.ORBIT_EXPECTED_DIGEST;
const actualDigest = process.env.ORBIT_IMAGE_DIGEST;
const expectedRevision = process.env.ORBIT_EXPECTED_REVISION;
const actualRevision = process.env.ORBIT_IMAGE_REVISION;
if (!expectedDigest || !actualDigest || expectedDigest !== actualDigest || !/^sha256:[a-f0-9]{64}$/u.test(actualDigest)) {
  fail("exact_image_digest_mismatch");
} else if (!expectedRevision || !actualRevision || expectedRevision !== actualRevision || !/^[a-f0-9]{40,64}$/u.test(actualRevision)) {
  fail("exact_revision_mismatch");
} else {
  const mode = process.env.ORBIT_ACCEPTANCE_MODE === "fake" ? "fake" : "live";
  if (mode === "fake") {
    emit({
      result: "synthetic_pass",
      code: "synthetic_only",
      classification: "synthetic_non_representative",
      mode,
      digest: actualDigest,
      revision: actualRevision,
      stages: Object.fromEntries(stages.map((stage) => [stage, true])),
    });
  } else {
    let proof = {};
    try {
      const parsedProof = JSON.parse(process.env.ORBIT_ACCEPTANCE_PROOF ?? "{}");
      if (!parsedProof || typeof parsedProof !== "object" || Array.isArray(parsedProof)) throw new Error("invalid proof shape");
      const proofKeys = Object.keys(parsedProof);
      if (proofKeys.some((key) => !stages.includes(key)) || proofKeys.some((key) => typeof parsedProof[key] !== "boolean")) throw new Error("invalid proof fields");
      proof = parsedProof;
    } catch { fail("invalid_sanitized_proof"); }
    if (process.exitCode) process.exit();
    const evidence = Object.fromEntries(stages.map((stage) => [stage, proof[stage] === true]));
    const passed = stages.every((stage) => evidence[stage]);
    emit({
      result: passed ? "passed" : "failed",
      code: passed ? "ok" : "provider_acceptance_incomplete",
      mode,
      digest: actualDigest,
      revision: actualRevision,
      stages: evidence,
    });
    if (!passed) process.exitCode = 1;
  }
}
