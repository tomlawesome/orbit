import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { runReadiness } from "./release-readiness.mjs";

/*
 * scripts/release-readiness.mjs runs every pre-promotion check in one go (#1860).
 * Network, git, environment and other scripts come through `lookups`, stubbed
 * here; CHANGELOG.md and src/release-notes/* are read from a temp repo folder.
 */
const root = mkdtempSync(join(tmpdir(), "release-readiness-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PREVIEW_IDS = [
  "version",
  "tag-free",
  "changelog",
  "in-app-notes",
  "contains-target",
  "base-image",
  "sidecar-pins",
  "upgrade-matrix",
  "slow-gates-green",
  "release-record",
];
const MAIN_IDS = [
  "tag-free",
  "changelog",
  "in-app-notes",
  "release-record",
  "main-tree-equals-preview",
  "ghcr-image",
  "evidence-window",
];
const GUIDE_STEPS = ["acceptance", "roadmap", "notes-review", "owner-approval", "promote-stable", "countersign"];
const GOOD_CHANGELOG = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "## [0.3.9] - 2026-11-16",
  "",
  "### Added",
  "",
  "- A thing (#1).",
  "",
  "## [0.3.8] - 2026-11-10",
  "",
  "- Older.",
  "",
].join("\n");
const GOOD_INDEX = [
  'import { notes as v0_3_8 } from "./v0.3.8";',
  'import { notes as v0_3_9 } from "./v0.3.9";',
  "export const releaseNotes: ReleaseNotes[] = [v0_3_8, v0_3_9];",
  "",
].join("\n");

let counter = 0;
function repo({ changelog = GOOD_CHANGELOG, index = GOOD_INDEX, notesFile = true } = {}) {
  const dir = join(root, `repo-${counter++}`);
  mkdirSync(join(dir, "src", "release-notes"), { recursive: true });
  writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  writeFileSync(join(dir, "src", "release-notes", "index.ts"), index);
  if (notesFile) {
    writeFileSync(join(dir, "src", "release-notes", "v0.3.9.ts"), 'export const notes = { version: "v0.3.9" };\n');
  }
  return dir;
}

function goodLookups(overrides = {}) {
  return {
    version: async () => "v0.3.9",
    tagExists: async () => false,
    containsTarget: async () => true,
    baseImageCurrent: async () => true,
    sidecarPinsCurrent: async () => true,
    upgradeMatrix: async () => ({
      matrix: "true",
      launcher: "true",
      updateFrom: ["v0.3.8", "v0.3.7", "v0.3.6"],
      newestStable: ["v0.3.8", "v0.3.7", "v0.3.6"],
    }),
    variableSet: async () => true,
    slowGates: async () => [
      { job: "screens_chromium", status: "success" },
      { job: "smoke", status: "success" },
      { job: "fast", status: "success" },
      { job: "fast_coverage", status: "success" },
    ],
    releaseRecord: async () => ({ exists: true, signed: true, guideCommit: "abc123", steps: [...GUIDE_STEPS] }),
    guideCommit: async () => "abc123",
    guideSteps: async () => [...GUIDE_STEPS],
    mainTreeEqualsPreview: async () => true,
    ghcrImage: async () => ({ shaTag: true, previewTag: true, handoff: true }),
    evidenceAgeDays: async () => 2,
    ...overrides,
  };
}

async function run(target, overrides = {}, repoOpts = {}) {
  return runReadiness({ target, repoDir: repo(repoOpts), lookups: goodLookups(overrides) });
}

const byId = (report, id) => report.results.find((r) => r.id === id);

// The named check fails and says what to do; all other checks stay as they were.
async function expectFails(id, target, overrides, repoOpts) {
  const report = await run(target, overrides, repoOpts);
  const r = byId(report, id);
  expect(r, `${id} present`).toBeDefined();
  expect(r.ok, `${id} ok`).toBe(false);
  expect(r.message.trim().length, `${id} message`).toBeGreaterThan(0);
  expect(report.ok).toBe(false);
  return report;
}

