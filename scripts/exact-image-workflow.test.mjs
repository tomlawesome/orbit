import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../.github/workflows/publish-container.yml", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const dockerfile = readFileSync(
  new URL("../Dockerfile", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

function jobBlock(job, nextJob) {
  const start = workflow.indexOf(`  ${job}:\n`);
  const end = workflow.indexOf(`  ${nextJob}:\n`, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

describe("exact-image publication workflow", () => {
  it("gates integration and publication on a read-only source supply-chain scan", () => {
    const supplyChain = jobBlock("supply_chain_source", "integration");
    const integration = jobBlock("integration", "smoke");
    const preview = workflow.slice(workflow.indexOf("  publish_preview:\n"));

    expect(supplyChain).toContain("name: Source dependency and secret policy");
    expect(supplyChain).toContain("contents: read");
    expect(supplyChain).not.toContain("packages: write");
    expect(supplyChain).not.toContain("id-token: write");
    expect(supplyChain).not.toContain("attestations: write");
    expect(supplyChain).toContain("persist-credentials: false");
    expect(supplyChain).toContain("scripts/supply-chain-policy.mjs source");
    expect(supplyChain).toContain("orbit-supply-chain-source");
    expect(integration).toContain("- supply_chain_source");
    expect(preview).toContain("- supply_chain_source");
  });

  it("keeps pull-request container validation read-only", () => {
    const smoke = jobBlock("smoke", "publish_preview");

    expect(smoke).toContain("if: github.event_name == 'pull_request'");
    expect(smoke).toContain("contents: read");
    expect(smoke).not.toContain("packages: write");
    expect(smoke).toContain("steps: &container_validation_steps");
  });

  it("publishes unique previews only from trusted Gitflow integration branches", () => {
    const preview = workflow.slice(workflow.indexOf("  publish_preview:\n"));

    expect(preview).toContain("github.event_name == 'push'");
    expect(preview).toContain("github.ref == 'refs/heads/develop'");
    expect(preview).toContain("startsWith(github.ref, 'refs/heads/release/')");
    expect(preview).toContain(
      "github.ref_name != 'release/architecture-consolidation-rc'",
    );
    expect(preview).toContain("packages: write");
    expect(preview).toContain("PUBLICATION_CHANNEL: preview");
    expect(preview).toContain("steps: *container_validation_steps");
    expect(workflow).not.toContain("  development:\n");
    expect(workflow).not.toContain("  preview:\n");
    expect(workflow).not.toContain("PUBLICATION_CHANNEL: development");
  });

  it("gives every preview an immutable human-readable branch and run tag", () => {
    expect(workflow).toContain("- name: Generate unique preview tag");
    expect(workflow).toContain("preview-${branch_slug}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}");
    expect(workflow).toContain(
      "type=raw,value=${{ steps.preview_tag.outputs.tag }},enable=${{ env.PUBLICATION_CHANNEL == 'preview' }}",
    );
    expect(workflow).toContain(
      "io.github.tomlawesome.orbit.source-branch=${{ github.ref_name }}",
    );
    expect(workflow).not.toContain("type=raw,value=dev-");
  });

  it("builds once, validates the loaded image, then pushes without rebuilding", () => {
    expect(workflow.match(/docker\/build-push-action@/gu)).toHaveLength(1);
    expect(workflow).toContain("platforms: linux/amd64");
    expect(workflow).toContain("load: true");
    expect(workflow).toContain("push: false");
    expect(workflow).toContain("io.github.tomlawesome.orbit.release-stage=${{ env.PUBLICATION_CHANNEL }}");
    expect(workflow).toContain("ORBIT_IMAGE=");
    expect(workflow).toContain("--no-build");
    expect(workflow).not.toContain("include_arm64");
    expect(workflow).not.toContain("bash scripts/build-container.sh");
    expect(workflow).toContain(
      "Published image identity %s does not match tested identity %s.",
    );
    expect(workflow).toContain("scripts/supply-chain-policy.mjs image");
    expect(workflow).toContain("image.spdx.json");
    expect(workflow).toContain("image-vulnerabilities.json");

    const build = workflow.indexOf("- name: Build and load final image");
    const scan = workflow.indexOf("- name: Scan exact local image");
    const start = workflow.indexOf("- name: Start application and database");
    const stop = workflow.indexOf("- name: Stop smoke-test services");
    const login = workflow.indexOf("- name: Log in to GitHub Container Registry");
    const push = workflow.indexOf("- name: Push exact tested image");
    const attest = workflow.indexOf("- name: Attest published image provenance");
    const verify = workflow.indexOf("- name: Verify published image attestations");

    expect(build).toBeGreaterThanOrEqual(0);
    expect(scan).toBeGreaterThan(build);
    expect(start).toBeGreaterThan(scan);
    expect(stop).toBeGreaterThan(start);
    expect(login).toBeGreaterThan(stop);
    expect(push).toBeGreaterThan(login);
    expect(attest).toBeGreaterThan(push);
    expect(verify).toBeGreaterThan(attest);
    expect(workflow.slice(push, attest)).not.toContain("docker/build-push-action");
  });

  it("requires the database-backed ready contract before smoke acceptance continues", () => {
    expect(workflow).toContain("- name: Verify health endpoint");
    expect(workflow).toContain('.status == "ready" and .service == "orbit"');
    expect(workflow).not.toContain('.status == "ok" and .service == "orbit"');
  });

  it("attests and verifies the resolved registry digest with least privilege", () => {
    const smoke = jobBlock("smoke", "publish_preview");
    const preview = workflow.slice(workflow.indexOf("  publish_preview:\n"));

    expect(smoke).not.toContain("id-token: write");
    expect(smoke).not.toContain("attestations: write");
    expect(preview).toContain("id-token: write");
    expect(preview).toContain("attestations: write");
    expect(workflow).toContain(
      "actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d",
    );
    expect(workflow).toContain("subject-digest: ${{ steps.publish.outputs.digest }}");
    expect(workflow).toContain("sbom-path: .orbit-supply-chain/image.spdx.json");
    expect(workflow).toContain("gh attestation verify");
    expect(workflow).toContain("oci://${REGISTRY}/${IMAGE_NAME}@${IMAGE_DIGEST}");
  });

  it("pins scanner execution and retains only bounded supply-chain evidence", () => {
    expect(workflow).toContain(
      "aquasec/trivy@sha256:c6e969c5662a546ad5de4a73c2a6b7a7c627f86d916903e175aa623af5b97ada",
    );
    expect(workflow).toContain("retention-days: 14");
    expect(workflow).toContain("rm -f .orbit-supply-chain/source-raw.json");
    expect(workflow).not.toContain("aquasecurity/setup-trivy@");
    expect(workflow).not.toContain("aquasecurity/trivy-action@");
  });

  it("removes build-only package managers from the production image", () => {
    const runnerStart = dockerfile.search(
      /^FROM node:22-alpine@sha256:[0-9a-f]{64} AS runner$/mu,
    );
    expect(runnerStart).toBeGreaterThanOrEqual(0);
    const runner = dockerfile.slice(runnerStart);

    expect(runner).toContain("rm -rf /usr/local/lib/node_modules /opt/yarn-v*");
    expect(runner).toContain("/usr/local/bin/corepack");
    expect(runner).toContain("/usr/local/bin/npm");
    expect(runner).toContain("/usr/local/bin/npx");
    expect(runner).toContain("/usr/local/bin/pnpm");
    expect(runner).toContain("/usr/local/bin/yarn");
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

  it("validates both supported mail secret overlays", () => {
    expect(workflow).toContain(
      "openssl rand -hex 32 > .orbit-secrets/smtp-password",
    );
    expect(workflow).toContain(
      "SMTP_HOST=smtp.example.invalid",
    );
    expect(workflow).toContain(
      "IMAP_HOST=imap.example.invalid",
    );
    expect(workflow).toContain(
      "IMAP_ENABLED=false",
    );
    expect(workflow).toContain(
      "-f docker-compose.yml -f docker-compose.mail.yml config --quiet",
    );
    expect(workflow).toContain(
      "-f docker-compose.yml -f docker-compose.mail.yml -f docker-compose.mail-alias-rotation.yml config --quiet",
    );
    expect(workflow).toContain(
      "-f docker-compose.yml -f docker-compose.mail.yml -f docker-compose.acceptance.yml up --detach --no-build --wait",
    );
  });

  it("does not describe any preview as a release candidate", () => {
    expect(workflow.toLowerCase()).not.toContain("release candidate");
    expect(workflow.toLowerCase()).not.toContain("release-candidate");
  });
});
