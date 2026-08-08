import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../.github/workflows/promote-container.yml", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const policy = readFileSync(
  new URL("./stable-promotion-policy.mjs", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const releaseGuide = readFileSync(
  new URL("../docs/releasing.md", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const releaseDecision = readFileSync(
  new URL("../docs/adr/0003-gitflow-preview-and-stable-channels.md", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const pullRequestTemplate = readFileSync(
  new URL("../.github/pull_request_template.md", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

describe("stable promotion workflow", () => {
  it("promotes a tested preview through explicit protected approval", () => {
    expect(workflow).toContain("name: Promote tested Orbit preview");
    expect(workflow).toContain("preview_digest:");
    expect(workflow).not.toContain("      version:");
    expect(workflow).not.toContain("update_latest:");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("io.github.tomlawesome.orbit.release-stage");
    expect(workflow).toContain("io.github.tomlawesome.orbit.source-branch");
    expect(workflow).toContain("attestations: read");
    expect(workflow).toContain("Verify accepted digest attestations");
    expect(workflow).toContain("node scripts/stable-promotion-policy.mjs");
    expect(workflow.toLowerCase()).not.toContain("release candidate");
    expect(workflow.toLowerCase()).not.toContain("release-candidate");
  });

  it("requires the exact preview tree in main and retains the source revision", () => {
    expect(policy).toContain('["merge-base", "--is-ancestor", revision, "origin/main"]');
    expect(policy).toContain('["merge-base", "--is-ancestor", revision, `origin/${sourceBranch}`]');
    expect(policy).toContain('["diff", "--quiet", `${revision}^{tree}`, "origin/main^{tree}"]');
  });

  it("derives the embedded version and promotes only latest without rebuilding", () => {
    expect(workflow).toContain("Stable Git tag %s already exists and will not be overwritten");
    expect(workflow).toContain('org.opencontainers.image.version');
    expect(workflow).toContain('/opt/orbit/VERSION');
    expect(workflow).toContain('node scripts/calculate-version.mjs --channel "${channel}"');
    expect(workflow).toContain("docker buildx imagetools create");
    expect(workflow).toContain('--tag "${image}:latest"');
    expect(workflow).toContain("Latest did not retain the tested digest");
    expect(workflow).toContain('gh release create "${VERSION}"');
    expect(workflow).not.toContain("docker/build-push-action");
    expect(workflow).not.toContain("docker build ");
  });

  it("documents the protected preview-lane merge contract", () => {
    const documentation = `${releaseGuide}\n${releaseDecision}\n${pullRequestTemplate}`;

    expect(documentation).toContain("issue branches start from and target `develop`");
    expect(documentation).toContain("Merge `develop` into protected `preview`");
    expect(documentation).toContain("merge `preview` into protected `main`");
    expect(documentation).toContain("one semantic version per release train");
    expect(documentation.toLowerCase()).not.toContain("release candidate");
    expect(documentation.toLowerCase()).not.toContain("release-candidate");
  });

  it("retains historic preview identities without publishing new per-run tags", () => {
    expect(releaseGuide).toContain(
      "Historic `preview-*` and `rc-*` tags remain",
    );
    expect(releaseGuide).toContain("relabel, replace, or promote them.");
  });
});
