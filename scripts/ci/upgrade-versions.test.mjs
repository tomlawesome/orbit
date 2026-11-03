import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  UPGRADE_FROM_COUNT,
  stableReleases,
  upgradeMatrixNeeded,
  upgradeSlots,
} from "./upgrade-versions.mjs";

/*
 * scripts/ci/upgrade-versions.mjs (#1661) picks the old releases the upgrade
 * matrix updates from and decides whether the matrix runs at all. The pure
 * functions are tested with literal tag lists; the CLI is run in a throwaway
 * git repository so the `KEY=value` contract and the #1597 fail-safe are
 * pinned end to end.
 *
 * Assumed shapes (the issue does not spell them out): stableReleases returns
 * an array of tag strings, newest first; upgradeSlots returns an object keyed
 * by slot name ("latest-1" ...) whose empty slots are empty or absent;
 * upgradeMatrixNeeded returns a boolean.
 */
const script = join(dirname(fileURLToPath(import.meta.url)), "upgrade-versions.mjs");

const slotNames = Array.from({ length: UPGRADE_FROM_COUNT }, (_, index) => `latest-${index + 1}`);
const envName = (slot) => `ORBIT_UPGRADE_SLOT_${slot.toUpperCase().replaceAll("-", "_")}`;

describe("UPGRADE_FROM_COUNT", () => {
  it("is today's value of three (owner answer 40a)", () => {
    expect(UPGRADE_FROM_COUNT).toBe(3);
  });
});

describe("stableReleases", () => {
  it("returns plain vMAJOR.MINOR.PATCH tags newest first, by version not by text", () => {
    const tags = ["v0.3.9", "v0.3.10", "v0.3.2", "v0.2.11"];
    expect(stableReleases({ tags, retractedTags: [] })).toEqual([
      "v0.3.10",
      "v0.3.9",
      "v0.3.2",
      "v0.2.11",
    ]);
  });

  it("drops suffixed, malformed and non-version tags", () => {
    const tags = ["v0.3.5", "v0.4.0-rc.1", "v0.4.0-alpha", "latest", "preview", "0.3.4", "v0.3", "v0.3.4+build"];
    expect(stableReleases({ tags, retractedTags: [] })).toEqual(["v0.3.5"]);
  });

  it("drops retracted tags", () => {
    const tags = ["v1.2.0", "v0.3.5", "v1.0.0"];
    expect(stableReleases({ tags, retractedTags: ["v1.0.0", "v1.2.0"] })).toEqual(["v0.3.5"]);
  });

  it("returns nothing for no tags", () => {
    expect(stableReleases({ tags: [], retractedTags: [] })).toEqual([]);
  });
});

describe("upgradeSlots", () => {
  const tags = ["v0.3.1", "v0.3.2", "v0.3.3", "v0.3.4", "v0.3.5", "v0.4.0-rc.1"];

  it("fills latest-1 to latest-N with the N newest stable tags", () => {
    const slots = upgradeSlots({ tags, retractedTags: [], count: UPGRADE_FROM_COUNT });
    const newest = stableReleases({ tags, retractedTags: [] });
    for (const [index, slot] of slotNames.entries()) {
      expect(slots[slot]).toBe(newest[index]);
    }
  });

  it("gives today's three slots: v0.3.5, v0.3.4, v0.3.3 with v1.x retracted", () => {
    const today = ["v0.3.0", "v0.3.1", "v0.3.2", "v0.3.3", "v0.3.4", "v0.3.5", "v1.0.0", "v1.1.0", "v1.2.0"];
    const slots = upgradeSlots({
      tags: today,
      retractedTags: ["v1.0.0", "v1.1.0", "v1.2.0"],
      count: 3,
    });
    expect(slots["latest-1"]).toBe("v0.3.5");
    expect(slots["latest-2"]).toBe("v0.3.4");
    expect(slots["latest-3"]).toBe("v0.3.3");
    expect(slots["latest-4"]).toBeUndefined();
  });

  it("skips a retracted tag and takes the next one down", () => {
    const slots = upgradeSlots({ tags, retractedTags: ["v0.3.5"], count: UPGRADE_FROM_COUNT });
    expect(slots["latest-1"]).toBe("v0.3.4");
    expect(Object.values(slots)).not.toContain("v0.3.5");
  });

  it("leaves the missing slots empty when there are fewer tags than N", () => {
    const slots = upgradeSlots({ tags: ["v0.3.5"], retractedTags: [], count: UPGRADE_FROM_COUNT });
    expect(slots["latest-1"]).toBe("v0.3.5");
    for (const slot of slotNames.slice(1)) {
      expect(slots[slot] || "").toBe("");
    }
  });

  it("leaves every slot empty when there are no stable tags", () => {
    const slots = upgradeSlots({ tags: ["v0.4.0-rc.1"], retractedTags: [], count: UPGRADE_FROM_COUNT });
    for (const slot of slotNames) {
      expect(slots[slot] || "").toBe("");
    }
  });

  it("reads the slot count from the argument, which callers take from the constant", () => {
    const many = ["v0.1.0", "v0.1.1", "v0.1.2", "v0.1.3", "v0.1.4", "v0.1.5"];
    const count = UPGRADE_FROM_COUNT + 1;
    const slots = upgradeSlots({ tags: many, retractedTags: [], count });
    expect(slots[`latest-${count}`]).toBe(many[many.length - count]);
    expect(slots[`latest-${count + 1}`] || "").toBe("");
  });
});

