import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * The shape of the #661 split, asserted over .gitlab-ci.yml and the scripts
 * it calls. Criterion 6 is the one that matters: if the publishing job can
 * reach the signing key, the split is theatre. Within GitLab that boundary
 * is protected-environment settings plus review, not cryptography -- these
 * tests are what makes a quiet edit adding the environment (or a channel
 * tag, or a push) to the wrong job loud.
 */

const pipeline = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const publishChannelScript = readFileSync(
  new URL("./ci/publish-channel.sh", import.meta.url),
  "utf8",
);
const verifyScript = readFileSync(
  new URL("./ci/verify-validation-evidence.sh", import.meta.url),
  "utf8",
);
const ensureCosign = readFileSync(new URL("./ci/ensure-cosign.sh", import.meta.url), "utf8");

/**
 * One top-level job's configuration: from its unindented key to the next
 * one, with comment lines dropped so prose about a neighbouring job cannot
 * satisfy (or trip) an assertion about this one.
 */
function job(name) {
  const match = pipeline.match(new RegExp(`\\n${name}:\\n[\\s\\S]*?(?=\\n[a-z_]+:\\n|$)`, "u"));
  expect(match, `job ${name} exists`).not.toBeNull();
  return match[0]
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
}

const code = pipeline
  .split("\n")
  .filter((line) => !/^\s*#/u.test(line))
  .join("\n");

describe("the validation/publication split (#661)", () => {
  it("gives attest_image, and only attest_image, the validation-signing environment", () => {
    expect(job("attest_image")).toContain("name: validation-signing");
    const declarations = code.match(/name: validation-signing/gu) ?? [];
    expect(declarations).toHaveLength(1);
  });

  it("keeps every COSIGN_ variable out of the pipeline configuration itself", () => {
    // The key material reaches attest-tested-image.sh only through the
    // protected environment's scoping; no job hands it around explicitly.
    expect(code).not.toContain("COSIGN_");
  });

  it("lets attest_image push only the immutable sha- anchor and mint the evidence", () => {
    const section = job("attest_image");
    expect(section).toContain('sha_reference="${CI_REGISTRY_IMAGE}:sha-${CI_COMMIT_SHA}"');
    expect(section).toContain("scripts/ci/publish-image.sh");
    expect(section).toContain("scripts/ci/policy-version.sh");
    expect(section).toContain("scripts/ci/attest-tested-image.sh");
    expect(section).toContain('scripts/ci/gitlab-record-tested-image.sh');
    expect(section).toContain('"$policy_version"');
    // Never a consumer-visible name: no channel tag logic anywhere in it.
    expect(section).not.toContain("channel_tag");
    expect(section).not.toContain(":preview");
    expect(section).not.toContain("hotfix-");
    expect(section).not.toContain("publish-channel.sh");
  });

  it("lets publish_channel only consume: verify, re-check, tag -- never sign or push", () => {
    const section = job("publish_channel");
    expect(section).toContain("job: attest_image");
    expect(section).toContain("artifacts: true");
    expect(section).toContain("scripts/ci/publish-channel.sh");
    expect(section).not.toContain("attest-tested-image");
    expect(section).not.toContain("publish-image.sh");
    expect(section).not.toContain("docker push");
    expect(section).not.toContain("environment:");
    expect(section).not.toContain("image.tar");
  });

  it("runs both halves on exactly the same publishing lanes, uncancellable", () => {
    for (const name of ["attest_image", "publish_channel"]) {
      const section = job(name);
      expect(section, name).toContain(
        '- if: $CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "preview"',
      );
      expect(section, name).toContain(
        '- if: $CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH =~ /^hotfix\\//',
      );
      expect(section, name).toContain("interruptible: false");
    }
  });

  it("keeps the private key unreachable from the consuming scripts", () => {
    // The verifier holds the public key; publication holds neither.
    expect(publishChannelScript).not.toContain("COSIGN_PRIVATE");
    expect(publishChannelScript).not.toContain("COSIGN_PASSWORD");
    expect(verifyScript).not.toContain("COSIGN_PRIVATE");
    expect(verifyScript).not.toContain("COSIGN_PASSWORD");
    expect(verifyScript).toContain("COSIGN_PUBLIC_KEY");
  });

  it("pins cosign by version and release-binary checksum in one place", () => {
    expect(ensureCosign).toMatch(/COSIGN_VERSION="\d+\.\d+\.\d+"/u);
    expect(ensureCosign).toMatch(/COSIGN_SHA256="[0-9a-f]{64}"/u);
    // The only cosign download in the repository's CI scripts is this one.
    expect(publishChannelScript).not.toContain("github.com/sigstore/cosign");
    expect(verifyScript).not.toContain("github.com/sigstore/cosign");
  });
});
