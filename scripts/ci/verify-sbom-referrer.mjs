#!/usr/bin/env node
// Verifies one SBOM referrer's Sigstore bundle by the committed public key
// (#1848 D-S2): the DSSE envelope's signature, that it is an SPDX in-toto
// statement, and that its subject is the image digest being published. The
// publish workflow no longer runs it: its cosign check on each referrer
// replaced this (#1862).
//
// Usage: verify-sbom-referrer.mjs <bundle.json> <public-key.pem> <sha256:digest>
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { ORBIT_DIGEST_PATTERN } from "../release-metadata-patterns.mjs";

function fail(message) {
  process.stderr.write(`verify-sbom-referrer: ${message}\n`);
  process.exit(1);
}

const [bundlePath, keyPath, subjectDigest] = process.argv.slice(2);
if (!bundlePath || !keyPath || !ORBIT_DIGEST_PATTERN.test(subjectDigest ?? "")) {
  fail("usage: verify-sbom-referrer.mjs <bundle.json> <public-key.pem> <sha256:digest>");
}

let envelope;
try {
  envelope = JSON.parse(readFileSync(bundlePath, "utf8")).dsseEnvelope;
} catch (error) {
  fail(`the bundle cannot be read: ${error.message}`);
}
if (!envelope || typeof envelope.payload !== "string" || typeof envelope.payloadType !== "string" || !Array.isArray(envelope.signatures)) {
  fail("the bundle has no signed DSSE envelope");
}

const payload = Buffer.from(envelope.payload, "base64");
const pae = Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(envelope.payloadType)} ${envelope.payloadType} ${payload.length} `), payload]);
const key = createPublicKey(readFileSync(keyPath));
const signed = envelope.signatures.some((entry) => {
  try {
    return verify("sha256", pae, key, Buffer.from(String(entry.sig), "base64"));
  } catch {
    return false;
  }
});
if (!signed) fail("no signature on the envelope verifies under the committed key");

let statement;
try {
  statement = JSON.parse(payload.toString("utf8"));
} catch {
  fail("the signed payload is not JSON");
}
if (typeof statement.predicateType !== "string" || !statement.predicateType.startsWith("https://spdx.dev/Document")) {
  fail(`the predicate type is ${JSON.stringify(statement.predicateType)}, not an SPDX document`);
}
const wanted = subjectDigest.slice("sha256:".length);
if (!(statement.subject ?? []).some((subject) => subject?.digest?.sha256 === wanted)) {
  fail(`the statement's subject is not ${subjectDigest}`);
}