describe("upgradeMatrixNeeded", () => {
  const hits = [
    "scripts/install.sh",
    "scripts/configure.sh",
    "scripts/installer-ui.sh",
    "scripts/configuration.sh",
    "scripts/configuration-defaults.sh",
    ".env-orbit.example",
    "docker-compose.yml",
    "docker-compose.override.yml",
    "docker-compose.test.yml",
    "src/db/migrations/0001_init.sql",
    "src/db/migrations/meta/_journal.json",
    "src/lib/install-orchestrator.ts",
    "src/lib/install-orchestrator/plan.ts",
    "launcher/pin.json",
  ];

  it.each(hits)("is true when %s changed", (path) => {
    expect(upgradeMatrixNeeded([path])).toBe(true);
  });

  it.each([
    "README.md",
    "docs/adr/0001.md",
    "src/app/page.tsx",
    "src/lib/other.ts",
    "scripts/ci/channel-name.sh",
    "launcher/main.go",
    "src/db/schema.ts",
    ".gitlab-ci.yml",
  ])("is false when only %s changed", (path) => {
    expect(upgradeMatrixNeeded([path])).toBe(false);
  });

  it("is true when one path among many matches", () => {
    expect(upgradeMatrixNeeded(["README.md", "src/app/page.tsx", "scripts/install.sh"])).toBe(true);
  });

  it("is false for an empty change list", () => {
    expect(upgradeMatrixNeeded([])).toBe(false);
  });
});