describe("runReadiness: whole report", () => {
  it("passes every preview check when everything is ready", async () => {
    const report = await run("preview");
    expect(report.results.filter((r) => !r.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.results.map((r) => r.id).sort()).toEqual([...PREVIEW_IDS].sort());
  });

  it("passes every main check when everything is ready", async () => {
    const report = await run("main");
    expect(report.results.filter((r) => !r.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("runs exactly the main set for target main", async () => {
    const report = await run("main");
    expect(report.results.map((r) => r.id).sort()).toEqual([...MAIN_IDS].sort());
  });

  it("runs every check even when the first fails, and lists all failures", async () => {
    const report = await run("preview", {
      version: async () => {
        throw new Error("no version");
      },
      tagExists: async () => true,
      baseImageCurrent: async () => false,
      sidecarPinsCurrent: async () => false,
      evidenceAgeDays: async () => 99,
    });
    expect(report.results.map((r) => r.id).sort()).toEqual([...PREVIEW_IDS].sort());
    const failed = report.results.filter((r) => !r.ok).map((r) => r.id);
    for (const id of ["version", "base-image", "sidecar-pins"]) expect(failed).toContain(id);
    expect(failed.length).toBeGreaterThanOrEqual(3);
    expect(report.ok).toBe(false);
  });

  it("never throws when a lookup rejects, and fails that check", async () => {
    const report = await run("preview", {
      containsTarget: async () => {
        throw new Error("git unreachable");
      },
    });
    expect(byId(report, "contains-target").ok).toBe(false);
    expect(report.results.length).toBe(PREVIEW_IDS.length);
  });

  it("is not ok when any single check fails, and no failed result has an empty message", async () => {
    const report = await run("preview", { baseImageCurrent: async () => false, slowGates: async () => null });
    expect(report.ok).toBe(false);
    const failed = report.results.filter((r) => !r.ok);
    expect(failed.length).toBeGreaterThanOrEqual(2);
    for (const r of failed) {
      expect(typeof r.message).toBe("string");
      expect(r.message.trim()).not.toBe("");
    }
  });
});

describe("check: version", () => {
  it("fails when the computed version is not vX.Y.Z", async () => {
    await expectFails("version", "preview", { version: async () => "not-a-version" });
  });
  it("fails when the lookup throws (for example release-line.json does not parse)", async () => {
    await expectFails("version", "preview", {
      version: async () => {
        throw new Error("release-line.json: bad JSON");
      },
    });
  });
});

describe("check: tag-free", () => {
  it("fails for preview when the tag already exists", async () => {
    await expectFails("tag-free", "preview", { tagExists: async () => true });
  });
  it("fails for main when the tag already exists", async () => {
    await expectFails("tag-free", "main", { tagExists: async () => true });
  });
  it("asks about the vX.Y.Z tag of the version", async () => {
    const asked = [];
    await run("preview", {
      tagExists: async (tag) => {
        asked.push(tag);
        return false;
      },
    });
    expect(asked).toContain("v0.3.9");
  });
});

describe("check: changelog", () => {
  it("fails when CHANGELOG.md has only an Unreleased section", async () => {
    await expectFails("changelog", "preview", {}, { changelog: "# Changelog\n\n## Unreleased\n\n- Work.\n" });
  });
  it("fails when the version section is empty", async () => {
    const changelog = "# Changelog\n\n## Unreleased\n\n## [0.3.9] - 2026-11-16\n\n## [0.3.8] - 2026-11-10\n\n- Older.\n";
    await expectFails("changelog", "preview", {}, { changelog });
  });
  it("fails when a non-empty Unreleased section sits beside the version section", async () => {
    const changelog = GOOD_CHANGELOG.replace("## Unreleased\n", "## Unreleased\n\n- Still unreleased work.\n");
    await expectFails("changelog", "preview", {}, { changelog });
  });
  it("fails for the bracketed Unreleased heading too", async () => {
    const changelog = GOOD_CHANGELOG.replace("## Unreleased", "## [Unreleased]\n\n- Still unreleased work.");
    await expectFails("changelog", "preview", {}, { changelog });
  });
  it("fails for main when the section is missing", async () => {
    await expectFails("changelog", "main", {}, { changelog: "# Changelog\n\n## Unreleased\n" });
  });
  it("passes with an empty Unreleased heading and a filled version section", async () => {
    expect(byId(await run("preview"), "changelog").ok).toBe(true);
  });
});

describe("check: in-app-notes", () => {
  it("fails when the notes file is missing", async () => {
    await expectFails("in-app-notes", "preview", {}, { notesFile: false });
  });
  it("fails when the notes file exists but index.ts does not list it", async () => {
    const index = 'import { notes as v0_3_8 } from "./v0.3.8";\nexport const releaseNotes: ReleaseNotes[] = [v0_3_8];\n';
    await expectFails("in-app-notes", "preview", {}, { index });
  });
  it("fails when index.ts imports the file but leaves it out of releaseNotes", async () => {
    const index = [
      'import { notes as v0_3_8 } from "./v0.3.8";',
      'import { notes as v0_3_9 } from "./v0.3.9";',
      "export const releaseNotes: ReleaseNotes[] = [v0_3_8];",
      "",
    ].join("\n");
    await expectFails("in-app-notes", "preview", {}, { index });
  });
  it("fails for main when the notes file is missing", async () => {
    await expectFails("in-app-notes", "main", {}, { notesFile: false });
  });
});

describe("check: contains-target", () => {
  it("fails when the source branch does not contain the target branch", async () => {
    await expectFails("contains-target", "preview", { containsTarget: async () => false });
  });
});

describe("check: base-image", () => {
  it("fails when the base image pin is not current", async () => {
    await expectFails("base-image", "preview", { baseImageCurrent: async () => false });
  });
});

describe("check: sidecar-pins", () => {
  it("fails when the sidecar pins are not current", async () => {
    await expectFails("sidecar-pins", "preview", { sidecarPinsCurrent: async () => false });
  });
});

describe("check: upgrade-matrix", () => {
  const matrix = (o) => async () => ({
    matrix: "true",
    launcher: "true",
    updateFrom: ["v0.3.8", "v0.3.7", "v0.3.6"],
    newestStable: ["v0.3.8", "v0.3.7", "v0.3.6"],
    ...o,
  });
  it("fails when ORBIT_UPGRADE_MATRIX is false", async () => {
    await expectFails("upgrade-matrix", "preview", { upgradeMatrix: matrix({ matrix: "false" }) });
  });
  it("fails when ORBIT_UPGRADE_LAUNCHER is false", async () => {
    await expectFails("upgrade-matrix", "preview", { upgradeMatrix: matrix({ launcher: "false" }) });
  });
  it("fails when updateFrom is not the newest three stable tags", async () => {
    await expectFails("upgrade-matrix", "preview", {
      upgradeMatrix: matrix({ updateFrom: ["v0.3.7", "v0.3.6", "v0.3.5"] }),
    });
  });
  it("passes when both flags are not false and updateFrom matches", async () => {
    expect(byId(await run("preview", { upgradeMatrix: matrix({ matrix: "true", launcher: "1" }) }), "upgrade-matrix").ok).toBe(true);
  });
});

describe("no secret value in any message", () => {
  afterEach(() => {
    delete process.env.ORBIT_REUSE_TOKEN;
    delete process.env.GITLAB_TOKEN;
  });
  it("never prints an environment value in any message", async () => {
    const secret = "fake-placeholder-value";
    process.env.ORBIT_REUSE_TOKEN = secret;
    process.env.GITLAB_TOKEN = secret;
    const report = await run("preview", {
      baseImageCurrent: async () => false,
      slowGates: async () => {
        throw new Error("GitLab API answered 401");
      },
    });
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain(secret);
  });
});

describe("check: slow-gates-green", () => {
  it("fails when there is no dev pipeline with the same tree, saying which to run", async () => {
    const report = await expectFails("slow-gates-green", "preview", { slowGates: async () => null });
    expect(byId(report, "slow-gates-green").message).toMatch(/pipeline/iu);
  });
  it("fails when a job failed", async () => {
    await expectFails("slow-gates-green", "preview", {
      slowGates: async () => [
        { job: "screens_chromium", status: "failed" },
        { job: "smoke", status: "success" },
        { job: "fast", status: "success" },
        { job: "fast_coverage", status: "success" },
      ],
    });
  });
  it("fails when a slow job did not run or is skipped", async () => {
    await expectFails("slow-gates-green", "preview", {
      slowGates: async () => [
        { job: "screens_chromium", status: "success" },
        { job: "fast", status: "success" },
        { job: "fast_coverage", status: "success" },
      ],
    });
  });
  it("names the failed job in the message", async () => {
    const report = await run("preview", {
      slowGates: async () => [
        { job: "screens_chromium", status: "success" },
        { job: "smoke", status: "failed" },
        { job: "fast", status: "success" },
        { job: "fast_coverage", status: "success" },
      ],
    });
    expect(byId(report, "slow-gates-green").message).toContain("smoke");
  });
});

describe("check: release-record", () => {
  it("fails when the record is missing", async () => {
    await expectFails("release-record", "preview", {
      releaseRecord: async () => ({ exists: false, signed: false, guideCommit: null, steps: [] }),
    });
  });
  it("fails when the record is unsigned", async () => {
    await expectFails("release-record", "preview", {
      releaseRecord: async () => ({ exists: true, signed: false, guideCommit: "abc123", steps: [...GUIDE_STEPS] }),
    });
  });
  it("fails when the record names an older docs/releasing.md commit", async () => {
    await expectFails("release-record", "preview", {
      releaseRecord: async () => ({ exists: true, signed: true, guideCommit: "old000", steps: [...GUIDE_STEPS] }),
    });
  });
  it("fails when the record leaves out a step the guide lists", async () => {
    const report = await expectFails("release-record", "preview", {
      releaseRecord: async () => ({ exists: true, signed: true, guideCommit: "abc123", steps: GUIDE_STEPS.slice(1) }),
    });
    expect(byId(report, "release-record").message).toContain(GUIDE_STEPS[0]);
  });
  it("fails when the record has a step the guide does not list", async () => {
    await expectFails("release-record", "preview", {
      releaseRecord: async () => ({ exists: true, signed: true, guideCommit: "abc123", steps: [...GUIDE_STEPS, "extra"] }),
    });
  });
  it("fails when the record repeats a step", async () => {
    await expectFails("release-record", "preview", {
      releaseRecord: async () => ({ exists: true, signed: true, guideCommit: "abc123", steps: [...GUIDE_STEPS, GUIDE_STEPS[0]] }),
    });
  });
  it("is checked for main too", async () => {
    await expectFails("release-record", "main", {
      releaseRecord: async () => ({ exists: true, signed: false, guideCommit: "abc123", steps: [...GUIDE_STEPS] }),
    });
  });
});

describe("check: main-tree-equals-preview", () => {
  it("fails when the merge result's files differ from the preview tip's", async () => {
    await expectFails("main-tree-equals-preview", "main", { mainTreeEqualsPreview: async () => false });
  });
});

describe("check: ghcr-image", () => {
  it("fails when the sha tag is missing", async () => {
    await expectFails("ghcr-image", "main", { ghcrImage: async () => ({ shaTag: false, previewTag: true, handoff: true }) });
  });
  it("fails when :preview does not point at the sha tag", async () => {
    await expectFails("ghcr-image", "main", { ghcrImage: async () => ({ shaTag: true, previewTag: false, handoff: true }) });
  });
  it("fails when the handoff release is missing", async () => {
    await expectFails("ghcr-image", "main", { ghcrImage: async () => ({ shaTag: true, previewTag: true, handoff: false }) });
  });
});

describe("check: evidence-window", () => {
  it("fails when the evidence is 8 days old", async () => {
    await expectFails("evidence-window", "main", { evidenceAgeDays: async () => 8 });
  });
  it("passes at 7 days or fewer", async () => {
    expect(byId(await run("main", { evidenceAgeDays: async () => 7 }), "evidence-window").ok).toBe(true);
  });
});
