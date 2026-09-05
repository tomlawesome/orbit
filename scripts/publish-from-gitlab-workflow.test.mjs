import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

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
    expect(awaitScript).toContain("canceled|skipped)");
    expect(awaitScript).toContain("failed)");
    expect(awaitScript).toContain("gave up after ${wait_minutes} minutes");
    expect(awaitScript).toContain("gh run rerun <id> --failed");
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

  /*
   * A GitLab job often flakes and is retried by hand; the pipeline keeps its
   * id and its status turns success. Nothing re-triggers this GitHub run, so
   * it must notice the retry itself by continuing to poll a failed pipeline
   * (#828 -- pipeline 284 on 2026-09-05 needed a person to re-run the GitHub
   * job by hand because the old script gave up on the first "failed").
   *
   * These three run the real script against a stub `curl` (`jq`, `date` and
   * bash's own builtins are the real ones on PATH, the way
   * scripts/promote-stable.test.mjs stubs only the network-facing tools).
   * ORBIT_POLL_SECONDS lets a multi-poll case skip the real 60s sleep.
   */
  const awaitScriptPath = new URL("./ci/gitlab-await-tested-image.sh", import.meta.url).pathname;
  const COMMIT = "c".repeat(40);
  const REF = "preview";
  const REGISTRY = "registry.example.com";
  const PIPELINE_ID = "284";
  const PIPELINE_URL = "https://gitlab.example/ai/orbit/-/pipelines/284";
  const PUBLISH_JOB_ID = "1501";
  const SBOM_JOB_ID = "1502";
  const DIGEST = `sha256:${"1".repeat(64)}`;
  const IMAGE_REFERENCE = `${REGISTRY}/ai/orbit@${DIGEST}`;

  // Parses curl's own argv (as scripts/promote-stable.test.mjs's CURL_STUB
  // does) so it can tell the pipeline-listing call from the jobs call and the
  // two artifact fetches, and answers each from environment-driven fixtures
  // rather than a real GitLab. The pipeline listing's answer advances one step
  // through STUB_PIPELINE_STATUSES per call, holding the last entry once the
  // list is exhausted, so a retry mid-poll is just a second status in that list.
  const CURL_STUB = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'url=""',
    'output=""',
    'args=("$@")',
    "i=0",
    "n=${#args[@]}",
    'while [ "$i" -lt "$n" ]; do',
    '  a="${args[$i]}"',
    '  case "$a" in',
    "    --header|--max-time)",
    "      i=$((i + 2))",
    "      ;;",
    "    --output)",
    '      output="${args[$((i + 1))]}"',
    "      i=$((i + 2))",
    "      ;;",
    "    --silent|--show-error|--fail|--location)",
    "      i=$((i + 1))",
    "      ;;",
    "    *)",
    '      url="$a"',
    "      i=$((i + 1))",
    "      ;;",
    "  esac",
    "done",
    'if [ -n "${STUB_LOG:-}" ]; then',
    '  printf \'%s\\n\' "$url" >> "$STUB_LOG"',
    "fi",
    'if [[ "$url" == *"/pipelines?sha="* ]]; then',
    '  count_file="${STUB_STATE_DIR:?}/poll-count"',
    "  count=0",
    '  [ -f "$count_file" ] && count="$(cat "$count_file")"',
    "  count=$((count + 1))",
    '  printf \'%s\' "$count" > "$count_file"',
    "  IFS=',' read -r -a statuses <<< \"${STUB_PIPELINE_STATUSES:?}\"",
    "  idx=$((count - 1))",
    "  last=$(( ${#statuses[@]} - 1 ))",
    '  [ "$idx" -gt "$last" ] && idx="$last"',
    '  status="${statuses[$idx]}"',
    '  printf \'[{"id":%s,"status":"%s","web_url":"%s"}]\' "${STUB_PIPELINE_ID:?}" "$status" "${STUB_PIPELINE_URL:?}"',
    "  exit 0",
    "fi",
    'if [[ "$url" == *"/jobs?per_page=100" ]]; then',
    "  printf '[{\"id\":%s,\"name\":\"publish_gitlab\",\"status\":\"success\"},"
      + '{"id":%s,"name":"supply_chain_image","status":"success"}]\' '
      + '"${STUB_PUBLISH_JOB_ID:?}" "${STUB_SBOM_JOB_ID:?}"',
    "  exit 0",
    "fi",
    'if [[ "$url" == *"/gitlab-tested-image.json" ]]; then',
    '  cat "${STUB_EVIDENCE_FILE:?}" > "$output"',
    "  exit 0",
    "fi",
    'if [[ "$url" == *"/image.spdx.json" ]]; then',
    '  cat "${STUB_SBOM_FILE:?}" > "$output"',
    "  exit 0",
    "fi",
    'printf \'curl-stub: unhandled url %s\\n\' "$url" >&2',
    "exit 22",
    "",
  ].join("\n");

  function freshTimestamp() {
    return new Date().toISOString().replace(/\.\d+Z$/u, "Z");
  }

  function runAwaitScript({
    statuses = "success",
    waitMinutes = "5",
    pollSeconds = "0",
    evidence = {
      commit: COMMIT,
      ref: REF,
      pipelineId: Number(PIPELINE_ID),
      imageDigest: DIGEST,
      imageReference: IMAGE_REFERENCE,
      recordedAt: freshTimestamp(),
    },
    sbom = { spdxVersion: "SPDX-2.3" },
  } = {}) {
    const stubDir = mkdtempSync(join(tmpdir(), "gitlab-await-stub-"));
    const stateDir = join(stubDir, "state");
    mkdirSync(stateDir);
    const logFile = join(stubDir, "calls.log");
    writeFileSync(logFile, "");
    const curlPath = join(stubDir, "curl");
    writeFileSync(curlPath, CURL_STUB);
    chmodSync(curlPath, 0o755);
    const evidenceFile = join(stubDir, "evidence.json");
    const sbomFile = join(stubDir, "sbom.json");
    writeFileSync(evidenceFile, JSON.stringify(evidence));
    writeFileSync(sbomFile, JSON.stringify(sbom));
    const scratch = mkdtempSync(join(tmpdir(), "gitlab-await-run-"));

    const result = failOnProcessDeadline(
      spawnSync("bash", [awaitScriptPath], {
        cwd: scratch,
        encoding: "utf8",
        env: {
          PATH: `${stubDir}:${process.env.PATH}`,
          GITLAB_API_URL: "https://gitlab.example/api/v4",
          GITLAB_PROJECT_ID: "49",
          GITLAB_READ_TOKEN: "TEST-GITLAB-TOKEN-NOT-REAL",
          GITLAB_REGISTRY: REGISTRY,
          ORBIT_COMMIT: COMMIT,
          ORBIT_REF: REF,
          ORBIT_WAIT_MINUTES: waitMinutes,
          ORBIT_POLL_SECONDS: pollSeconds,
          STUB_LOG: logFile,
          STUB_STATE_DIR: stateDir,
          STUB_PIPELINE_STATUSES: statuses,
          STUB_PIPELINE_ID: PIPELINE_ID,
          STUB_PIPELINE_URL: PIPELINE_URL,
          STUB_PUBLISH_JOB_ID: PUBLISH_JOB_ID,
          STUB_SBOM_JOB_ID: SBOM_JOB_ID,
          STUB_EVIDENCE_FILE: evidenceFile,
          STUB_SBOM_FILE: sbomFile,
        },
        ...processGuard(),
      }),
      { label: "gitlab-await-tested-image" },
    );
    const polls = readFileSync(logFile, "utf8").split("\n").filter((line) => line.includes("/pipelines?sha=")).length;
    return { result, polls };
  }

  it("keeps polling a failed pipeline until a retry turns it success, then fetches the evidence", () => {
    const { result, polls } = runAwaitScript({ statuses: "failed,success", waitMinutes: "5" });
    expect(result.stdout).toContain(`GitLab pipeline ${PIPELINE_ID} is failed; waiting until the deadline for a retry.`);
    expect(result.status, result.stderr).toBe(0);
    expect(polls).toBe(2);
    expect(result.stdout).toContain(`tested as ${IMAGE_REFERENCE}`);
  });

  it("still fails immediately on a canceled pipeline, without waiting for a retry", () => {
    const { result, polls } = runAwaitScript({ statuses: "canceled", waitMinutes: "5" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`ended canceled; nothing to publish`);
    expect(polls).toBe(1);
  });

  it("gives up with a retry hint when the pipeline is still failed at the deadline", () => {
    const { result, polls } = runAwaitScript({ statuses: "failed", waitMinutes: "0" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("gave up after 0 minutes");
    expect(result.stderr).toContain("a failed pipeline can be retried on GitLab");
    expect(result.stderr).toContain("gh run rerun <id> --failed");
    expect(polls).toBe(1);
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
