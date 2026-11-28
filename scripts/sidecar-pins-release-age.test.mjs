// Tests for the minimum release age rule on the upstream-release axis
// (#1997): a newer upstream release is not required until its image has been
// built for at least 3 days, the same rule version bumps follow.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import * as sidecarPins from "./sidecar-pins.mjs";

const { checkPins, renderReport, runSidecarPins } = sidecarPins;

const LIVE_DATE = "2099-12-31";
const TODAY = "2026-11-27";
const HOUR = 60 * 60 * 1000;
const AGE_MS = 72 * HOUR;
const NOW = new Date("2026-11-27T12:00:00.000Z");

const OLLAMA_DIGEST = `sha256:${"7".repeat(64)}`;
const OLLAMA_INDEX = `sha256:${"e".repeat(64)}`;
const TIKA_DIGEST = `sha256:${"c".repeat(64)}`;
const TIKA_INDEX = `sha256:${"d".repeat(64)}`;
const BASE_DIGEST = `sha256:${"5".repeat(64)}`;
const BASE_INDEX = `sha256:${"6".repeat(64)}`;

const scratchDirs = [];
afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-sidecar-pins-age-"));
  scratchDirs.push(dir);
  return dir;
}

function baseImageEntry() {
  return {
    name: "Orbit base image",
    tag: "ghcr.io/tomlawesome/orbit-base-image:latest",
    reference: `ghcr.io/tomlawesome/orbit-base-image:latest@${BASE_DIGEST}`,
    indexDigest: BASE_INDEX,
    platform: "linux/amd64",
    locations: ["Dockerfile"],
    source: "https://gitlab.tomlawson.io/ai/orbit-base-image",
    registry: "https://github.com/tomlawesome/orbit/pkgs/container/orbit-base-image",
    license: "MIT",
    licenseSource: "https://github.com/nodejs/node/blob/main/LICENSE",
    updateOwner: "Orbit maintainers",
    resolvedOn: "2026-08-30",
    reviewBy: LIVE_DATE,
  };
}

function ollamaEntry() {
  return {
    name: "Ollama optional local AI service",
    tag: "ollama/ollama:0.33.3",
    reference: `ollama/ollama:0.33.3@${OLLAMA_DIGEST}`,
    indexDigest: OLLAMA_INDEX,
    platform: "linux/amd64",
    locations: ["docker-compose.yml"],
    source: "https://github.com/ollama/ollama",
    registry: "https://hub.docker.com/r/ollama/ollama",
    license: "MIT",
    licenseSource: "https://github.com/ollama/ollama/blob/main/LICENSE",
    updateOwner: "Orbit maintainers",
    resolvedOn: "2026-08-30",
    reviewBy: LIVE_DATE,
  };
}

function tikaEntry() {
  return {
    name: "Apache Tika parser",
    tag: "apache/tika:4.0.0-full",
    reference: `apache/tika:4.0.0-full@${TIKA_DIGEST}`,
    indexDigest: TIKA_INDEX,
    platform: "linux/amd64",
    locations: ["docker-compose.yml"],
    source: "https://github.com/apache/tika-docker",
    registry: "https://hub.docker.com/r/apache/tika",
    license: "Apache-2.0",
    licenseSource: "https://github.com/apache/tika/blob/main/LICENSE.txt",
    updateOwner: "Orbit maintainers",
    resolvedOn: "2026-08-30",
    reviewBy: LIVE_DATE,
  };
}

function policy(...entries) {
  return {
    schemaVersion: 1,
    scanner: {
      name: "Trivy",
      version: "0.72.0",
      image: `aquasec/trivy@sha256:${"a".repeat(64)}`,
      license: "Apache-2.0",
      source: "https://github.com/aquasecurity/trivy/releases/tag/v0.72.0",
      updateOwner: "Orbit maintainers",
      reviewBy: LIVE_DATE,
    },
    attestationActions: [
      {
        name: "actions/attest",
        version: "v4.2.2",
        commit: "c".repeat(40),
        license: "MIT",
        source: "https://github.com/actions/attest/releases/tag/v4.2.2",
        updateOwner: "Orbit maintainers",
        reviewBy: LIVE_DATE,
      },
    ],
    dependencyReviewActions: [
      {
        name: "actions/dependency-review-action",
        version: "v5.0.0",
        commit: "d".repeat(40),
        license: "MIT",
        source: "https://github.com/actions/dependency-review-action/releases/tag/v5.0.0",
        updateOwner: "Orbit maintainers",
        reviewBy: LIVE_DATE,
      },
    ],
    thresholds: {
      sourceVulnerabilities: ["HIGH", "CRITICAL"],
      sourceSecrets: ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"],
      imageVulnerabilities: ["HIGH", "CRITICAL"],
    },
    exceptions: [],
    containerImages: [baseImageEntry(), ...entries],
    mutableImageReferences: [],
  };
}

