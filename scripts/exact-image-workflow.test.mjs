import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../.github/workflows/publish-container.yml", import.meta.url),
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

    const build = workflow.indexOf("- name: Build and load final image");
    const start = workflow.indexOf("- name: Start application and database");
    const stop = workflow.indexOf("- name: Stop smoke-test services");
    const login = workflow.indexOf("- name: Log in to GitHub Container Registry");
    const push = workflow.indexOf("- name: Push exact tested image");

    expect(build).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(build);
    expect(stop).toBeGreaterThan(start);
    expect(login).toBeGreaterThan(stop);
    expect(push).toBeGreaterThan(login);
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
