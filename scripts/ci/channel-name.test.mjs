import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

/*
 * scripts/ci/channel-name.sh is the single source of the branch -> channel
 * mapping, shared by scripts/ci/publish-channel.sh (the channel tag) and
 * scripts/ci/write-release-manifest.sh (the manifest's "channel" field).
 * Pinning it here is what lets both callers drop their own copy without
 * losing coverage of the mapping itself.
 */
const script = new URL("./channel-name.sh", import.meta.url).pathname;

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

describe("channel-name.sh", () => {
  it("maps the preview branch to the preview channel", () => {
    expect(run(["preview"])).toBe("preview\n");
  });

  it("maps hotfix/<name> to hotfix-<name>", () => {
    expect(run(["hotfix/urgent"])).toBe("hotfix-urgent\n");
  });

  it("sanitises characters outside [A-Za-z0-9._-] in the hotfix name", () => {
    expect(run(["hotfix/urgent fix#1"])).toBe("hotfix-urgent-fix-1\n");
  });

  it("refuses a branch that is neither preview nor hotfix/*", () => {
    const error = runFails(["dev"]);
    expect(error.status).toBe(1);
    expect(error.stderr).toContain("channel-name: dev is neither preview nor hotfix/*");
  });

  it("refuses a missing branch argument", () => {
    const error = runFails([]);
    expect(error.status).toBe(1);
    expect(error.stderr).toContain("a branch is required");
  });
});
