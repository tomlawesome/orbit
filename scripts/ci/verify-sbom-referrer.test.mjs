import { spawnSync } from "node:child_process";
import { generateKeyPairSync, createSign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

// #1848 D-S2 (ruling 2026-11-17): the publish workflow verifies each SBOM
// referrer by the committed key before copying it to GHCR, as it does the
// image's signed evidence. scripts/ci/verify-sbom-referrer.mjs <bundle>
// <public key> <subject digest> checks one referrer's Sigstore bundle.

const script = new URL("./verify-sbom-referrer.mjs", import.meta.url).pathname;
const workflow = readFileSync(new URL("../../.github/workflows/publish-from-gitlab.yml", import.meta.url), "utf8");
const dir = mkdtempSync(join(tmpdir(), "verify-sbom-referrer-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DIGEST = `sha256:${"a".repeat(64)}`;
const SPDX = "https://spdx.dev/Document/v2.3";
const keyPair = () => generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = (key) => key.export({ type: "spki", format: "pem" });
const pae = (type, payload) =>
  Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${payload.length} `), payload]);

function bundle({ signer, predicateType = SPDX, subject = DIGEST }) {
  const payloadType = "application/vnd.in-toto+json";
  const payload = Buffer.from(
    JSON.stringify({
      _type: "https://in-toto.io/Statement/v0.1",
      predicateType,
      subject: [{ name: "image", digest: { sha256: subject.slice("sha256:".length) } }],
      predicate: {},
    }),
  );
  const sig = createSign("sha256").update(pae(payloadType, payload)).sign(signer.privateKey);
  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    dsseEnvelope: { payload: payload.toString("base64"), payloadType, signatures: [{ sig: sig.toString("base64") }] },
  };
}

function run({ bundleJson, publicKey, subject = DIGEST }) {
  const bundlePath = join(dir, "bundle.json");
  const keyPath = join(dir, "key.pub");
  writeFileSync(bundlePath, JSON.stringify(bundleJson));
  writeFileSync(keyPath, publicKey);
  return spawnSync(process.execPath, [script, bundlePath, keyPath, subject], { encoding: "utf8" });
}

describe("scripts/ci/verify-sbom-referrer.mjs (#1848 D-S2)", () => {
  const good = keyPair();
  const other = keyPair();

  it("accepts an SBOM bundle signed by the committed key for the subject digest", () => {
    const r = run({ bundleJson: bundle({ signer: good }), publicKey: pem(good.publicKey) });
    expect(r.status, r.stderr).toBe(0);
  });

  it("refuses a bundle signed by another key", () => {
    const r = run({ bundleJson: bundle({ signer: other }), publicKey: pem(good.publicKey) });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/signature/iu);
  });

  it("refuses a bundle about another subject digest", () => {
    const r = run({ bundleJson: bundle({ signer: good, subject: `sha256:${"b".repeat(64)}` }), publicKey: pem(good.publicKey) });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/subject/iu);
  });

  it("refuses a bundle that is not an SPDX attestation", () => {
    const r = run({ bundleJson: bundle({ signer: good, predicateType: "https://slsa.dev/provenance/v1" }), publicKey: pem(good.publicKey) });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/predicate/iu);
  });

  it("refuses a bundle with no signed envelope", () => {
    const r = run({ bundleJson: { mediaType: "x" }, publicKey: pem(good.publicKey) });
    expect(r.status).not.toBe(0);
  });
});

describe("publish-from-gitlab copies an SBOM referrer only after it is verified by key (#1848 D-S2)", () => {
  const start = workflow.indexOf("- name: Copy the exact tested digest");
  const step = workflow.slice(start, workflow.indexOf("\n      - name:", start + 1));

  it("calls the referrer verifier before the referrer copy", () => {
    const verify = step.indexOf("verify-sbom-referrer.mjs");
    const copy = step.indexOf('crane copy "${THROWAWAY_IMAGE}@${referrer}"');
    expect(verify).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(verify);
  });
});
