import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkPins,
  pendingUpgrades,
  renderReport,
  rotateDigest,
  runSidecarPins,
  sidecarEntries,
  syncPins,
} from "./sidecar-pins.mjs";

// The policy validator checks review dates against the real clock, so fixture
// review dates sit far in the future and resolution dates in the past.
const LIVE_DATE = "2099-12-31";
const TODAY = "2026-09-03";

const POSTGRES_DIGEST = `sha256:${"1".repeat(64)}`;
const POSTGRES_INDEX = `sha256:${"2".repeat(64)}`;
const NODE_DIGEST = `sha256:${"3".repeat(64)}`;
const NODE_INDEX = `sha256:${"4".repeat(64)}`;
const BASE_DIGEST = `sha256:${"5".repeat(64)}`;
const BASE_INDEX = `sha256:${"6".repeat(64)}`;
const MOVED_DIGEST = `sha256:${"9".repeat(64)}`;
const MOVED_INDEX = `sha256:${"8".repeat(64)}`;

const scratchDirs = [];
afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-sidecar-pins-"));
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

function postgresEntry(overrides = {}) {
  return {
    name: "PostgreSQL database",
    tag: "postgres:18-alpine",
    reference: `postgres:18-alpine@${POSTGRES_DIGEST}`,
    indexDigest: POSTGRES_INDEX,
    platform: "linux/amd64",
    locations: ["docker-compose.yml", "scripts/test-integration.mjs"],
    source: "https://github.com/docker-library/postgres",
    registry: "https://hub.docker.com/_/postgres",
    license: "MIT",
    licenseSource: "https://github.com/docker-library/postgres/blob/master/LICENSE",
    updateOwner: "Orbit maintainers",
    resolvedOn: "2026-08-31",
    reviewBy: LIVE_DATE,
    ...overrides,
  };
}

function nodeEntry(overrides = {}) {
  return {
    name: "Node.js build and runtime",
    tag: "node:24-alpine",
    reference: `node:24-alpine@${NODE_DIGEST}`,
    indexDigest: NODE_INDEX,
    platform: "linux/amd64",
    locations: ["tests/oidc/Dockerfile"],
    source: "https://github.com/nodejs/docker-node",
    registry: "https://hub.docker.com/_/node",
    license: "MIT",
    licenseSource: "https://github.com/nodejs/docker-node/blob/main/LICENSE",
    updateOwner: "Orbit maintainers",
    resolvedOn: "2026-08-30",
    reviewBy: LIVE_DATE,
    ...overrides,
  };
}

function policy(overrides = {}) {
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
    containerImages: [baseImageEntry(), postgresEntry(), nodeEntry()],
    mutableImageReferences: [],
    ...overrides,
  };
}

