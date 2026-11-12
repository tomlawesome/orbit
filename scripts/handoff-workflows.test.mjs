import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * #1824: GitHub's workflows never connect to GitLab. They read the draft
 * release GitLab filled, and verify GitLab's evidence before anything reaches
 * GHCR. These are checks of the workflow files as written.
 */
const WORKFLOW_DIR = new URL("../.github/workflows/", import.meta.url);
const files = readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/u.test(name));
const text = (name) => readFileSync(new URL(name, WORKFLOW_DIR), "utf8").replaceAll("\r\n", "\n");
const code = (name) =>
  text(name)
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .map((line) => line.replace(/\s+#.*$/u, ""))
    .join("\n");

describe("GitHub workflows and GitLab (#1824)", () => {
  it("covers the three workflows that used GitLab, and more", () => {
    for (const name of ["publish-from-gitlab.yml", "release-on-tag.yml", "countersign.yml"]) expect(files).toContain(name);
  });

  for (const name of files) {
    it(`${name} names neither GitLab host and reads neither GitLab secret`, () => {
      const body = code(name);
      expect(body).not.toContain("gitlab.tomlawson.io");
      expect(body).not.toContain("registry.tomlawson.io");
      expect(body).not.toMatch(/secrets\.GITLAB_READ_TOKEN(_NAME)?\b/u);
    });
  }

  it("publish and release workflows take the handoff from GitHub's own API", () => {
    for (const name of ["publish-from-gitlab.yml", "release-on-tag.yml"]) {
      expect(code(name), name).toContain("scripts/ci/github-await-handoff.sh");
      expect(code(name), name).not.toContain("gitlab-await-tested-image");
    }
    expect(code("release-on-tag.yml")).toMatch(/ORBIT_FETCH_LAUNCHER_ASSETS:\s*"?1"?/u);
    expect(code("publish-from-gitlab.yml")).toMatch(/ORBIT_FETCH_IMAGE:\s*"?1"?/u);
  });

  it("the publish workflow prunes old handoff drafts", () => {
    expect(code("publish-from-gitlab.yml")).toContain("scripts/ci/github-prune-handoffs.sh");
  });

  it("the publish workflow verifies GitLab's evidence before the first write to GHCR", () => {
    const body = code("publish-from-gitlab.yml");
    const steps = body.split(/\n(?=\s+- (?:name|uses|run):)/u);
    const verifies = (step) => step.includes("verify-validation-evidence.sh");
    const writes = (step) => /crane\s+(?:copy|cp|push|tag)\b|actions\/attest@|docker\s+push|cosign\s+(?:attach|copy|sign)\b/u.test(step);

    const verifyAt = steps.findIndex(verifies);
    const writeAts = steps.flatMap((step, index) => (writes(step) ? [index] : []));
    expect(verifyAt).toBeGreaterThanOrEqual(0);
    expect(writeAts.length).toBeGreaterThan(0);
    for (const index of writeAts) {
      expect(index, `step ${index} writes to GHCR before the verifier step ${verifyAt}`).toBeGreaterThan(verifyAt);
    }
    // The verifier must not be a step that is allowed to fail.
    expect(steps[verifyAt]).not.toContain("continue-on-error");
  });
});

describe("the old GitLab pull path is gone (#1824)", () => {
  it("gitlab-await-tested-image.sh no longer exists", () => {
    expect(existsSync(new URL("./ci/gitlab-await-tested-image.sh", import.meta.url))).toBe(false);
  });

  it("nothing in the repository mentions it, apart from this check", () => {
    const result = spawnSync("git", ["grep", "-l", "-F", "gitlab-await-tested-image", "--", ".", ":(exclude)scripts/handoff-workflows.test.mjs"], {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
  });
});
