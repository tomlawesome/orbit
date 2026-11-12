import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

/*
 * The one path from a tested image to GHCR since the mirror flip (#801 step
 * 5): GitLab builds, tests and publishes to registry.tomlawson.io, records
 * the digest and hands the image off to a draft release here (#1824); this
 * workflow verifies and copies that digest. Every case below guards a way
 * a different image could reach operators -- a rebuild here, a copy of
 * something other than the recorded digest, a tag that resolves elsewhere
 * after the copy, or evidence for another commit.
 */
const workflow = readFileSync(
  new URL("../.github/workflows/publish-from-gitlab.yml", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const awaitScript = readFileSync(
  new URL("./ci/github-await-handoff.sh", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const handoffLib = readFileSync(
  new URL("./ci/lib-github-handoff.sh", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const ci = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
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
    expect(workflow).toContain("run: bash scripts/ci/github-await-handoff.sh");
    expect(workflow).toContain('crane copy "${SOURCE}" "${image}:${tag}"');
    // From the throwaway registry the verifier checked, by the evidence's digest.
    expect(workflow).toContain("SOURCE: ${{ env.THROWAWAY_IMAGE }}@${{ steps.evidence.outputs.digest }}");
    expect(workflow).toContain("DIGEST: ${{ steps.evidence.outputs.digest }}");
    // The source must still be the digest the evidence names, and each tag
    // must resolve to it afterwards.
    expect(workflow).toContain('[[ "$(crane digest "${SOURCE}")" == "${DIGEST}" ]]');
    expect(workflow).toContain('[[ "${published}" == "${DIGEST}" ]]');
  });

  it("verifies GitLab's signed evidence with the shared verifier before copying anything (#1108)", () => {
    const load = workflow.indexOf("- name: Load the handoff into a throwaway registry");
    const verify = workflow.indexOf("- name: Verify GitLab's signed evidence before copying");
    const login = workflow.indexOf("- name: Log in to GHCR");
    const copy = workflow.indexOf("- name: Copy the exact tested digest");
    expect(load).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(load);
    expect(login).toBeGreaterThan(verify);
    expect(copy).toBeGreaterThan(login);
    const step = workflow.slice(verify, workflow.indexOf("\n      - name:", verify + 1));
    expect(step).toContain("run: bash scripts/ci/verify-validation-evidence.sh");
    // Against the throwaway registry holding exactly what GitLab handed off
    // (#1824), for this run's own digest, commit and ref.
    expect(step).toContain("ORBIT_IMAGE: ${{ env.THROWAWAY_IMAGE }}");
    expect(step).toContain("ORBIT_DIGEST: ${{ steps.evidence.outputs.digest }}");
    expect(step).toContain("ORBIT_COMMIT: ${{ github.sha }}");
    expect(step).toContain("ORBIT_REF: ${{ github.ref_name }}");
    expect(step).not.toContain("continue-on-error");
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

  it("holds the least privilege that can copy and attest, and no GitLab token (#1824)", () => {
    const header = workflow.slice(0, workflow.indexOf("\njobs:\n"));
    expect(header).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("attestations: write");
    expect(workflow).not.toContain("pull-requests: write");
    expect(workflow).toContain("persist-credentials: false");
    // The built-in token only, never on a command line.
    const secrets = [...workflow.matchAll(/secrets\.([A-Z_]+)/gu)].map((match) => match[1]).sort();
    expect([...new Set(secrets)]).toEqual(["GITHUB_TOKEN"]);
    expect(workflow).toContain("--password-stdin");
    expect(handoffLib).toContain('--header @"${gh_tmp}/auth-header"');
    expect(handoffLib).not.toContain('--header "Authorization');
  });

  // Owner decision 2026-09-24, #1107 option 21a: this automatic workflow
  // must not be able to change anything on the releases page -- only a
  // human-started workflow (release-on-tag.yml, countersign.yml) may.
  it("grants no contents: write anywhere (#1107)", () => {
    expect(workflow).not.toMatch(/contents:\s*write/);
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

// The handoff reader's behaviour is tested against a fake GitHub in
// scripts/ci/github-await-handoff.test.mjs; these pin the shared shape.
describe("github-await-handoff.sh", () => {
  it("waits out a missing handoff with a retry hint at the deadline", () => {
    expect(awaitScript).toContain("gave up after ${wait_minutes} minutes");
    expect(awaitScript).toContain("gh run rerun <id> --failed");
  });

  it("reads the evidence the jobs wrote, handed off in the shape they write", () => {
    // The record script, the handoff job and the reader must agree on the
    // file and its fields.
    expect(recordScript).toContain('output="${output_dir}/gitlab-tested-image.json"');
    expect(ci).toContain(".orbit-supply-chain/gitlab-tested-image.json \\\n");
    expect(ci).toContain(".orbit-supply-chain/image.spdx.json \\\n");
    expect(awaitScript).toContain("readonly EVIDENCE=gitlab-tested-image.json");
    expect(awaitScript).toContain("readonly SBOM=image.spdx.json");
    for (const field of ["commit", "ref", "pipelineId", "imageDigest", "imageReference", "recordedAt"]) {
      expect(recordScript).toContain(`"${field}":`);
      expect(awaitScript).toContain(field);
    }
  });

  it("refuses evidence for another commit, ref or pipeline, a foreign registry, or stale evidence", () => {
    expect(awaitScript).toContain('[[ "$recorded_commit" == "$ORBIT_COMMIT" ]]');
    expect(awaitScript).toContain('[[ "$recorded_ref" == "$ORBIT_REF" ]]');
    expect(awaitScript).toContain('[[ "$recorded_pipeline" == "$handoff_pipeline" ]]');
    // The shared name is anchored (^sha256:<64 hex>$) in release-metadata-patterns.sh (#1363).
    expect(awaitScript).toContain('[[ "$digest" =~ $ORBIT_DIGEST_PATTERN ]]');
    expect(awaitScript).toContain('[[ "$source_reference" == "${registry}/"*"@${digest}"');
    expect(awaitScript).toContain("7 * 24 * 3600");
  });
});

describe("gitlab-record-tested-image.sh", () => {
  // The job hands the script exactly what the reader later demands:
  // "<registry>/<path>@<digest>". Job 1504 (pipeline 247) pushed the image and
  // then failed here, because the reference check had no room for the "@"
  // (#818).
  const digest = `sha256:${"ab".repeat(32)}`;
  const reference = `registry.example/ai/orbit@${digest}`;
  const env = {
    ...process.env,
    CI_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    CI_COMMIT_REF_NAME: "preview",
    CI_PIPELINE_ID: "247",
    CI_PIPELINE_URL: "https://gitlab.example/ai/orbit/-/pipelines/247",
  };
  // The script writes under its own repository root, so each run gets a
  // throwaway copy of that layout rather than writing into this checkout.
  const run = (...args) => {
    const root = mkdtempSync(join(tmpdir(), "orbit-record-"));
    mkdirSync(join(root, "scripts", "ci"), { recursive: true });
    const script = join(root, "scripts", "ci", "gitlab-record-tested-image.sh");
    copyFileSync(new URL("./ci/gitlab-record-tested-image.sh", import.meta.url), script);
    copyFileSync(new URL("./release-metadata-patterns.sh", import.meta.url), join(root, "scripts", "release-metadata-patterns.sh"));
    const result = spawnSync("bash", [script, ...args], { cwd: root, env, encoding: "utf8" });
    return { ...result, output: join(root, ".orbit-supply-chain", "gitlab-tested-image.json") };
  };

  it("records the digest reference the publish job passes", () => {
    const result = run(reference, digest);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const written = JSON.parse(readFileSync(result.output, "utf8"));
    expect(written.imageReference).toBe(reference);
    expect(written.imageDigest).toBe(digest);
  });

  it("records the policy version when the caller binds one (#661), and omits it otherwise", () => {
    const policyVersion = `sha256:${"ef".repeat(32)}`;
    const withPolicy = run(reference, digest, policyVersion);
    expect(withPolicy.stderr).toBe("");
    expect(withPolicy.status).toBe(0);
    expect(JSON.parse(readFileSync(withPolicy.output, "utf8")).policyVersion).toBe(policyVersion);

    const withoutPolicy = run(reference, digest);
    expect(withoutPolicy.status).toBe(0);
    expect("policyVersion" in JSON.parse(readFileSync(withoutPolicy.output, "utf8"))).toBe(false);
  });

  it("refuses a malformed policy version rather than recording it", () => {
    const result = run(reference, digest, "v7-of-the-policy");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("policy version is not a sha256 value");
  });

  it("refuses a reference that names another digest, a tag, or nothing immutable", () => {
    for (const bad of [
      `registry.example/ai/orbit@sha256:${"cd".repeat(32)}`,
      "registry.example/ai/orbit:preview",
      "registry.example/ai/orbit",
      `registry.example/ai/orbit@${digest} --oops`,
    ]) {
      const result = run(bad, digest);
      expect(result.status, bad).toBe(1);
      expect(result.stderr, bad).toContain("image reference");
    }
  });
});
