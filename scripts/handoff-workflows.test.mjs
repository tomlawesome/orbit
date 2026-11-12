import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * #1824: GitHub's workflows never connect to GitLab. They read the published
 * release GitLab filled in the separate public handoff repository
 * (<owner>/orbit-handoff), with the run's read-only token, and verify GitLab's
 * evidence before anything reaches GHCR. No GitHub workflow writes to the
 * handoff repository or prunes it: GitLab's handoff job does both. These are
 * checks of the workflow files as written.
 */
const WORKFLOW_DIR = new URL("../.github/workflows/", import.meta.url);
const files = readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/u.test(name));
const text = (name) => readFileSync(new URL(name, WORKFLOW_DIR), "utf8").replaceAll("\r\n", "\n");
const stepsOf = (name) => code(name).split(/\n(?=\s+- (?:name|uses|run):)/u);
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

  const HANDOFF_REPO = "GITHUB_HANDOFF_REPO: ${{ github.repository_owner }}/orbit-handoff";
  const awaitSteps = (name) => stepsOf(name).filter((step) => step.includes("scripts/ci/github-await-handoff.sh"));

  it("publish and release workflows read the handoff from <owner>/orbit-handoff, the repository's own owner", () => {
    for (const name of ["publish-from-gitlab.yml", "release-on-tag.yml"]) {
      const awaits = awaitSteps(name);
      expect(awaits.length, name).toBeGreaterThan(0);
      for (const step of awaits) {
        expect(step, name).toContain(HANDOFF_REPO);
        expect(step, name).toContain("GH_TOKEN: ${{ github.token }}");
      }
    }
  });

  it("no workflow runs the prune or the upload script: GitLab's handoff job does that", () => {
    for (const name of files) {
      expect(code(name), name).not.toContain("github-prune-handoffs");
      expect(code(name), name).not.toContain("github-upload-handoff");
    }
  });

  it("no workflow holds the handoff token, or the old GitLab tokens", () => {
    for (const name of files) {
      expect(code(name), name).not.toMatch(/GITHUB_HANDOFF_TOKEN/u);
      expect(code(name), name).not.toMatch(/secrets\.GITHUB_HANDOFF/u);
    }
  });

  it("no step that names the handoff repository sends a POST, PATCH, PUT or DELETE to it", () => {
    const mutating = [
      /\bgh\s+release\s+(?:create|upload|edit|delete)\b/u,
      /\bgh\s+api\b[^\n]*(?:--method|-X)[ =]+["']?(?:POST|PATCH|PUT|DELETE)\b/iu,
      /\bgh\s+api\b[^\n]*\s(?:-f|-F|--field|--raw-field|--input)\b/u,
      /\bcurl\b[^\n]*(?:--request|-X)[ =]+["']?(?:POST|PATCH|PUT|DELETE)\b/iu,
      /\bcurl\b[^\n]*\s(?:-d|--data\S*|-T|--upload-file|-F|--form)\b/u,
      /\bgit\s+push\b/u,
    ];
    for (const name of files) {
      for (const step of stepsOf(name)) {
        if (!/orbit-handoff|HANDOFF_REPO/u.test(step)) continue;
        for (const pattern of mutating) expect(step, `${name}: ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("only the read-only await script ever sees the handoff repository", () => {
    for (const name of files) {
      for (const step of stepsOf(name)) {
        if (!/orbit-handoff|HANDOFF_REPO/u.test(step)) continue;
        expect(step, name).toContain("scripts/ci/github-await-handoff.sh");
      }
    }
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
