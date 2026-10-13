import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * #1403 slice D1. The GitHub-first container pipeline was retired when GitLab
 * became the first home of every check (#801). Its workflow file, the test
 * that parsed it, and the dated audit that cited its line numbers are gone;
 * what GitHub still runs is the mirror publisher, the tag release, the
 * countersignature and CodeQL. These cases fail if any of the three comes back
 * or if a test, script or document points at a file that no longer exists.
 * ADRs keep their history, so docs/adr/ is not searched.
 */
const root = new URL("../", import.meta.url);
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((path) => path !== "" && existsSync(new URL(path, root)));
const thisFile = "scripts/retired-github-pipeline.test.mjs";

const texts = new Map();
for (const path of tracked) {
  if (path === thisFile || path.startsWith("docs/adr/")) continue;
  try {
    texts.set(path, readFileSync(new URL(path, root), "utf8"));
  } catch {
    // unreadable entries are not text we could be pinning
  }
}
const filesMentioning = (needle) => [...texts].filter(([, text]) => text.includes(needle)).map(([path]) => path);

describe("retired GitHub-first pipeline (#1403 D1)", () => {
  it("has no publish-container workflow", () => {
    expect(existsSync(new URL(".github/workflows/publish-container.yml", root))).toBe(false);
  });

  it("keeps the four workflows GitHub still runs", () => {
    for (const name of ["publish-from-gitlab", "release-on-tag", "countersign", "codeql"]) {
      expect(existsSync(new URL(`.github/workflows/${name}.yml`, root)), name).toBe(true);
    }
  });

  it("has no test that parses the retired workflow's step sequences", () => {
    expect(existsSync(new URL("scripts/exact-image-workflow.test.mjs", root))).toBe(false);
  });

  it("has no dated engineering baseline audit", () => {
    expect(existsSync(new URL("docs/engineering-baseline.md", root))).toBe(false);
  });

  it("is not named by any tracked test, script, workflow or document", () => {
    expect(filesMentioning("publish-container")).toEqual([]);
  });

  it("is not named through the retired workflow test", () => {
    expect(filesMentioning("exact-image-workflow")).toEqual([]);
  });

  it("is not linked to as the engineering baseline", () => {
    expect(filesMentioning("engineering-baseline")).toEqual([]);
  });
});
