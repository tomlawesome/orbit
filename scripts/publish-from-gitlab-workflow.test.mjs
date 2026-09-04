import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * The one path from a tested image to GHCR since the mirror flip (#801 step
 * 5): GitLab builds, tests and publishes to registry.tomlawson.io and records
 * the digest; this workflow copies that digest. Every case below guards a way
 * a different image could reach operators -- a rebuild here, a copy of
 * something other than the recorded digest, a tag that resolves elsewhere
 * after the copy, or evidence for another commit.
 */
const workflow = readFileSync(
  new URL("../.github/workflows/publish-from-gitlab.yml", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const awaitScript = readFileSync(
  new URL("./ci/gitlab-await-tested-image.sh", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const recordScript = readFileSync(
  new URL("./ci/gitlab-record-tested-image.sh", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

describe("publish-from-gitlab workflow", () => {
  it("runs for the mirror's preview and hotfix pushes and never cancels one", () => {
    const trigger = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\nconcurrency:\n"));
    expect(trigger).toContain("      - preview\n");
    expect(trigger).toContain('      - "hotfix/**"\n');
    expect(trigger).not.toContain("      - dev\n");
    expect(trigger).not.toContain("      - main\n");
    expect(trigger).not.toContain("pull_request");
    expect(trigger).toContain("workflow_dispatch:");
    expect(workflow).toContain("cancel-in-progress: false");
  });

  it("copies the recorded digest without building anything", () => {
    expect(workflow).not.toContain("docker/build-push-action");
    expect(workflow).not.toContain("docker/setup-buildx-action");
    expect(workflow).not.toContain("Dockerfile");
    expect(workflow).toContain("run: bash scripts/ci/gitlab-await-tested-image.sh");
    expect(workflow).toContain('crane copy "${SOURCE}" "${image}:${tag}"');
    expect(workflow).toContain("SOURCE: ${{ steps.evidence.outputs.source_reference }}");
    expect(workflow).toContain("DIGEST: ${{ steps.evidence.outputs.digest }}");
    // The source must still be the digest the evidence names, and each tag
    // must resolve to it afterwards.
    expect(workflow).toContain('[[ "$(crane digest "${SOURCE}")" == "${DIGEST}" ]]');
    expect(workflow).toContain('[[ "${published}" == "${DIGEST}" ]]');
  });

  it("gives the channel tag only to the current head of the branch", () => {
    const tags = workflow.slice(
      workflow.indexOf("- name: Decide which tags this commit may take"),
      workflow.indexOf("- name: Copy the exact tested digest"),
    );
    expect(tags).toContain('tags="sha-${GITHUB_SHA}"');
    expect(tags).toContain('if [[ "${head}" == "${GITHUB_SHA}" ]]');
    expect(tags).toContain('tags="${tags} preview"');
    expect(workflow).not.toContain("type=raw,value=");
  });

  it("attests the copied digest with GitLab's SBOM and verifies both before recording", () => {
    const copy = workflow.indexOf("- name: Copy the exact tested digest");
    const attest = workflow.indexOf("- name: Attest published image provenance");
    const sbom = workflow.indexOf("- name: Attest published image SBOM");
    const verify = workflow.indexOf("- name: Verify published image attestations");
    const record = workflow.indexOf("- name: Record published image");

    expect(copy).toBeGreaterThanOrEqual(0);
    expect(attest).toBeGreaterThan(copy);
    expect(sbom).toBeGreaterThan(attest);
    expect(verify).toBeGreaterThan(sbom);
    expect(record).toBeGreaterThan(verify);
    expect(workflow).toContain("actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6");
    expect(workflow).toContain("subject-digest: ${{ steps.evidence.outputs.digest }}");
    expect(workflow).toContain("sbom-path: ${{ steps.evidence.outputs.sbom }}");
    expect(workflow).toContain("gh attestation verify");
    expect(workflow).toContain("oci://${REGISTRY}/${IMAGE_NAME}@${IMAGE_DIGEST}");
  });

  it("holds the least privilege that can copy and attest, and only a read token for GitLab", () => {
    const header = workflow.slice(0, workflow.indexOf("\njobs:\n"));
    expect(header).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("attestations: write");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("pull-requests: write");
    expect(workflow).toContain("persist-credentials: false");
    // Two GitLab secrets, both read-only, never on a command line.
    const secrets = [...workflow.matchAll(/secrets\.([A-Z_]+)/gu)].map((match) => match[1]).sort();
    expect([...new Set(secrets)]).toEqual(["GITHUB_TOKEN", "GITLAB_READ_TOKEN", "GITLAB_READ_TOKEN_NAME"]);
    expect(workflow).toContain("--password-stdin");
    expect(awaitScript).toContain("--header @\"$header_file\"");
    expect(awaitScript).not.toContain('--header "PRIVATE-TOKEN');
  });

  it("pins every third-party action to an immutable commit", () => {
    const actionReferences = [...workflow.matchAll(/^\s+uses:\s+([^#\s]+)(?:\s+#.*)?$/gmu)]
      .map((match) => match[1])
      .filter((reference) => !reference.startsWith("./"));

    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/@[0-9a-f]{40}$/u);
    }
  });
});

describe("gitlab-await-tested-image.sh", () => {
  it("accepts only a successful push pipeline for this exact commit and ref", () => {
    expect(awaitScript).toContain("sha=${ORBIT_COMMIT}&ref=${ORBIT_REF}&source=push");
    expect(awaitScript).toContain("success) break ;;");
    expect(awaitScript).toContain("failed|canceled|skipped)");
    expect(awaitScript).toContain("gave up after ${wait_minutes} minutes");
  });

  it("reads the evidence from the jobs that wrote it, in the shape they write", () => {
    // The record script and the reader must agree on the file and its fields.
    expect(recordScript).toContain('output="${output_dir}/gitlab-tested-image.json"');
    expect(awaitScript).toContain("artifacts/.orbit-supply-chain/gitlab-tested-image.json");
    expect(awaitScript).toContain("artifacts/.orbit-supply-chain/image.spdx.json");
    expect(awaitScript).toContain("job_id publish_gitlab");
    expect(awaitScript).toContain("job_id supply_chain_image");
    for (const field of ["commit", "ref", "pipelineId", "imageDigest", "imageReference", "recordedAt"]) {
      expect(recordScript).toContain(`"${field}":`);
      expect(awaitScript).toContain(field);
    }
  });

  it("refuses evidence for another commit, ref or pipeline, a foreign registry, or stale evidence", () => {
    expect(awaitScript).toContain('[[ "$recorded_commit" == "$ORBIT_COMMIT" ]]');
    expect(awaitScript).toContain('[[ "$recorded_ref" == "$ORBIT_REF" ]]');
    expect(awaitScript).toContain('[[ "$recorded_pipeline" == "$pipeline_id" ]]');
    expect(awaitScript).toContain('[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]');
    expect(awaitScript).toContain('[[ "$source_reference" == "${GITLAB_REGISTRY}/"*"@${digest}" ]]');
    expect(awaitScript).toContain("7 * 24 * 3600");
  });
});
