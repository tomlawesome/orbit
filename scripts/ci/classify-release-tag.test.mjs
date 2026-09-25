import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

/*
 * scripts/ci/classify-release-tag.sh is the single place that decides
 * whether a `vX.Y.Z[-prerelease]` tag is a stable release or a throwaway
 * pre-release (#1121): release-on-tag.yml uses its answer to decide
 * whether `gh release create` gets `--prerelease --latest=false`.
 */
const script = new URL("./classify-release-tag.sh", import.meta.url).pathname;

function run(args) {
  return execFileSync("bash", [script, ...args], { encoding: "utf8" });
}

function runFails(args) {
  try {
    run(args);
    throw new Error("expected the script to refuse");
  } catch (error) {
    return error;
  }
}

describe("classify-release-tag.sh", () => {
  it("classifies a plain vX.Y.Z tag as stable", () => {
    expect(run(["v1.3.0"])).toBe("stable\n");
  });

  it("classifies a semver pre-release tag as prerelease", () => {
    expect(run(["v1.3.0-e2e.1"])).toBe("prerelease\n");
  });

  it("classifies an rc pre-release tag as prerelease", () => {
    expect(run(["v1.3.0-rc.2"])).toBe("prerelease\n");
  });

  it("refuses a malformed tag", () => {
    const error = runFails(["not-a-tag"]);
    expect(error.status).toBe(1);
    expect(error.stderr).toContain("classify-release-tag: not-a-tag does not look like vX.Y.Z or vX.Y.Z-<prerelease>");
  });

  it("refuses a missing tag argument", () => {
    const error = runFails([]);
    expect(error.status).toBe(1);
    expect(error.stderr).toContain("a tag is required");
  });
});
