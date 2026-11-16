import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * The shape of the #661 split, asserted over .gitlab-ci.yml and the scripts
 * it calls. Criterion 6 is the one that matters: if the publishing job can
 * reach the signing key, the split is theatre. This instance is GitLab CE,
 * which has no protected environments (an EE feature): a variable can be
 * scoped to an environment, but any branch can declare that environment in
 * its own pipeline file and receive the variable, so an environment narrows
 * exposure and fences nothing. The key therefore lives on the
 * `orbit-signing` runner's host and reaches exactly one job, by runner tag;
 * within the pipeline config that boundary is review plus these tests, which
 * make a quiet edit moving the tag (or a channel tag, or a push) to the
 * wrong job loud. ADR-0020 records the whole story.
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
  it("gives sign_evidence, and only sign_evidence, the orbit-signing runner tag", () => {
    // The runner is the fence on CE: its host mounts the key material, it is
    // protected (unprotected refs get no runner) and locked to this project.
    // A second job with this tag would reach the key, so any new occurrence
    // must fail here and be argued for in review.
    expect(job("sign_evidence")).toContain("- orbit-signing");
    const declarations = code.match(/- orbit-signing/gu) ?? [];
    expect(declarations).toHaveLength(1);
  });

  it("declares only the ci-read-tokens, ci-issue-token and github-handoff environments, and never on sign_evidence", () => {
    // CE has no protected environments, so an `environment:` block is not a
    // key fence: a branch can declare one in its own pipeline file and
    // receive whatever is scoped to it. That is how the first cut of this
    // split shipped a fence that did not exist (ADR-0020). The one
    // environment allowed here, `ci-read-tokens`, scopes three read-only
    // tokens to the jobs that read them (v0.3.2 audit, owner 2026-10-28).
    // `ci-issue-token` does the same for SIDECAR_ISSUE_TOKEN, keeping it out
    // of every job that installs dependencies (v0.3.6 security pass, D-SEC2);
    // like the first, it fences off a compromised dependency, not a branch
    // author. `github-handoff` scopes GITHUB_HANDOFF_TOKEN to the one job
    // that writes the handoff repository, handoff_to_github (argued for in
    // #1824, note 57596); no other job may declare it. A fourth name, or an
    // environment on the signing job, must fail here and be argued for in
    // review.
    const environments = code.match(/^\s*environment:\n\s*name: (\S+)/gmu) ?? [];
    expect(environments.length).toBeGreaterThan(0);
    for (const block of environments) {
      expect(block).toMatch(/name: (?:ci-read-tokens|ci-issue-token|github-handoff)$/u);
    }
    expect(code.match(/environment:/gu)).toHaveLength(environments.length);
    expect(job("sign_evidence")).not.toContain("environment:");
    // github-handoff belongs to handoff_to_github alone.
    expect(job("handoff_to_github")).toMatch(/environment:\n\s*name: github-handoff\b/u);
    expect(code.match(/name: github-handoff\b/gu)).toHaveLength(1);
    expect(code).not.toContain("validation-signing");
  });

  it("keeps every COSIGN_ variable out of the pipeline configuration itself", () => {
    // The key material reaches attest-tested-image.sh only through the
    // signing runner's ORBIT_SIGNING_DIR mount; no job hands it around
    // explicitly, and nothing COSIGN_-shaped belongs in this file.
    expect(code).not.toContain("COSIGN_");
  });

  it("lets record_image push only the immutable sha- anchor and record the evidence", () => {
    const section = job("record_image");
    expect(section).toContain('sha_reference="${CI_REGISTRY_IMAGE}:sha-${CI_COMMIT_SHA}"');
    expect(section).toContain("scripts/ci/publish-image.sh");
    expect(section).toContain("scripts/ci/policy-version.sh");
    expect(section).toContain('scripts/ci/gitlab-record-tested-image.sh');
    expect(section).toContain('"$policy_version"');
    // Never a consumer-visible name, and never signing capability.
    expect(section).not.toContain("channel_tag");
    expect(section).not.toContain(":preview");
    expect(section).not.toContain("hotfix-");
    expect(section).not.toContain("publish-channel.sh");
    expect(section).not.toContain("attest-tested-image");
    expect(section).not.toContain("ORBIT_SIGNING_DIR");
  });

  it("waits on screens_chromium and on none of the nightly-only browser jobs (#1151 RANGE-F3, #1615, #1763)", () => {
    // #1763: the four rig and film jobs run only in the nightly browser
    // pipeline, so record_image must not wait on them (a preview push has no
    // such job). screens_chromium keeps its rules and keeps gating it.
    const section = job("record_image");
    expect(section).toContain("job: screens_chromium");
    for (const name of ["rig_chromium", "rig_firefox", "rig_webkit", "film_webkit"]) expect(section).not.toContain(`job: ${name}`);
    expect(section).not.toContain("job: fidelity");
    expect(section).not.toContain("job: smoke_firefox");
  });

  it("lets sign_evidence only sign: never build, push bytes, or tag", () => {
    const section = job("sign_evidence");
    expect(section).toContain("job: record_image");
    expect(section).toContain("artifacts: true");
    expect(section).toContain("scripts/ci/attest-tested-image.sh");
    expect(section).toContain("ORBIT_SIGNING_DIR");
    expect(section).not.toContain("publish-image.sh");
    expect(section).not.toContain("publish-channel.sh");
    expect(section).not.toContain("docker push");
    expect(section).not.toContain("imagetools");
    expect(section).not.toContain("image.tar");
    expect(section).not.toContain("channel_tag");
    // No daemon: extends .dind would drag the service and the privileged
    // runner tag along, putting signing back on the shared build runner.
    expect(section).not.toContain("extends: .dind");
  });

  it("lets publish_channel only consume: verify, re-check, tag -- never sign or push", () => {
    const section = job("publish_channel");
    expect(section).toContain("job: record_image");
    expect(section).toContain("artifacts: true");
    expect(section).toContain("job: sign_evidence");
    expect(section).toContain("scripts/ci/publish-channel.sh");
    expect(section).not.toContain("attest-tested-image");
    expect(section).not.toContain("ORBIT_SIGNING_DIR");
    expect(section).not.toContain("publish-image.sh");
    expect(section).not.toContain("docker push");
    expect(section).not.toContain("image.tar");
  });

  it("runs all three on exactly the same publishing lanes, uncancellable", () => {
    for (const name of ["record_image", "sign_evidence", "publish_channel"]) {
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
