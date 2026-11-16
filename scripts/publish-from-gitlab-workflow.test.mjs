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
 * the digest and hands the image off to a release in the separate public
 * <owner>/orbit-handoff repository (#1824); this workflow verifies and copies
 * that digest. Every case below guards a way
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

  it("publishes the SBOM the verifier extracted from GitLab's signed attestation, not a handed-off file (D-S6 43a)", () => {
    const verify = workflow.indexOf("- name: Verify GitLab's signed evidence before copying");
    const step = workflow.slice(verify, workflow.indexOf("\n      - name:", verify + 1));
    // The verifier writes the verified SPDX document to ORBIT_SBOM_OUT, and the
    // SBOM attestation step later reads exactly that path.
    const out = step.match(/^\s*ORBIT_SBOM_OUT: (.+)$/mu)?.[1]?.trim();
    expect(out, "ORBIT_SBOM_OUT in the verify step").toBeTruthy();
    expect(workflow).toContain(`sbom-path: ${out}`);
    expect(workflow.indexOf("sbom-path:")).toBeGreaterThan(verify);
    // Nothing takes the SBOM from the handoff any more.
    expect(workflow).not.toContain("steps.evidence.outputs.sbom");
    expect(workflow).not.toContain("ORBIT_SBOM_FILE");
  });

  it("copies the spdxjson referrers to GHCR along with the validation ones (D-S6 43a addendum 4)", () => {
    const copy = workflow.indexOf("- name: Copy the exact tested digest");
    const step = workflow.slice(copy, workflow.indexOf("\n      - name:", copy + 1));
    expect(step).toContain("https://spdx.dev/Document");
    // Still the validation type too, still copied by digest.
    expect(step).toContain("PREDICATE_TYPE");
    expect(step).toContain("dev.sigstore.bundle.predicateType");
    expect(step).toMatch(/crane copy "\$\{THROWAWAY_IMAGE\}@\$\{referrer\}"/u);
  });

  it("makes the GHCR verify step demand the SBOM attestation, writing it to a temporary path (D-S6 43a addendum 4)", () => {
    const arrival = workflow.indexOf("- name: Verify GitLab's evidence arrived on GHCR");
    expect(arrival).toBeGreaterThanOrEqual(0);
    const step = workflow.slice(arrival, workflow.indexOf("\n      - name:", arrival + 1));
    expect(step).toContain("scripts/ci/verify-validation-evidence.sh");
    expect(step).toMatch(/ORBIT_SBOM_OUT[:=]/u);
    const out = step.match(/ORBIT_SBOM_OUT[:=]\s*(\S+)/u)?.[1] ?? "";
    expect(out).toMatch(/RUNNER_TEMP|mktemp|\/tmp\//u);
  });

  it("no longer waits for, fetches or requires an SBOM in the handoff (D-S6 43a)", () => {
    expect(awaitScript).not.toContain("readonly SBOM=");
    expect(awaitScript).not.toContain("image.spdx.json");
    expect(awaitScript).not.toMatch(/printf 'sbom=/u);
  });

  it("checks that GitLab's attestation arrived on GHCR before the preview channel tag is moved (#1824)", () => {
    const steps = workflow.split(/\n(?=      - name:)/u);
    const index = (pattern) => steps.findIndex((step) => pattern.test(step));
    const arrival = index(/- name: Verify GitLab's evidence arrived on GHCR/u);
    expect(arrival, "the arrival check").toBeGreaterThanOrEqual(0);
    expect(steps[arrival]).toContain("scripts/ci/verify-validation-evidence.sh");
    const copy = index(/crane copy "\$\{SOURCE\}"/u);
    expect(copy).toBeGreaterThanOrEqual(0);
    expect(copy).toBeLessThan(arrival);
    // The channel tag moves in a step of its own, after the arrival check.
    const later = steps.slice(arrival + 1).findIndex((step) => /\bcrane\s+(?:copy|tag|cp)\b/u.test(step));
    expect(later, "a crane copy/tag step after the arrival check").toBeGreaterThanOrEqual(0);
    // And the first copy, before the check, does not take the preview tag: the
    // tags it loops over are the sha tag only.
    expect(steps[copy]).not.toMatch(/\bpreview\b/u);
    expect(steps[copy]).not.toContain("steps.tags.outputs.list");
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
    expect(workflow).toContain("sbom-path: ");
    expect(workflow).toContain("gh attestation verify");
    expect(workflow).toContain("oci://${REGISTRY}/${IMAGE_NAME}@${IMAGE_DIGEST}");
  });

  it("reads the handoff from the owner's orbit-handoff repository with the run's own token (#1824)", () => {
    const start = workflow.indexOf("run: bash scripts/ci/github-await-handoff.sh");
    expect(start).toBeGreaterThanOrEqual(0);
    const stepText = workflow.slice(workflow.lastIndexOf("\n      - ", start), workflow.indexOf("\n      - ", start));
    expect(stepText).toContain("GITHUB_HANDOFF_REPO: ${{ github.repository_owner }}/orbit-handoff");
    expect(stepText).toContain("GH_TOKEN: ${{ github.token }}");
  });

  it("does not prune or write the handoff: that is GitLab's job (#1824)", () => {
    expect(workflow).not.toContain("github-prune-handoffs");
    expect(workflow).not.toContain("github-upload-handoff");
    expect(workflow).not.toContain("GITHUB_HANDOFF_TOKEN");
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

  it("every permissions block, at workflow or job level, gives contents at most read (#1107, #1824)", () => {
    const values = [...workflow.matchAll(/^\s+contents:\s*(\S+)/gmu)].map((match) => match[1]);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value).toBe("read");
    expect(workflow).not.toMatch(/permissions:\s*write-all/u);
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
    expect(awaitScript).toContain("readonly EVIDENCE=gitlab-tested-image.json");
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

/*
 * The copy step's referrer filter (D-S6 43a addendum 2): the node -e script is
 * sliced out of the workflow and run on sample referrer indexes, passed the
 * predicate type the way the step does.
 */
describe("publish-from-gitlab copy step referrer filter", () => {
  const VALIDATION_TYPE = "https://tomlawson.io/attestations/orbit-validation/v1";
  const SPDX_TYPE = "https://spdx.dev/Document";
  const BUNDLE = "application/vnd.dev.sigstore.bundle.v0.3+json";
  const stepStart = workflow.indexOf("name: Copy the exact tested digest");
  const step = workflow.slice(stepStart);
  const open = step.indexOf("node -e '");
  const close = step.indexOf("' -- \"${predicate_type}\"", open);
  const filter = step.slice(open + "node -e '".length, close);
  const d = (c) => `sha256:${c.repeat(64)}`;
  const referrer = (digest, predicateType, artifactType = BUNDLE) => ({
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest,
    size: 1,
    artifactType,
    annotations: predicateType === undefined ? {} : { "dev.sigstore.bundle.predicateType": predicateType },
  });
  const runFilter = (manifests) =>
    spawnSync("node", ["-e", filter, "--", VALIDATION_TYPE], {
      input: JSON.stringify({ schemaVersion: 2, manifests }),
      encoding: "utf8",
    });

  it("the extracted filter is the step's node script, and the step passes it the verifier's predicate type", () => {
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    expect(filter).toContain("process.argv[1]");
    expect(step).toContain("sed -n 's/^readonly PREDICATE_TYPE=");
    const verifier = readFileSync(new URL("./ci/verify-validation-evidence.sh", import.meta.url), "utf8");
    expect(verifier).toContain(`readonly PREDICATE_TYPE="${VALIDATION_TYPE}"`);
  });

  it("prints both the validation and the SBOM referrer digests when both are present", () => {
    const r = runFilter([referrer(d("a"), VALIDATION_TYPE), referrer(d("b"), SPDX_TYPE)]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean).sort()).toEqual([d("a"), d("b")]);
  });

  it("prints nothing when only an SBOM referrer is present", () => {
    const r = runFilter([referrer(d("b"), SPDX_TYPE)]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("never prints a referrer of another artifactType, even with a wanted predicateType", () => {
    const r = runFilter([
      referrer(d("a"), VALIDATION_TYPE),
      referrer(d("b"), SPDX_TYPE),
      referrer(d("c"), VALIDATION_TYPE, "application/vnd.example.other"),
      referrer(d("e"), SPDX_TYPE, "application/vnd.example.other"),
    ]);
    expect(r.stdout.split("\n").filter(Boolean).sort()).toEqual([d("a"), d("b")]);
  });

  it("never prints a referrer of another predicateType or with none", () => {
    const r = runFilter([
      referrer(d("a"), VALIDATION_TYPE),
      referrer(d("c"), "https://slsa.dev/provenance/v1"),
      referrer(d("e"), undefined),
    ]);
    expect(r.stdout).toBe(d("a"));
  });

  it("prints nothing for a validation-type referrer of another artifactType alone", () => {
    const r = runFilter([referrer(d("c"), VALIDATION_TYPE, "application/vnd.example.other"), referrer(d("b"), SPDX_TYPE)]);
    expect(r.stdout).toBe("");
  });

  it("refuses the step, naming the missing attestation, when the filter's output is empty", () => {
    const guard = step.indexOf('[[ -n "${referrers}" ]]');
    expect(guard).toBeGreaterThan(close);
    const block = step.slice(guard, step.indexOf("\n          }", guard) + 12);
    expect(block).toContain("no attestation of type");
    expect(block).toContain("to copy");
    expect(block).toMatch(/exit 1/u);
    // Nothing is copied before the guard.
    expect(step.slice(0, guard)).not.toContain("crane copy");
  });
});
