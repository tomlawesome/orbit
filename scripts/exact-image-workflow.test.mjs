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
  it("keeps ordinary pull requests on the static and unit lane", () => {
    const fast = jobBlock("fast", "supply_chain_source");
    const supplyChain = jobBlock("supply_chain_source", "integration");
    const integration = jobBlock("integration", "smoke");
    const smoke = jobBlock("smoke", "verify_preview");

    expect(fast).toContain("run: bash scripts/test-backend.sh");
    expect(fast).toContain("github.event_name == 'push'");
    expect(supplyChain).toContain("if: github.event_name == 'push'");
    expect(integration).toContain("github.event_name == 'push'");
    expect(smoke).toContain("if: ${{ false }}");
  });

  it("selects fail-safe risk lanes while keeping required checks reportable", () => {
    const changes = jobBlock("changes", "fast");
    const integration = jobBlock("integration", "smoke");
    const smoke = jobBlock("smoke", "publish_preview");

    expect(changes).toContain("risk: ${{ steps.classify.outputs.risk }}");
    expect(changes).toContain("build: ${{ steps.classify.outputs.build }}");
    expect(changes).toContain("integration: ${{ steps.classify.outputs.integration }}");
    expect(changes).toContain("system: ${{ steps.classify.outputs.system }}");
    expect(changes).toContain("Set up pnpm graph reader");
    expect(changes).toContain("run_install: false");
    const fast = jobBlock("fast", "supply_chain_source");
    expect(fast).toContain("- changes");
    expect(fast).toContain("needs.changes.outputs.build == 'true'");
    expect(fast).toContain("github.event_name == 'push'");
    expect(fast).toContain("run: pnpm build");
    expect(integration).toContain("needs.changes.outputs.integration == 'true'");
    expect(integration).toContain("github.event_name == 'push'");
    expect(smoke).toContain("if: ${{ false }}");
    expect(workflow).not.toContain("paths:");
    expect(workflow).not.toContain("paths-ignore:");
  });

  it("keeps every integration-branch push on the complete publication path", () => {
    const preview = workflow.slice(workflow.indexOf("  publish_preview:\n"));

    expect(preview).toContain("github.event_name == 'push'");
    expect(preview).not.toContain("needs.changes.outputs.risk");
    expect(preview).not.toContain("needs.changes.outputs.system");
    expect(preview).toContain("steps: *container_validation_steps");
  });

  it("moves source supply-chain scanning to the authoritative preview publication", () => {
    const supplyChain = jobBlock("supply_chain_source", "integration");
    const integration = jobBlock("integration", "smoke");
    const preview = workflow.slice(workflow.indexOf("  publish_preview:\n"));

    expect(supplyChain).toContain("name: Source dependency and secret policy");
    expect(supplyChain).toContain("if: github.event_name == 'push'");
    expect(supplyChain).toContain("contents: read");
    expect(supplyChain).not.toContain("packages: write");
    expect(supplyChain).not.toContain("id-token: write");
    expect(supplyChain).not.toContain("attestations: write");
    expect(supplyChain).toContain("persist-credentials: false");
    expect(supplyChain).toContain("scripts/supply-chain-policy.mjs source");
    expect(supplyChain).toContain("orbit-supply-chain-source");
    expect(integration).not.toContain("- supply_chain_source");
    expect(preview).toContain("- supply_chain_source");
  });

  it("defers pull-request container validation to the protected preview merge", () => {
    const smoke = jobBlock("smoke", "publish_preview");

    expect(smoke).toContain("if: ${{ false }}");
    expect(smoke).toContain("contents: read");
    expect(smoke).not.toContain("packages: write");
    expect(smoke).toContain("steps: &container_validation_steps");
  });

  it("publishes previews only from the protected preview or bounded hotfix lanes", () => {
    const preview = workflow.slice(workflow.indexOf("  publish_preview:\n"));

    expect(preview).toContain("github.event_name == 'push'");
    expect(preview).toContain("github.ref == 'refs/heads/preview'");
    expect(preview).toContain("startsWith(github.ref, 'refs/heads/hotfix/')");
    expect(preview).toContain("packages: write");
    expect(preview).toContain("PUBLICATION_CHANNEL: preview");
    expect(preview).toContain("steps: *container_validation_steps");
    expect(workflow).not.toContain("  development:\n");
    expect(workflow).not.toContain("  preview:\n");
    expect(workflow).not.toContain("PUBLICATION_CHANNEL: development");
  });

  it("publishes only the preview discovery tag while retaining digest identity", () => {
    expect(workflow).toContain("- name: Calculate release-train version");
    expect(workflow).toContain(
      "type=raw,value=preview",
    );
    expect(workflow).toContain(
      "io.github.tomlawesome.orbit.source-branch=${{ github.ref_name }}",
    );
    const metadata = workflow.slice(
      workflow.indexOf("- name: Generate exact image metadata"),
      workflow.indexOf("- name: Build and load final image"),
    );
    expect(metadata).not.toContain("GITHUB_RUN_ID");
    expect(workflow).not.toContain("type=raw,value=dev");
    expect(workflow).not.toMatch(/type=raw,value=v\$?\{/u);
  });

  it("runs the locally reproducible preflight before the exact image build", () => {
    const version = workflow.indexOf("- name: Calculate release-train version");
    const preflight = workflow.indexOf("- name: Validate preview-lane preflight");
    const build = workflow.indexOf("- name: Build and load final image");
    const preflightStep = workflow.slice(preflight, build);

    expect(version).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeGreaterThan(version);
    expect(build).toBeGreaterThan(preflight);
    expect(preflightStep).toContain("bash scripts/preview-lane-preflight.sh");
    expect(preflightStep).toContain("--channel");
  });

  it("builds once, validates the loaded image, then pushes without rebuilding", () => {
    expect(workflow.match(/docker\/build-push-action@/gu)).toHaveLength(1);
    expect(workflow).toContain("platforms: linux/amd64");
    expect(workflow).toContain("Stable Git tags are the version calculator's durable baseline.");
    expect(workflow).toContain("load: true");
    expect(workflow).toContain("push: false");
    expect(workflow).toContain("io.github.tomlawesome.orbit.release-stage=${{ env.PUBLICATION_CHANNEL }}");
    expect(workflow).toContain("org.opencontainers.image.version=${{ steps.version.outputs.version }}");
    expect(workflow).toContain("ORBIT_VERSION=${{ steps.version.outputs.version }}");
    expect(workflow).toContain('docker run --rm "${image_tag}" --version');
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

  it("keeps failure diagnostics available before an exact image is configured", () => {
    const diagnostics = workflow.slice(
      workflow.indexOf("- name: Show service diagnostics"),
      workflow.indexOf("- name: Stop smoke-test services"),
    );
    const cleanup = workflow.slice(
      workflow.indexOf("- name: Stop smoke-test services"),
      workflow.indexOf("- name: Start disposable installer registry"),
    );

    const fallback = 'export ORBIT_IMAGE="${ORBIT_IMAGE:-orbit-local:000000000000}"';
    expect(diagnostics).toContain(fallback);
    expect(cleanup).toContain(fallback);
  });

  it("supplies the calculated identity to source-build overlay validation", () => {
    const validation = workflow.slice(
      workflow.indexOf("- name: Validate Compose configuration"),
      workflow.indexOf("- name: Detect exact processor validation scope"),
    );

    expect(validation).toContain(
      "ORBIT_VERSION: ${{ steps.version.outputs.version }}",
    );
    expect(validation).toContain(
      "ORBIT_REVISION: ${{ steps.version.outputs.revision }}",
    );
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

  it("validates exact-image installer workflow sequence and configuration", () => {
    // Sequence: installer steps ordered after smoke-test stop, before GHCR login.
    const stop = workflow.indexOf("- name: Stop smoke-test services");
    const registryStart = workflow.indexOf("- name: Start disposable installer registry");
    const targetPrepare = workflow.indexOf("- name: Prepare empty installer target and Git guard");
    const installerRun = workflow.indexOf("- name: Run installer against the disposable registry");
    const installerVerify = workflow.indexOf("- name: Verify exact-image installer evidence");
    const cleanup = workflow.indexOf("- name: Clean up installer validation resources");
    const login = workflow.indexOf("- name: Log in to GitHub Container Registry");

    expect(stop).toBeGreaterThanOrEqual(0);
    expect(registryStart).toBeGreaterThan(stop);
    expect(targetPrepare).toBeGreaterThan(registryStart);
    expect(installerRun).toBeGreaterThan(targetPrepare);
    expect(installerVerify).toBeGreaterThan(installerRun);
    expect(cleanup).toBeGreaterThan(installerVerify);
    expect(login).toBeGreaterThan(cleanup);

    // Registry pinning and configuration.
    const registryStep = workflow.slice(registryStart, targetPrepare);
    expect(registryStep).toContain(
      "registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373",
    );
    expect(registryStep).toContain("--publish 127.0.0.1:5000:5000");
    expect(registryStep).toContain('local_tag="127.0.0.1:5000/${IMAGE_NAME}:${channel}"');
    expect(registryStep).toContain('[[ "${source_id}" == "${TESTED_IMAGE_ID}" ]]');
    expect(registryStep).toContain("docker tag");
    expect(registryStep).toContain("docker push");
    expect(registryStep).not.toContain("docker build");
    expect(registryStep).toContain('registry_id="$(');
    expect(registryStep).toContain('[[ "${registry_id}" =~ ^[0-9a-f]{64}$ ]]');

    const prepareStep = workflow.slice(targetPrepare, installerRun);
    expect(prepareStep).toContain('mktemp -d "${RUNNER_TEMP}/orbit-installer-target.XXXXXX"');
    expect(prepareStep).toContain('[[ "${#entries[@]}" -eq 0 ]]');
    expect(prepareStep).toContain("orbit-installer-git-guard.XXXXXX");
    expect(prepareStep).toContain("git-was-invoked");

    // Image mirroring: ${IMAGE_NAME} in local registry, ORBIT_REPOSITORY env var.
    expect(registryStep).toContain("127.0.0.1:5000/${IMAGE_NAME}");

    // Installer input validation: stdin from /dev/null, TTY assertion, Git guard.
    const installerStep = workflow.slice(installerRun, installerVerify);
    expect(installerStep).toContain("ORBIT_REGISTRY: 127.0.0.1:5000");
    expect(installerStep).toContain("ORBIT_REPOSITORY: ${{ env.IMAGE_NAME }}");
    expect(installerStep).toContain("exec < /dev/null");
    expect(installerStep).toContain("[[ ! -t 0 ]]");
    expect(installerStep).toContain("PATH=\"${GIT_GUARD_DIR}:${PATH}\"");
    expect(installerStep).toContain('bash "${GITHUB_WORKSPACE}/scripts/install.sh"');

    // Image digest requirements.
    expect(installerVerify).toBeGreaterThanOrEqual(0);
    const verifyStep = workflow.slice(installerVerify, cleanup);
    expect(verifyStep).toContain("ORBIT_IMAGE=127.0.0.1:5000/${IMAGE_NAME}@sha256:");
    expect(verifyStep).toContain("[[ \"${digest}\" =~ ^[0-9a-f]{64}$ ]]");
    expect(verifyStep).toContain('[[ "${resolved_id}" == "${TESTED_IMAGE_ID}" ]]');
    expect(verifyStep).toContain('[[ "${running_id}" == "${TESTED_IMAGE_ID}" ]]');
    expect(verifyStep).toContain('[[ "${revision_label}" == "${GITHUB_SHA}" ]]');
    expect(verifyStep).toContain("org.opencontainers.image.revision");

    // Fetched assets validation: docker-compose.yml and scripts/configure.sh match.
    expect(verifyStep).toContain("docker-compose.yml");
    expect(verifyStep).toContain("scripts/configure.sh");
    expect(verifyStep).toContain("cmp --silent");

    // Absence of source/build markers.
    expect(verifyStep).toContain(".git");
    expect(verifyStep).toContain("Dockerfile");
    expect(verifyStep).toContain("package.json");
    expect(verifyStep).toContain("pnpm-lock.yaml");

    // Ready health response.
    expect(verifyStep).toContain("curl");
    expect(verifyStep).toContain("/api/health");
    expect(verifyStep).toContain(".status == \"ready\"");
    expect(verifyStep).toContain(".service == \"orbit\"");

    const cleanupSection = workflow.slice(cleanup, login);
    expect(cleanupSection).toContain("if: always()");
    expect(cleanupSection).toContain("${RUNNER_TEMP}");
    expect(cleanupSection).toContain("! -L");
    expect(cleanupSection).toContain("down --volumes --remove-orphans");
    expect(cleanupSection).toContain('docker rm --force "${REGISTRY_ID}"');
    expect(cleanupSection).toContain("current_registry_id=");
    expect(cleanupSection).toContain("${current_registry_id}\" == \"${REGISTRY_ID}\"");
  });
});
