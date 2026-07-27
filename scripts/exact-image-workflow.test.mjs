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
    const smoke = jobBlock("smoke", "preview");

    expect(smoke).toContain("github.event_name == 'pull_request'");
    expect(smoke).toContain("contents: read");
    expect(smoke).not.toContain("packages: write");
    expect(smoke).toContain("steps: &container_validation_steps");
  });

  it("gives package write access only to trusted publication jobs", () => {
    const preview = jobBlock("preview", "development");
    const development = workflow.slice(workflow.indexOf("  development:\n"));

    expect(preview).toContain(
      "github.ref_name == 'release/architecture-consolidation-rc'",
    );
    expect(preview).toContain("packages: write");
    expect(preview).toContain("steps: *container_validation_steps");
    expect(development).toContain("github.ref == 'refs/heads/develop'");
    expect(development).toContain("packages: write");
    expect(development).toContain("steps: *container_validation_steps");
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
});
