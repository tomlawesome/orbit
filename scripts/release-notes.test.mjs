import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

/*
 * scripts/release-notes.mjs turns a version's CHANGELOG.md section into the
 * release body (#1704) and refuses when there is nothing to publish. Each case
 * writes its fixture changelog into a temp folder made here.
 */
const script = new URL("./release-notes.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "release-notes-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function fixture(content) {
  const path = join(dir, `changelog-${counter++}.md`);
  writeFileSync(path, content);
  return path;
}

function run(args) {
  const result = spawnSync("node", [script, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// An exit 1 counts only when it is the script's own refusal, not a crash.
function expectRefusal(result, label) {
  expect(result.status, label).toBe(1);
  expect(result.stdout, label).toBe("");
  expect(result.stderr, label).toMatch(/^release-notes: /u);
}

const TWO_VERSIONS = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "- Not yet released work.",
  "",
  "## [0.3.7] - 2026-11-05",
  "",
  "### Added",
  "",
  "- The three-speed pipeline.",
  "",
  "### Fixed",
  "",
  "- A thing (#1).",
  "",
  "## [0.3.6] - 2026-10-30",
  "",
  "- Older notes.",
  "",
].join("\n");
const SECTION_0_3_7 = "### Added\n\n- The three-speed pipeline.\n\n### Fixed\n\n- A thing (#1).";

describe("scripts/release-notes.mjs", () => {
  it("prints exactly the asked version's section, trimmed, and never Unreleased", () => {
    const { status, stdout } = run(["v0.3.7", "--changelog", fixture(TWO_VERSIONS)]);
    expect(status).toBe(0);
    expect(stdout.trimEnd()).toBe(SECTION_0_3_7);
    expect(stdout).not.toContain("Not yet released");
    expect(stdout).not.toContain("Older notes");
    expect(stdout.startsWith("###")).toBe(true);
  });

  it("appends a blank line and the compare link with --previous and --repo, same for 0.3.7 and v0.3.7", () => {
    const changelog = fixture(TWO_VERSIONS);
    const extra = ["--previous", "v0.3.6", "--repo", "o/r"];
    const withV = run(["v0.3.7", "--changelog", changelog, ...extra]);
    const without = run(["0.3.7", "--changelog", changelog, ...extra]);
    expect(withV.status).toBe(0);
    expect(withV.stdout.trimEnd()).toBe(
      `${SECTION_0_3_7}\n\n**Full Changelog**: https://github.com/o/r/compare/v0.3.6...v0.3.7`,
    );
    expect(without.stdout).toBe(withV.stdout);
  });

  it("prints no compare link without --previous and --repo", () => {
    const { status, stdout } = run(["0.3.7", "--changelog", fixture(TWO_VERSIONS)]);
    expect(status).toBe(0);
    expect(stdout.trimEnd()).toBe(SECTION_0_3_7);
    expect(stdout).not.toContain("Full Changelog");
  });

  it("exits 1 naming the version when the section is missing, with empty stdout", () => {
    const { status, stdout, stderr } = run(["v0.3.9", "--changelog", fixture(TWO_VERSIONS)]);
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("0.3.9");
  });

  it("exits 1 when the section is empty (blank lines up to the next heading)", () => {
    const changelog = fixture("## [0.3.7] - 2026-11-05\n\n\n   \n## [0.3.6] - 2026-10-30\n\n- Older.\n");
    const { status, stdout, stderr } = run(["v0.3.7", "--changelog", changelog]);
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("0.3.7");
    expect(stderr).toContain("empty");
  });

  it("exits 1 when the section is empty at the end of the file", () => {
    expectRefusal(run(["v0.3.7", "--changelog", fixture("## [0.3.7] - 2026-11-05\n\n")]), "empty at end");
  });

  it("matches the exact version: 0.3.1 and 0.3.10 each get their own section", () => {
    const changelog = fixture(
      "## [0.3.10] - 2026-11-05\n\n- ten notes\n\n## [0.3.1] - 2026-10-01\n\n- one notes\n",
    );
    expect(run(["0.3.1", "--changelog", changelog]).stdout.trim()).toBe("- one notes");
    expect(run(["v0.3.10", "--changelog", changelog]).stdout.trim()).toBe("- ten notes");
  });

  it("exits 1 asking for 0.3.1 from a file with only 0.3.10 (and the reverse)", () => {
    const only10 = run(["0.3.1", "--changelog", fixture("## [0.3.10] - 2026-11-05\n\n- ten notes\n")]);
    expectRefusal(only10, "only 0.3.10");
    const only1 = run(["0.3.10", "--changelog", fixture("## [0.3.1] - 2026-10-01\n\n- one notes\n")]);
    expectRefusal(only1, "only 0.3.1");
  });

  it("exits 1 when only ## Unreleased exists, for either spelling", () => {
    for (const heading of ["## Unreleased", "## [Unreleased]"]) {
      expectRefusal(run(["v0.3.7", "--changelog", fixture(`${heading}\n\n- pending\n`)]), heading);
    }
  });

  it("exits 1 naming the file when the changelog does not exist", () => {
    const missing = join(dir, "no-such-changelog.md");
    const { status, stdout, stderr } = run(["v0.3.7", "--changelog", missing]);
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(missing);
  });

  it("defaults --changelog to CHANGELOG.md in the current directory", () => {
    writeFileSync(join(dir, "CHANGELOG.md"), TWO_VERSIONS);
    const stdout = execFileSync("node", [script, "v0.3.7"], { cwd: dir, encoding: "utf8" });
    expect(stdout.trimEnd()).toBe(SECTION_0_3_7);
  });

  it("exits 2 with a usage message for a pre-release version or junk", () => {
    const changelog = fixture(TWO_VERSIONS);
    for (const bad of ["v0.3.7-rc.1", "junk", "0.3", "v0.3.7.1"]) {
      const { status, stdout, stderr } = run([bad, "--changelog", changelog]);
      expect(status, bad).toBe(2);
      expect(stdout, bad).toBe("");
      expect(stderr, bad).toMatch(/usage/iu);
    }
  });

  it("exits 2 when only one of --previous and --repo is given", () => {
    const changelog = fixture(TWO_VERSIONS);
    for (const only of [["--previous", "v0.3.6"], ["--repo", "o/r"]]) {
      const { status, stdout } = run(["v0.3.7", "--changelog", changelog, ...only]);
      expect(status, only.join(" ")).toBe(2);
      expect(stdout, only.join(" ")).toBe("");
    }
  });
});
