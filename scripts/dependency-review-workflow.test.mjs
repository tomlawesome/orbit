import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../.github/workflows/dependency-review.yml", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const config = readFileSync(
  new URL("../.github/dependency-review-config.yml", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const policy = JSON.parse(
  readFileSync(
    new URL("../.github/supply-chain-policy.json", import.meta.url),
    "utf8",
  ),
);

describe("dependency change review", () => {
  it("runs only for pull requests with read-only repository access", () => {
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("pull_request_target:");
    expect(workflow).not.toContain("packages: write");
    expect(workflow).not.toContain("pull-requests: write");
    expect(workflow).not.toContain("id-token: write");
    expect(workflow).toContain("persist-credentials: false");
  });

  it("pins the reviewed action and uses the repository policy", () => {
    expect(policy.dependencyReviewActions).toHaveLength(1);
    const action = policy.dependencyReviewActions[0];

    expect(workflow).toContain(`${action.name}@${action.commit}`);
    expect(action).toMatchObject({
      name: "actions/dependency-review-action",
      version: "v5.0.0",
      license: "MIT",
      updateOwner: "Orbit maintainers",
    });
    expect(workflow).toContain("config-file: ./.github/dependency-review-config.yml");
    expect(workflow).toContain("comment-summary-in-pr: never");
  });

  it("blocks newly introduced high-risk dependencies and unapproved licences", () => {
    expect(config).toContain("fail-on-severity: high");
    expect(config).toContain("fail-on-scopes: runtime, development, unknown");
    expect(config).toContain("license-check: true");
    expect(config).toContain("vulnerability-check: true");
    expect(config).toContain("warn-only: false");
    expect(config).toContain("allow-licenses:");
    expect(config).toContain("  - MIT");
    expect(config).toContain("  - Apache-2.0");
    expect(config).not.toContain("allow-ghsas:");
    expect(config).not.toContain("allow-dependencies-licenses:");
  });

  it("pins every third-party action to an immutable commit", () => {
    const actionReferences = [
      ...workflow.matchAll(/^\s+uses:\s+([^#\s]+)(?:\s+#.*)?$/gmu),
    ].map((match) => match[1]);

    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/@[0-9a-f]{40}$/u);
    }
  });
});