const RESOLVER = async (tag) => {
  if (tag === "ollama/ollama:0.33.3") {
    return { indexDigest: OLLAMA_INDEX, platformDigest: OLLAMA_DIGEST };
  }
  if (tag === "apache/tika:4.0.0-full") {
    return { indexDigest: TIKA_INDEX, platformDigest: TIKA_DIGEST };
  }
  throw new Error(`no fake resolution for ${tag}`);
};

// A fake registry: `built` maps a tag to the time its image was built (a
// Date, or any raw value to hand back as is). Records every question asked.
function fakeBuildTimes(built) {
  const calls = [];
  const tagPublishedAt = async (repository, tag) => {
    calls.push({ repository, tag });
    if (!(tag in built)) throw new Error(`no fake build time for ${tag}`);
    const value = built[tag];
    if (value instanceof Error) throw value;
    return value instanceof Date ? value.toISOString() : value;
  };
  return { calls, tagPublishedAt };
}

function ago(ms) {
  return new Date(NOW.getTime() - ms);
}

async function checkOllama({ tags, tagPublishedAt, now = NOW, offline = false }) {
  const result = await checkPins({
    policy: policy(ollamaEntry()),
    repoDir: scratchDir(),
    drift: false,
    resolveTag: RESOLVER,
    listTags: async () => tags,
    tagPublishedAt,
    now,
    offline,
    today: TODAY,
  });
  return { result, release: result.images[0].axes.release };
}

async function checkTika({ tags, tagPublishedAt }) {
  const result = await checkPins({
    policy: policy(tikaEntry()),
    repoDir: scratchDir(),
    drift: false,
    resolveTag: RESOLVER,
    listTags: async () => tags,
    tagPublishedAt,
    now: NOW,
    today: TODAY,
  });
  return { result, release: result.images[0].axes.release };
}