describe("upgrade-versions.mjs CLI", () => {
  const cleanups = [];
  afterEach(() => {
    while (cleanups.length > 0) {
      rmSync(cleanups.pop(), { recursive: true, force: true });
    }
  });

  function git(cwd, ...args) {
    const result = spawnSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
      { cwd, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout;
  }

  function commitFile(repo, path, content) {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    git(repo, "add", "-A");
    git(repo, "commit", "-m", `change ${path}`);
  }

  // A repository with one commit per tag, in order, then `after` changes on top.
  function makeRepo({ tags, after = [] }) {
    const repo = mkdtempSync(join(tmpdir(), "orbit-upgrade-versions-"));
    cleanups.push(repo);
    git(repo, "init", "-q", "-b", "main");
    commitFile(repo, "README.md", "start\n");
    for (const tag of tags) {
      commitFile(repo, "README.md", `at ${tag}\n`);
      git(repo, "tag", tag);
    }
    for (const path of after) {
      commitFile(repo, path, `changed ${path}\n`);
    }
    return repo;
  }

  function run(cwd) {
    const result = spawnSync("node", [script], { cwd, encoding: "utf8" });
    const env = Object.fromEntries(
      result.stdout
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    return { ...result, env };
  }

  const releaseTags = ["v0.3.3", "v0.3.4", "v0.3.5"];

  it("prints the exact KEY=value lines, in order, for a readable diff that touches nothing relevant", () => {
    const repo = makeRepo({
      tags: [...releaseTags, "v1.2.0", "v0.4.0-rc.1"].sort(),
      after: ["docs/notes.md"],
    });
    // v1.2.0 is in the repository's retracted list; v0.4.0-rc.1 has a suffix.
    const result = run(repo);
    expect(result.status).toBe(0);
    const expected = [
      "ORBIT_UPGRADE_MATRIX=false",
      "ORBIT_UPGRADE_LAUNCHER=false",
      "ORBIT_UPGRADE_SINCE=v0.3.5",
      ...slotNames.map((slot, index) => `${envName(slot)}=${["v0.3.5", "v0.3.4", "v0.3.3"][index] ?? ""}`),
    ];
    expect(result.stdout.trimEnd().split("\n")).toEqual(expected);
  });

  it("emits one SLOT line per slot, uppercased with - changed to _", () => {
    const repo = makeRepo({ tags: releaseTags });
    const result = run(repo);
    expect(result.env[envName("latest-1")]).toBe("v0.3.5");
    expect(Object.keys(result.env).filter((key) => key.startsWith("ORBIT_UPGRADE_SLOT_"))).toEqual(
      slotNames.map(envName),
    );
    expect(envName("latest-1")).toBe("ORBIT_UPGRADE_SLOT_LATEST_1");
  });

  it("prints an empty value for each missing slot", () => {
    const repo = makeRepo({ tags: ["v0.3.5"] });
    const result = run(repo);
    expect(result.stdout).toContain("ORBIT_UPGRADE_SLOT_LATEST_1=v0.3.5\n");
    for (const slot of slotNames.slice(1)) {
      expect(result.stdout).toContain(`${envName(slot)}=\n`);
    }
  });

  it("runs the matrix when a trigger path changed since the newest stable tag", () => {
    const repo = makeRepo({ tags: releaseTags, after: ["docs/notes.md", "src/db/migrations/0042_add.sql"] });
    const result = run(repo);
    expect(result.env.ORBIT_UPGRADE_MATRIX).toBe("true");
    expect(result.env.ORBIT_UPGRADE_SINCE).toBe("v0.3.5");
  });

  it("ignores trigger paths changed before the newest stable tag", () => {
    const repo = makeRepo({ tags: [] });
    commitFile(repo, "scripts/install.sh", "old\n");
    git(repo, "tag", "v0.3.5");
    commitFile(repo, "docs/notes.md", "later\n");
    expect(run(repo).env.ORBIT_UPGRADE_MATRIX).toBe("false");
  });

  it("turns the launcher cell on, with the matrix, when launcher/pin.json changed", () => {
    const repo = makeRepo({ tags: releaseTags, after: ["launcher/pin.json"] });
    const result = run(repo);
    expect(result.env.ORBIT_UPGRADE_MATRIX).toBe("true");
    expect(result.env.ORBIT_UPGRADE_LAUNCHER).toBe("true");
  });

  it("fails safe to true when the repository has no tags", () => {
    const repo = makeRepo({ tags: [], after: ["docs/notes.md"] });
    const result = run(repo);
    expect(result.status).toBe(0);
    expect(result.env.ORBIT_UPGRADE_MATRIX).toBe("true");
    expect(result.env.ORBIT_UPGRADE_LAUNCHER).toBe("true");
    expect(result.env.ORBIT_UPGRADE_SINCE ?? "").toBe("");
    for (const slot of slotNames) {
      expect(result.env[envName(slot)]).toBe("");
    }
  });

  it("fails safe to true when only retracted and suffixed tags exist", () => {
    const repo = makeRepo({ tags: ["v0.4.0-rc.1", "v1.0.0"], after: ["docs/notes.md"] });
    expect(run(repo).env.ORBIT_UPGRADE_MATRIX).toBe("true");
  });

  it("fails safe to true when the diff cannot be read (not a git repository)", () => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-upgrade-versions-nogit-"));
    cleanups.push(dir);
    const result = run(dir);
    expect(result.env.ORBIT_UPGRADE_MATRIX).toBe("true");
    expect(result.env.ORBIT_UPGRADE_LAUNCHER).toBe("true");
  });
});
