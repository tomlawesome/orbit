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
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("io.github.tomlawesome.orbit.release-stage");
    expect(workflow).toContain("io.github.tomlawesome.orbit.source-branch");
    expect(workflow).toContain("node scripts/stable-promotion-policy.mjs");
    expect(workflow.toLowerCase()).not.toContain("release candidate");
    expect(workflow.toLowerCase()).not.toContain("release-candidate");
  });

  it("requires the exact preview tree in main and its revision in develop", () => {
    expect(policy).toContain('["merge-base", "--is-ancestor", revision, "origin/main"]');
    expect(policy).toContain('["merge-base", "--is-ancestor", revision, "origin/develop"]');
    expect(policy).toContain('["diff", "--quiet", `${revision}^{tree}`, "origin/main^{tree}"]');
  });

  it("rejects version replacement and retags without rebuilding", () => {
    expect(workflow).toContain("already exists and will not be overwritten");
    expect(workflow).toContain("docker buildx imagetools create");
    expect(workflow).toContain("Promoted version did not retain the tested digest");
    expect(workflow).not.toContain("docker/build-push-action");
    expect(workflow).not.toContain("docker build ");
  });

  it("documents the protected Gitflow merge contract", () => {
    const documentation = `${releaseGuide}\n${releaseDecision}\n${pullRequestTemplate}`;

    expect(documentation).toContain("Issue branches start from and normally target `develop`.");
    expect(documentation).toContain("`release/vMAJOR.MINOR.PATCH` starts from `develop`");
    expect(documentation).toContain("`hotfix/*` starts from `main`");
    expect(documentation).toContain("into both `main` and `develop`");
    expect(documentation.toLowerCase()).not.toContain("release candidate");
    expect(documentation.toLowerCase()).not.toContain("release-candidate");
  });

  it("retires legacy publication while retaining historic preview identities", () => {
    expect(releaseGuide).toContain(
      "The legacy `release/architecture-consolidation-rc` branch receives no new",
    );
    expect(releaseGuide).toContain("Historic `rc-YYYY.MM.DD.<run>` images");
    expect(releaseGuide).toContain("Do not relabel, replace, or promote them.");
  });
});