function writeFile(repoDir, relativePath, content) {
  const path = join(repoDir, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

// A repository whose files hold exactly the digests the policy pins.
function alignedRepo(document = policy()) {
  const repoDir = scratchDir();
  writeFile(repoDir, "Dockerfile", `FROM ${document.containerImages[0].reference} AS base\n`);
  writeFile(
    repoDir,
    "docker-compose.yml",
    `services:\n  postgres:\n    image: ${postgresEntry().reference}\n`,
  );
  writeFile(
    repoDir,
    "scripts/test-integration.mjs",
    `const image = "${postgresEntry().reference}";\n`,
  );
  writeFile(repoDir, "tests/oidc/Dockerfile", `FROM ${nodeEntry().reference}\n`);
  const policyPath = join(repoDir, "policy.json");
  writeFileSync(policyPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { repoDir, policyPath };
}

function resolverFor(map) {
  return async (tag) => {
    if (!(tag in map)) throw new Error(`no fake resolution for ${tag}`);
    const resolution = map[tag];
    if (resolution instanceof Error) throw resolution;
    return resolution;
  };
}

const CURRENT_RESOLVER = resolverFor({
  "postgres:18-alpine": { indexDigest: POSTGRES_INDEX, platformDigest: POSTGRES_DIGEST },
  "node:24-alpine": { indexDigest: NODE_INDEX, platformDigest: NODE_DIGEST },
});

function imageFor(result, tag) {
  return result.images.find((image) => image.tag === tag);
}

const APK_OUTPUT = [
  "(1/3) Upgrading openssl (3.5.7-r0 -> 3.5.8-r0)",
  "(2/3) Upgrading libcrypto3 (3.5.7-r0 -> 3.5.8-r0)",
  "(3/3) Upgrading busybox (1.37.0-r19 -> 1.37.0-r20)",
  "OK: 12 MiB in 40 packages",
].join("\n");

const APT_OUTPUT = [
  "Reading package lists...",
  "Inst libssl3 [3.0.15-1] (3.0.16-1 Debian:12/stable [amd64])",
  "Inst openssl [3.0.15-1] (3.0.16-1 Debian:12/stable [amd64])",
  "Conf libssl3 (3.0.16-1 Debian:12/stable [amd64])",
].join("\n");

describe("sidecar pins: which images are covered", () => {
  it("skips the Orbit base image, which has its own pipeline and its own check", () => {
    const entries = sidecarEntries(policy());
    expect(entries.map((entry) => entry.tag)).toEqual([
      "postgres:18-alpine",
      "node:24-alpine",
    ]);
  });

  it("narrows to the entries whose tag contains the --only substring", () => {
    const entries = sidecarEntries(policy(), "postgres");
    expect(entries.map((entry) => entry.tag)).toEqual(["postgres:18-alpine"]);
  });
});

describe("sidecar pins: axis 0, drift between the two places a pin lives", () => {
  it("passes when every location holds the exact pinned reference", async () => {
    const { repoDir } = alignedRepo();
    const result = await checkPins({
      policy: policy(),
      repoDir,
      offline: true,
      today: TODAY,
    });
    expect(result.exitCode).toBe(0);
    expect(imageFor(result, "postgres:18-alpine").axes.drift.status).toBe("aligned");
  });

  it("reports the file, the pin it holds and the pin the policy records", async () => {
    const { repoDir } = alignedRepo();
    writeFile(
      repoDir,
      "scripts/test-integration.mjs",
      `const image = "postgres:18-alpine@${MOVED_DIGEST}";\n`,
    );

    const result = await checkPins({
      policy: policy(),
      repoDir,
      offline: true,
      today: TODAY,
    });

    expect(result.exitCode).toBe(1);
    expect(result.behind).toBe(true);
    const image = imageFor(result, "postgres:18-alpine");
    expect(image.axes.drift.status).toBe("drifted");
    const drifted = image.axes.drift.files.find(
      (file) => file.path === "scripts/test-integration.mjs",
    );
    expect(drifted.status).toBe("different-digest");
    expect(drifted.found).toBe(`postgres:18-alpine@${MOVED_DIGEST}`);
    expect(renderReport(result)).toContain("scripts/test-integration.mjs");
  });

  it("reports a location that does not pin the tag at all", async () => {
    const { repoDir } = alignedRepo();
    writeFile(repoDir, "tests/oidc/Dockerfile", "FROM node:24-alpine\n");

    const result = await checkPins({
      policy: policy(),
      repoDir,
      offline: true,
      today: TODAY,
    });

    expect(result.exitCode).toBe(1);
    const image = imageFor(result, "node:24-alpine");
    expect(image.axes.drift.status).toBe("drifted");
    expect(image.axes.drift.files[0].status).toBe("no-pin");
  });

  it("runs the drift axis without touching a registry when --offline is set", async () => {
    const { repoDir } = alignedRepo();
    const result = await checkPins({
      policy: policy(),
      repoDir,
      offline: true,
      today: TODAY,
      resolveTag: async () => {
        throw new Error("the offline check must not reach a registry");
      },
    });
    expect(result.exitCode).toBe(0);
    expect(imageFor(result, "postgres:18-alpine").axes.tag.status).toBe("skipped");
  });
});

describe("sidecar pins: axis 1, has the tag moved", () => {
  it("stays quiet when the tag still resolves to the pinned manifest and index", async () => {
    const { repoDir } = alignedRepo();
    const result = await checkPins({
      policy: policy(),
      repoDir,
      resolveTag: CURRENT_RESOLVER,
      today: TODAY,
    });
    expect(result.exitCode).toBe(0);
    expect(imageFor(result, "postgres:18-alpine").axes.tag.status).toBe("current");
  });

  it("reports the old and the new digest when the amd64 manifest moved", async () => {
    const { repoDir } = alignedRepo();
    const result = await checkPins({
      policy: policy(),
      repoDir,
      only: "postgres",
      resolveTag: resolverFor({
        "postgres:18-alpine": { indexDigest: MOVED_INDEX, platformDigest: MOVED_DIGEST },
      }),
      today: TODAY,
    });

    expect(result.exitCode).toBe(1);
    const image = imageFor(result, "postgres:18-alpine");
    expect(image.axes.tag.status).toBe("moved");
    expect(image.axes.tag.pinnedDigest).toBe(POSTGRES_DIGEST);
    expect(image.axes.tag.currentDigest).toBe(MOVED_DIGEST);
    const report = renderReport(result);
    expect(report).toContain(MOVED_DIGEST);
    expect(report).toContain(POSTGRES_DIGEST);
  });

  it("reports movement that shows only in the index digest", async () => {
    const { repoDir } = alignedRepo();
    const result = await checkPins({
      policy: policy(),
      repoDir,
      only: "postgres",
      resolveTag: resolverFor({
        "postgres:18-alpine": { indexDigest: MOVED_INDEX, platformDigest: POSTGRES_DIGEST },
      }),
      today: TODAY,
    });

    expect(result.exitCode).toBe(1);
    const image = imageFor(result, "postgres:18-alpine");
    expect(image.axes.tag.status).toBe("moved");
    expect(image.axes.tag.currentIndexDigest).toBe(MOVED_INDEX);
  });

  it("says there is nothing to compare for a single-architecture image", async () => {
    const { repoDir } = alignedRepo();
    const result = await checkPins({
      policy: policy(),
      repoDir,
      only: "postgres",
      resolveTag: resolverFor({
        "postgres:18-alpine": { indexDigest: null, platformDigest: null },
      }),
      today: TODAY,
    });

    expect(result.exitCode).toBe(0);
    expect(imageFor(result, "postgres:18-alpine").axes.tag.status).toBe("no-platform-entry");
  });

  it("exits 2, not 0, when the registry cannot be reached", async () => {
    const { repoDir } = alignedRepo();
    const result = await checkPins({
      policy: policy(),
      repoDir,
      only: "postgres",
      resolveTag: resolverFor({
        "postgres:18-alpine": new Error("dial tcp: connection refused"),
      }),
      today: TODAY,
    });

    expect(result.exitCode).toBe(2);
    expect(result.blind).toBe(true);
    expect(imageFor(result, "postgres:18-alpine").axes.tag.status).toBe("unreachable");
  });
});

describe("sidecar pins: axis 2, are the pinned image's packages behind", () => {
  it("is not run unless it is asked for, because it pulls every image", async () => {
    const { repoDir } = alignedRepo();
    const result = await checkPins({
      policy: policy(),
      repoDir,
      resolveTag: CURRENT_RESOLVER,
      today: TODAY,
      simulatePackages: async () => {
        throw new Error("the package axis must not run without --packages");
      },
    });
    expect(result.exitCode).toBe(0);
    expect(imageFor(result, "postgres:18-alpine").axes.packages.status).toBe("skipped");
  });

  it("counts the pending upgrades in apk output", async () => {
    const { repoDir } = alignedRepo();
    const result = await checkPins({
      policy: policy(),
      repoDir,
      only: "postgres",
      packages: true,
      resolveTag: CURRENT_RESOLVER,
      simulatePackages: async () => ({ manager: "apk", output: APK_OUTPUT }),
      today: TODAY,
    });

    expect(result.exitCode).toBe(1);
    const image = imageFor(result, "postgres:18-alpine");
    expect(image.axes.packages.status).toBe("stale");
    expect(image.axes.packages.pending).toHaveLength(3);
    expect(image.axes.packages.pending[0]).toContain("openssl");
  });

  it("counts the pending upgrades in apt output", async () => {
    const { repoDir } = alignedRepo();
    const result = await checkPins({
      policy: policy(),
      repoDir,
      only: "postgres",
      packages: true,
      resolveTag: CURRENT_RESOLVER,
      simulatePackages: async () => ({ manager: "apt", output: APT_OUTPUT }),
      today: TODAY,
    });

    const image = imageFor(result, "postgres:18-alpine");
    expect(image.axes.packages.status).toBe("stale");
    expect(image.axes.packages.pending).toHaveLength(2);
    expect(image.axes.packages.pending[1]).toContain("openssl");
  });

  it("passes when neither package manager has anything pending", async () => {
    const { repoDir } = alignedRepo();
    const result = await checkPins({
      policy: policy(),
      repoDir,
      only: "postgres",
      packages: true,
      resolveTag: CURRENT_RESOLVER,
      simulatePackages: async () => ({ manager: "apk", output: "OK: 12 MiB in 40 packages" }),
      today: TODAY,
    });

    expect(result.exitCode).toBe(0);
    expect(imageFor(result, "postgres:18-alpine").axes.packages.status).toBe("current");
  });

  it("treats an image with no package manager as unchecked, not as a pass", async () => {
    const { repoDir } = alignedRepo();
    const result = await checkPins({
      policy: policy(),
      repoDir,
      only: "postgres",
      packages: true,
      resolveTag: CURRENT_RESOLVER,
      simulatePackages: async () => ({ manager: "none", output: "" }),
      today: TODAY,
    });

    expect(result.exitCode).toBe(2);
    expect(result.blind).toBe(true);
    expect(imageFor(result, "postgres:18-alpine").axes.packages.status).toBe(
      "no-package-manager",
    );
  });

  it("exits 2 when the pinned image cannot be run at all", async () => {
    const { repoDir } = alignedRepo();
    const result = await checkPins({
      policy: policy(),
      repoDir,
      only: "postgres",
      packages: true,
      resolveTag: CURRENT_RESOLVER,
      simulatePackages: async () => {
        throw new Error("docker: command not found");
      },
      today: TODAY,
    });

    expect(result.exitCode).toBe(2);
    expect(imageFor(result, "postgres:18-alpine").axes.packages.status).toBe("unreachable");
  });

  it("parses upgrade lines out of each package manager's own wording", () => {
    expect(pendingUpgrades("apk", APK_OUTPUT)).toHaveLength(3);
    expect(pendingUpgrades("apt", APT_OUTPUT)).toHaveLength(2);
    expect(pendingUpgrades("apk", "OK: 12 MiB in 40 packages")).toHaveLength(0);
  });
});

describe("sidecar pins: --red self-proof", () => {
  it("rotates the last eight hex characters into a different, still-valid digest", () => {
    const rotated = rotateDigest(POSTGRES_DIGEST);
    expect(rotated).not.toBe(POSTGRES_DIGEST);
    expect(rotated).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(rotated.slice(0, -8)).toBe(POSTGRES_DIGEST.slice(0, -8));
    expect(rotateDigest(`sha256:${"f".repeat(64)}`)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("exits 0 when the deliberately stale pin is reported as moved", async () => {
    const { repoDir, policyPath } = alignedRepo();
    const output = [];
    const status = await runSidecarPins(["check", "--policy", policyPath, "--red"], {
      repoDir,
      today: TODAY,
      resolveTag: CURRENT_RESOLVER,
      write: (line) => output.push(line),
      writeError: (line) => output.push(line),
    });

    expect(status).toBe(0);
    expect(output.join("")).toContain("self-test");
  });

  it("exits 1 when a deliberately stale pin does not trip the check", async () => {
    const { repoDir, policyPath } = alignedRepo();
    const output = [];
    // A registry that agrees with the deliberately stale pin: the check then
    // sees nothing wrong, which is exactly the blindness --red exists to catch.
    const status = await runSidecarPins(["check", "--policy", policyPath, "--red"], {
      repoDir,
      today: TODAY,
      resolveTag: async () => ({
        indexDigest: rotateDigest(POSTGRES_DIGEST),
        platformDigest: rotateDigest(POSTGRES_DIGEST),
      }),
      write: (line) => output.push(line),
      writeError: (line) => output.push(line),
    });

    expect(status).toBe(1);
    expect(output.join("")).toContain("did not fire");
  });

  it("names the cause when the registry could not be asked at all", async () => {
    const { repoDir, policyPath } = alignedRepo();
    const output = [];
    // Pipeline 278: the job had no Docker client, every lookup threw, and the
    // failure line said only 'unreachable'. The error message must be on it.
    const status = await runSidecarPins(["check", "--policy", policyPath, "--red"], {
      repoDir,
      today: TODAY,
      resolveTag: async () => {
        throw new Error("docker could not be run: spawnSync docker ENOENT");
      },
      write: (line) => output.push(line),
      writeError: (line) => output.push(line),
    });

    expect(status).toBe(1);
    const text = output.join("");
    expect(text).toContain("'unreachable'");
    expect(text).toContain("spawnSync docker ENOENT");
  });
});

describe("sidecar pins: the check command", () => {
  it("exits 0 and writes the report where it was asked to", async () => {
    const { repoDir, policyPath } = alignedRepo();
    const reportPath = join(repoDir, "report.md");
    const output = [];

    const status = await runSidecarPins(
      ["check", "--policy", policyPath, "--report", reportPath],
      {
        repoDir,
        today: TODAY,
        resolveTag: CURRENT_RESOLVER,
        write: (line) => output.push(line),
        writeError: (line) => output.push(line),
      },
    );

    expect(status).toBe(0);
    const report = readFileSync(reportPath, "utf8");
    expect(report).toContain("postgres:18-alpine");
    expect(report).not.toContain("orbit-base-image");
  });

  it("exits 1 and names the remedy when a tag has moved", async () => {
    const { repoDir, policyPath } = alignedRepo();
    const output = [];

    const status = await runSidecarPins(
      ["check", "--policy", policyPath, "--only", "postgres"],
      {
        repoDir,
        today: TODAY,
        resolveTag: resolverFor({
          "postgres:18-alpine": { indexDigest: MOVED_INDEX, platformDigest: MOVED_DIGEST },
        }),
        write: (line) => output.push(line),
        writeError: (line) => output.push(line),
      },
    );

    expect(status).toBe(1);
    expect(output.join("")).toContain("sidecar-pins.mjs sync");
  });

  it("exits 2 when it could not see, and says so rather than passing", async () => {
    const { repoDir, policyPath } = alignedRepo();
    const output = [];

    const status = await runSidecarPins(
      ["check", "--policy", policyPath, "--only", "postgres"],
      {
        repoDir,
        today: TODAY,
        resolveTag: resolverFor({
          "postgres:18-alpine": new Error("dial tcp: connection refused"),
        }),
        write: (line) => output.push(line),
        writeError: (line) => output.push(line),
      },
    );

    expect(status).toBe(2);
    expect(output.join("")).toContain("could not");
  });
});

describe("sidecar pins: sync", () => {
  it("adopts the file's pin, re-resolves the index digest and rewrites every location", async () => {
    const document = policy();
    const { repoDir, policyPath } = alignedRepo(document);
    const before = readFileSync(policyPath, "utf8");
    // Stand in for a Dependabot bump: the compose file moves first.
    writeFile(
      repoDir,
      "docker-compose.yml",
      `services:\n  postgres:\n    image: postgres:18-alpine@${MOVED_DIGEST}\n`,
    );

    const result = await syncPins({
      policyPath,
      repoDir,
      only: "postgres",
      today: TODAY,
      resolveTag: resolverFor({
        "postgres:18-alpine": { indexDigest: MOVED_INDEX, platformDigest: MOVED_DIGEST },
      }),
    });

    expect(result.changes).toHaveLength(1);

    const updated = JSON.parse(readFileSync(policyPath, "utf8"));
    const entry = updated.containerImages.find((image) => image.tag === "postgres:18-alpine");
    expect(entry.reference).toBe(`postgres:18-alpine@${MOVED_DIGEST}`);
    expect(entry.indexDigest).toBe(MOVED_INDEX);
    expect(entry.resolvedOn).toBe(TODAY);

    // The second location follows the first.
    expect(readFileSync(join(repoDir, "scripts/test-integration.mjs"), "utf8")).toContain(
      `postgres:18-alpine@${MOVED_DIGEST}`,
    );

    // Everything else in the policy file is byte-identical.
    const after = readFileSync(policyPath, "utf8");
    const normalize = (text) =>
      text
        .replaceAll(MOVED_DIGEST, POSTGRES_DIGEST)
        .replaceAll(MOVED_INDEX, POSTGRES_INDEX)
        .replace(`"resolvedOn": "${TODAY}"`, '"resolvedOn": "2026-08-31"');
    expect(normalize(after)).toBe(before);
  });

  it("leaves the policy alone when nothing moved", async () => {
    const { repoDir, policyPath } = alignedRepo();
    const before = readFileSync(policyPath, "utf8");

    const result = await syncPins({
      policyPath,
      repoDir,
      today: TODAY,
      resolveTag: CURRENT_RESOLVER,
    });

    expect(result.changes).toHaveLength(0);
    expect(readFileSync(policyPath, "utf8")).toBe(before);
  });

  it("never rewrites the Orbit base image, whose digest comes from its own pipeline", async () => {
    const { repoDir, policyPath } = alignedRepo();
    writeFile(
      repoDir,
      "Dockerfile",
      `FROM ghcr.io/tomlawesome/orbit-base-image:latest@${MOVED_DIGEST} AS base\n`,
    );

    await syncPins({
      policyPath,
      repoDir,
      today: TODAY,
      resolveTag: CURRENT_RESOLVER,
    });

    const updated = JSON.parse(readFileSync(policyPath, "utf8"));
    expect(updated.containerImages[0].reference).toBe(
      `ghcr.io/tomlawesome/orbit-base-image:latest@${BASE_DIGEST}`,
    );
  });

  it("refuses, naming the file, when a location holds no pin for the tag", async () => {
    const { repoDir, policyPath } = alignedRepo();
    writeFile(repoDir, "tests/oidc/Dockerfile", "FROM node:24-alpine\n");
    const output = [];

    const status = await runSidecarPins(["sync", "--policy", policyPath, "--only", "node"], {
      repoDir,
      today: TODAY,
      resolveTag: CURRENT_RESOLVER,
      write: (line) => output.push(line),
      writeError: (line) => output.push(line),
    });

    expect(status).toBe(1);
    expect(output.join("")).toContain("tests/oidc/Dockerfile");
  });
});