function writeFile(repoDir, relativePath, content) {
  const path = join(repoDir, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

// A repository whose files hold exactly the digests the policy pins, for the
// runSidecarPins tests.
function alignedOllamaRepo() {
  const document = policy(ollamaEntry());
  const repoDir = scratchDir();
  writeFile(repoDir, "Dockerfile", `FROM ${baseImageEntry().reference} AS base\n`);
  writeFile(
    repoDir,
    "docker-compose.yml",
    `services:\n  ollama:\n    image: ${ollamaEntry().reference}\n`,
  );
  const policyPath = join(repoDir, "policy.json");
  writeFileSync(policyPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { repoDir, policyPath };
}

async function runCli(argv, deps) {
  const { repoDir, policyPath } = alignedOllamaRepo();
  const output = [];
  const status = await runSidecarPins(["check", "--policy", policyPath, ...argv], {
    repoDir,
    today: TODAY,
    resolveTag: RESOLVER,
    write: (line) => output.push(line),
    writeError: (line) => output.push(line),
    ...deps,
  });
  return { status, text: output.join("") };
}

describe("release age: the constant", () => {
  it("sets the minimum release age at 3 days", () => {
    expect(sidecarPins.MINIMUM_RELEASE_AGE_DAYS).toBe(3);
  });
});

describe("release age: a newer release that is still too young", () => {
  it("reports cooling, not behind, when the newest release is young and the pin is the newest old-enough one", async () => {
    const built = ago(25 * 60 * 1000);
    const { tagPublishedAt } = fakeBuildTimes({ "0.34.0": built });
    const { result, release } = await checkOllama({
      tags: ["0.33.2", "0.33.3", "0.34.0"],
      tagPublishedAt,
    });

    expect(release.status).toBe("cooling");
    expect(release.pinnedVersion).toBe("0.33.3");
    expect(release.coolingVersion).toBe("0.34.0");
    expect(release.coolingTag).toBe("0.34.0");
    expect(new Date(release.requiredFrom).getTime()).toBe(built.getTime() + AGE_MS);
    expect(release.requiredFrom).toBe(new Date(built.getTime() + AGE_MS).toISOString());
    expect(result.behind).toBe(false);
    expect(result.blind).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("names the young release and the day it becomes required in the cooling summary", async () => {
    const { tagPublishedAt } = fakeBuildTimes({
      "0.34.0": new Date("2026-11-27T11:35:00.000Z"),
    });
    const { release } = await checkOllama({ tags: ["0.33.3", "0.34.0"], tagPublishedAt });

    expect(release.summary).toContain("0.34.0");
    expect(release.summary).toContain("2026-11-30");
  });

  it("names the newest young release as the cooling one when several are young", async () => {
    const { tagPublishedAt } = fakeBuildTimes({
      "0.34.0": ago(60 * HOUR),
      "0.34.1": ago(30 * HOUR),
      "0.34.2": ago(1 * HOUR),
    });
    const { release } = await checkOllama({
      tags: ["0.33.3", "0.34.0", "0.34.1", "0.34.2"],
      tagPublishedAt,
    });

    expect(release.status).toBe("cooling");
    expect(release.coolingVersion).toBe("0.34.2");
    expect(release.coolingTag).toBe("0.34.2");
    expect(new Date(release.requiredFrom).getTime()).toBe(ago(1 * HOUR).getTime() + AGE_MS);
  });

  it("requires an older, old-enough release above the pin, names it, and mentions the younger one as not yet required", async () => {
    const { tagPublishedAt } = fakeBuildTimes({
      "0.34.0": ago(1 * HOUR),
      "0.33.4": ago(10 * 24 * HOUR),
    });
    const { result, release } = await checkOllama({
      tags: ["0.33.3", "0.33.4", "0.34.0"],
      tagPublishedAt,
    });

    expect(release.status).toBe("behind");
    expect(release.latestVersion).toBe("0.33.4");
    expect(release.latestTag).toBe("0.33.4");
    expect(release.summary).toContain("0.33.4");
    expect(release.summary).toContain("0.34.0");
    expect(release.summary).toMatch(/not (yet )?required/iu);
    expect(result.behind).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it("names the required release, and mentions the younger one, in the report's remedy", async () => {
    const { tagPublishedAt } = fakeBuildTimes({
      "0.34.0": ago(1 * HOUR),
      "0.33.4": ago(10 * 24 * HOUR),
    });
    const { result } = await checkOllama({
      tags: ["0.33.3", "0.33.4", "0.34.0"],
      tagPublishedAt,
    });
    const report = renderReport(result);
    const remedyLines = report.split("\n").filter((line) => /remedy/iu.test(line));

    expect(remedyLines.join("\n")).toContain("0.33.4");
    expect(report).toContain("0.34.0");
  });
});

describe("release age: the 72 hour boundary", () => {
  it("requires a release built exactly 72 hours ago", async () => {
    const { tagPublishedAt } = fakeBuildTimes({ "0.34.0": ago(AGE_MS) });
    const { result, release } = await checkOllama({
      tags: ["0.33.3", "0.34.0"],
      tagPublishedAt,
    });

    expect(release.status).toBe("behind");
    expect(release.latestVersion).toBe("0.34.0");
    expect(release.latestTag).toBe("0.34.0");
    expect(result.exitCode).toBe(1);
  });

  it("treats a release built one millisecond short of 72 hours as still cooling", async () => {
    const built = ago(AGE_MS - 1);
    const { tagPublishedAt } = fakeBuildTimes({ "0.34.0": built });
    const { result, release } = await checkOllama({
      tags: ["0.33.3", "0.34.0"],
      tagPublishedAt,
    });

    expect(release.status).toBe("cooling");
    expect(new Date(release.requiredFrom).getTime()).toBe(built.getTime() + AGE_MS);
    expect(result.exitCode).toBe(0);
  });
});

describe("release age: failing strict, never open", () => {
  it("reports unreachable, exit code 2, when the build time cannot be read", async () => {
    const { tagPublishedAt } = fakeBuildTimes({
      "0.34.0": new Error("registry said 503"),
    });
    const { result, release } = await checkOllama({
      tags: ["0.33.3", "0.34.0"],
      tagPublishedAt,
    });

    expect(release.status).toBe("unreachable");
    expect(result.blind).toBe(true);
    expect(result.behind).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["unparsable", "sometime last week"],
    ["later than now", new Date(NOW.getTime() + 1 * HOUR).toISOString()],
  ])(
    "requires the release, and says its build time could not be trusted, when the time is %s",
    async (_label, rawTime) => {
      const { tagPublishedAt } = fakeBuildTimes({ "0.34.0": rawTime });
      const { result, release } = await checkOllama({
        tags: ["0.33.3", "0.34.0"],
        tagPublishedAt,
      });

      expect(release.status).toBe("behind");
      expect(release.latestVersion).toBe("0.34.0");
      expect(release.latestTag).toBe("0.34.0");
      expect(release.summary).toMatch(/build time could not be trusted/iu);
      expect(result.exitCode).toBe(1);
    },
  );
});

describe("release age: the cap of 10 releases asked about", () => {
  function youngVersions(count) {
    // 0.34.1 .. 0.34.<count>, all one hour old.
    const tags = [];
    const built = {};
    for (let patch = 1; patch <= count; patch += 1) {
      tags.push(`0.34.${patch}`);
      built[`0.34.${patch}`] = ago(1 * HOUR);
    }
    return { tags, built };
  }

  it("treats the 11th newer release as old enough, and asks about at most 10", async () => {
    const { tags, built } = youngVersions(12);
    const { calls, tagPublishedAt } = fakeBuildTimes(built);
    const { result, release } = await checkOllama({
      tags: ["0.33.3", ...tags],
      tagPublishedAt,
    });

    // Newest first: 0.34.12 down to 0.34.3 are asked (10); the next, 0.34.2,
    // is the 11th and is required without being asked.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThanOrEqual(10);
    expect(release.status).toBe("behind");
    expect(release.latestVersion).toBe("0.34.2");
    expect(release.latestTag).toBe("0.34.2");
    expect(result.exitCode).toBe(1);
  });

  it("stays cooling when there are exactly 10 newer releases and all are young", async () => {
    const { tags, built } = youngVersions(10);
    const { calls, tagPublishedAt } = fakeBuildTimes(built);
    const { result, release } = await checkOllama({
      tags: ["0.33.3", ...tags],
      tagPublishedAt,
    });

    expect(calls.length).toBeLessThanOrEqual(10);
    expect(release.status).toBe("cooling");
    expect(release.coolingVersion).toBe("0.34.10");
    expect(result.exitCode).toBe(0);
  });
});

describe("release age: which tags are asked about", () => {
  it("asks about the newest release first, naming the repository", async () => {
    const { calls, tagPublishedAt } = fakeBuildTimes({
      "0.34.0": ago(1 * HOUR),
      "0.34.1": ago(1 * HOUR),
      "0.35.0": ago(1 * HOUR),
    });
    // Deliberately not in version order.
    await checkOllama({
      tags: ["0.34.1", "0.33.3", "0.35.0", "0.34.0"],
      tagPublishedAt,
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toEqual({ repository: "ollama/ollama", tag: "0.35.0" });
    expect(calls.map((call) => call.tag)).toEqual(["0.35.0", "0.34.1", "0.34.0"]);
  });

  it("never asks about the pin itself or any tag older than it", async () => {
    const { calls, tagPublishedAt } = fakeBuildTimes({
      "0.34.0": ago(1 * HOUR),
      "0.33.3": ago(1 * HOUR),
      "0.33.2": ago(1 * HOUR),
      "0.30.0": ago(1 * HOUR),
    });
    await checkOllama({
      tags: ["0.30.0", "0.33.2", "0.33.3", "0.34.0"],
      tagPublishedAt,
    });

    expect(calls.map((call) => call.tag)).toEqual(["0.34.0"]);
  });

  it("never asks about pre-releases, rolling tags or another variant", async () => {
    const { calls, tagPublishedAt } = fakeBuildTimes({
      "4.1.0-full": ago(1 * HOUR),
    });
    const { release } = await checkTika({
      tags: [
        "4.0.0-full",
        "4.1.0-full",
        "4.2.0-SNAPSHOT-full", // pre-release
        "4.2.0-rc1-full", // pre-release
        "4.3.0-beta1-full", // pre-release
        "4.4.0-rocm", // another variant
        "4.4.0", // no variant
        "5", // rolling
        "latest", // rolling
      ],
      tagPublishedAt,
    });

    expect(calls.map((call) => call.tag)).toEqual(["4.1.0-full"]);
    expect(release.status).toBe("cooling");
    expect(release.coolingTag).toBe("4.1.0-full");
  });

  it("stays current, and never asks for a build time, when nothing newer than the pin exists", async () => {
    const { calls, tagPublishedAt } = fakeBuildTimes({});
    const { result, release } = await checkOllama({
      tags: ["0.32.0", "0.33.2", "0.33.3"],
      tagPublishedAt,
    });

    expect(release.status).toBe("current");
    expect(calls).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("uses the real clock when no time is given: a release built an hour ago is cooling, one built ten days ago is required", async () => {
    const run = async (builtAt) => {
      const result = await checkPins({
        policy: policy(ollamaEntry()),
        repoDir: scratchDir(),
        drift: false,
        resolveTag: RESOLVER,
        listTags: async () => ["0.33.3", "0.34.0"],
        tagPublishedAt: async () => builtAt.toISOString(),
        today: TODAY,
      });
      return result.images[0].axes.release.status;
    };

    expect(await run(new Date(Date.now() - 1 * HOUR))).toBe("cooling");
    expect(await run(new Date(Date.now() - 10 * 24 * HOUR))).toBe("behind");
  });
});

describe("release age: --offline", () => {
  it("never asks for a build time when checkPins runs offline", async () => {
    const { calls, tagPublishedAt } = fakeBuildTimes({});
    const { release } = await checkOllama({
      tags: ["0.33.3", "0.34.0"],
      tagPublishedAt,
      offline: true,
    });

    expect(release.status).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("never asks for a build time, or for tags, when the command runs with --offline", async () => {
    const { calls, tagPublishedAt } = fakeBuildTimes({});
    const { status } = await runCli(["--offline"], {
      listTags: async () => {
        throw new Error("the offline check must not list tags");
      },
      tagPublishedAt,
      now: NOW,
    });

    expect(status).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("release age: the check command", () => {
  it("exits 0 and says nothing is behind when the only newer release is too young", async () => {
    const { tagPublishedAt } = fakeBuildTimes({ "0.34.0": ago(25 * 60 * 1000) });
    const { status, text } = await runCli([], {
      listTags: async () => ["0.33.3", "0.34.0"],
      tagPublishedAt,
      now: NOW,
    });

    expect(status).toBe(0);
    expect(text).toContain("0.34.0");
    expect(text).toContain("nothing is behind");
  });

  it("exits 1 when the newer release is old enough", async () => {
    const { tagPublishedAt } = fakeBuildTimes({ "0.34.0": ago(4 * 24 * HOUR) });
    const { status, text } = await runCli([], {
      listTags: async () => ["0.33.3", "0.34.0"],
      tagPublishedAt,
      now: NOW,
    });

    expect(status).toBe(1);
    expect(text).toContain("0.34.0");
  });

  it("exits 2 when the build time cannot be read", async () => {
    const { tagPublishedAt } = fakeBuildTimes({ "0.34.0": new Error("registry unreachable") });
    const { status } = await runCli([], {
      listTags: async () => ["0.33.3", "0.34.0"],
      tagPublishedAt,
      now: NOW,
    });

    expect(status).toBe(2);
  });
});

describe("release age: the report", () => {
  it("shows a cooling release with its version and the time it becomes required", async () => {
    const built = new Date("2026-11-27T11:35:00.000Z");
    const { tagPublishedAt } = fakeBuildTimes({ "0.34.0": built });
    const { result, release } = await checkOllama({
      tags: ["0.33.3", "0.34.0"],
      tagPublishedAt,
    });
    const report = renderReport(result);

    expect(release.status).toBe("cooling");
    expect(report).toContain("Upstream release");
    expect(report).toContain("0.34.0");
    // 11:35 on the 27th plus 72 hours; to the minute, whatever the layout.
    expect(report).toContain("2026-11-30T11:35");
    expect(report).not.toContain("At least one pin is behind");
  });
});

describe("release age: --red self-test", () => {
  it("still passes, reporting the made-up old pin as behind, when every release is one hour old", async () => {
    const { tagPublishedAt } = fakeBuildTimes({
      "0.33.3": ago(1 * HOUR),
      "0.34.0": ago(1 * HOUR),
      "0.34.1": ago(1 * HOUR),
    });
    const { status, text } = await runCli(["--red"], {
      // The self-test steps ollama back to 0.33.2; this registry has newer ones.
      listTags: async () => ["0.33.2", "0.33.3", "0.34.0", "0.34.1"],
      tagPublishedAt,
      now: NOW,
    });

    expect(status).toBe(0);
    expect(text).toContain("0.33.2");
    expect(text).toContain("self-test passed");
  });

  it("says in its output that the age rule is switched off for the self-test", async () => {
    const { tagPublishedAt } = fakeBuildTimes({
      "0.33.3": ago(1 * HOUR),
      "0.34.0": ago(1 * HOUR),
    });
    const { text } = await runCli(["--red"], {
      listTags: async () => ["0.33.2", "0.33.3", "0.34.0"],
      tagPublishedAt,
      now: NOW,
    });

    expect(text).toMatch(/\bage\b/iu);
  });

  it("does not depend on the injected build times at all: a registry that cannot be asked still passes", async () => {
    const { status, text } = await runCli(["--red"], {
      listTags: async () => ["0.33.2", "0.33.3", "0.34.0"],
      tagPublishedAt: async () => {
        throw new Error("the self-test must not read real build times");
      },
      now: NOW,
    });

    expect(status).toBe(0);
    expect(text).toContain("self-test passed");
  });
});
