import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkPins,
  dockerListTags,
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
const OLLAMA_DIGEST = `sha256:${"7".repeat(64)}`;
const OLLAMA_INDEX = `sha256:${"e".repeat(64)}`;
const TIKA_DIGEST = `sha256:${"c".repeat(64)}`;
const TIKA_INDEX = `sha256:${"d".repeat(64)}`;

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

function ollamaEntry(overrides = {}) {
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
    ...overrides,
  };
}

function tikaEntry(overrides = {}) {
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

describe("sidecar pins: axis 3, has upstream published a newer release", () => {
  function releasePolicy(...entries) {
    return policy({ containerImages: [baseImageEntry(), ...entries] });
  }

  it("reports a newer stable release even though the tag itself has not moved", async () => {
    const result = await checkPins({
      policy: releasePolicy(ollamaEntry()),
      repoDir: scratchDir(),
      drift: false,
      resolveTag: resolverFor({
        "ollama/ollama:0.33.3": { indexDigest: OLLAMA_INDEX, platformDigest: OLLAMA_DIGEST },
      }),
      listTags: async () => ["0.32.0", "0.33.0", "0.33.1", "0.33.2", "0.33.3", "0.34.0", "0.34.1"],
      today: TODAY,
    });

    expect(result.exitCode).toBe(1);
    expect(result.behind).toBe(true);
    const image = imageFor(result, "ollama/ollama:0.33.3");
    // The tag has not moved -- distinct from axis 1's finding -- yet the
    // release axis still sees ollama is behind, naming the newest release.
    expect(image.axes.tag.status).toBe("current");
    expect(image.axes.release.status).toBe("behind");
    expect(image.axes.release.pinnedVersion).toBe("0.33.3");
    expect(image.axes.release.latestVersion).toBe("0.34.1");
    expect(image.axes.release.latestTag).toBe("0.34.1");
    const report = renderReport(result);
    expect(report).toContain("Upstream release");
    expect(report).toContain("0.34.1");
    expect(report).toContain("sidecar-pins.mjs sync");
  });

  it("never offers a pre-release tag as the upgrade, even when its variant matches", async () => {
    const result = await checkPins({
      policy: releasePolicy(tikaEntry()),
      repoDir: scratchDir(),
      drift: false,
      resolveTag: resolverFor({
        "apache/tika:4.0.0-full": { indexDigest: TIKA_INDEX, platformDigest: TIKA_DIGEST },
      }),
      listTags: async () => [
        "4.0.0-full",
        "4.1.0-SNAPSHOT-full", // pre-release, even though its variant is "full"
        "4.1.0-rc1",
        "4.1.0-beta1-full",
      ],
      today: TODAY,
    });

    const image = imageFor(result, "apache/tika:4.0.0-full");
    expect(image.axes.release.status).toBe("current");
    // The pin itself is the only comparable, non-pre-release, same-variant
    // tag seen -- nothing pre-release or off-variant was ever a candidate.
    expect(image.axes.release.latestTag).toBe("4.0.0-full");
  });

  it("never offers a tag of a different variant as the upgrade", async () => {
    const result = await checkPins({
      policy: releasePolicy(tikaEntry()),
      repoDir: scratchDir(),
      drift: false,
      resolveTag: resolverFor({
        "apache/tika:4.0.0-full": { indexDigest: TIKA_INDEX, platformDigest: TIKA_DIGEST },
      }),
      listTags: async () => ["4.0.0-full", "4.1.0", "4.1.0-rocm", "4.1.0-slim"],
      today: TODAY,
    });

    const image = imageFor(result, "apache/tika:4.0.0-full");
    expect(image.axes.release.status).toBe("current");
    expect(image.axes.release.latestTag).toBe("4.0.0-full");
  });

  it("offers a same-variant, non-pre-release tag as the upgrade", async () => {
    const result = await checkPins({
      policy: releasePolicy(tikaEntry()),
      repoDir: scratchDir(),
      drift: false,
      resolveTag: resolverFor({
        "apache/tika:4.0.0-full": { indexDigest: TIKA_INDEX, platformDigest: TIKA_DIGEST },
      }),
      listTags: async () => ["4.0.0-full", "4.1.0-full", "4.1.0-SNAPSHOT-full", "4.1.0-rocm"],
      today: TODAY,
    });

    const image = imageFor(result, "apache/tika:4.0.0-full");
    expect(image.axes.release.status).toBe("behind");
    expect(image.axes.release.latestTag).toBe("4.1.0-full");
  });

  it("does not report a rolling tag with no version to compare", async () => {
    const result = await checkPins({
      policy: releasePolicy(postgresEntry(), nodeEntry()),
      repoDir: scratchDir(),
      drift: false,
      resolveTag: CURRENT_RESOLVER,
      listTags: async () => {
        throw new Error("a rolling tag has nothing to look up upstream tags for");
      },
      today: TODAY,
    });

    expect(result.exitCode).toBe(0);
    expect(result.behind).toBe(false);
    expect(result.blind).toBe(false);
    expect(imageFor(result, "postgres:18-alpine").axes.release.status).toBe("rolling");
    expect(imageFor(result, "node:24-alpine").axes.release.status).toBe("rolling");
  });

  it("is skipped, and never reaches a registry, when --offline is set", async () => {
    const result = await checkPins({
      policy: releasePolicy(ollamaEntry()),
      repoDir: scratchDir(),
      drift: false,
      offline: true,
      listTags: async () => {
        throw new Error("the offline check must not reach a registry");
      },
      today: TODAY,
    });

    expect(result.exitCode).toBe(0);
    expect(imageFor(result, "ollama/ollama:0.33.3").axes.release.status).toBe("skipped");
  });

  it("exits 2, blind rather than a pass, when the registry cannot be asked for its tags", async () => {
    const result = await checkPins({
      policy: releasePolicy(ollamaEntry()),
      repoDir: scratchDir(),
      drift: false,
      resolveTag: resolverFor({
        "ollama/ollama:0.33.3": { indexDigest: OLLAMA_INDEX, platformDigest: OLLAMA_DIGEST },
      }),
      listTags: async () => {
        throw new Error("dial tcp: connection refused");
      },
      today: TODAY,
    });

    expect(result.exitCode).toBe(2);
    expect(result.blind).toBe(true);
    const axis = imageFor(result, "ollama/ollama:0.33.3").axes.release;
    expect(axis.status).toBe("unreachable");
    expect(axis.summary).toContain("connection refused");
  });
});

describe("sidecar pins: dockerListTags, the real registry call", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("gets an anonymous Docker Hub token and follows Link-header pagination", async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
      const href = String(url);
      calls.push(href);
      if (href.startsWith("https://auth.docker.io/token")) {
        expect(href).toContain("repository:ollama/ollama:pull");
        return new Response(JSON.stringify({ token: "anonymous-token" }), { status: 200 });
      }
      if (href === "https://registry-1.docker.io/v2/ollama/ollama/tags/list?n=100") {
        return new Response(JSON.stringify({ tags: ["0.33.3"] }), {
          status: 200,
          headers: {
            link: '</v2/ollama/ollama/tags/list?n=100&last=0.33.3>; rel="next"',
          },
        });
      }
      if (href === "https://registry-1.docker.io/v2/ollama/ollama/tags/list?n=100&last=0.33.3") {
        return new Response(JSON.stringify({ tags: ["0.34.0", "0.34.1"] }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${href}`);
    };

    const tags = await dockerListTags("ollama/ollama");
    expect(tags).toEqual(["0.33.3", "0.34.0", "0.34.1"]);
    expect(calls).toHaveLength(3);
  });

  it("prefixes an official Docker Hub image with library/", async () => {
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.includes("/token")) {
        expect(href).toContain("repository:library/node:pull");
        return new Response(JSON.stringify({ token: "t" }), { status: 200 });
      }
      expect(href).toBe("https://registry-1.docker.io/v2/library/node/tags/list?n=100");
      return new Response(JSON.stringify({ tags: ["24-alpine"] }), { status: 200 });
    };

    expect(await dockerListTags("node")).toEqual(["24-alpine"]);
  });

  it("uses the ghcr.io token and v2 host for a ghcr.io-prefixed repository", async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
      const href = String(url);
      calls.push(href);
      if (href.startsWith("https://ghcr.io/token")) {
        expect(href).toContain("repository:example/widget:pull");
        return new Response(JSON.stringify({ token: "t" }), { status: 200 });
      }
      expect(href).toBe("https://ghcr.io/v2/example/widget/tags/list?n=100");
      return new Response(JSON.stringify({ tags: ["1.0.0"] }), { status: 200 });
    };

    const tags = await dockerListTags("ghcr.io/example/widget");
    expect(tags).toEqual(["1.0.0"]);
    expect(calls).toHaveLength(2);
  });

  it("throws, naming the repository, when the anonymous token request fails", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 500 });
    await expect(dockerListTags("ollama/ollama")).rejects.toThrow(/ollama\/ollama/u);
  });

  it("throws when the tag list request itself fails", async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes("/token")) {
        return new Response(JSON.stringify({ token: "t" }), { status: 200 });
      }
      return new Response("nope", { status: 503 });
    };
    await expect(dockerListTags("ollama/ollama")).rejects.toThrow(/503/u);
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

describe("sidecar pins: --red self-proof, the release axis", () => {
  // entries[0] in these fixtures is always a rolling tag (node:24-alpine),
  // which axis 3 never has anything to compare -- so the release half of
  // --red has to find its own, version-comparable entry (ollama) rather than
  // reusing axis 1's, the way runTagRedCheck does.
  function policyWithOllama() {
    return policy({
      containerImages: [baseImageEntry(), nodeEntry(), postgresEntry(), ollamaEntry()],
    });
  }

  it("passes both halves when the release axis fires on a fabricated old pin", async () => {
    const { repoDir, policyPath } = alignedRepo(policyWithOllama());
    const output = [];

    const status = await runSidecarPins(["check", "--policy", policyPath, "--red"], {
      repoDir,
      today: TODAY,
      resolveTag: CURRENT_RESOLVER,
      // The self-test steps ollama back to 0.33.2 and asks whether upstream
      // has published something newer; this fake registry says yes.
      listTags: async () => ["0.33.2", "0.33.3", "0.34.0", "0.34.1"],
      write: (line) => output.push(line),
      writeError: (line) => output.push(line),
    });

    expect(status).toBe(0);
    const text = output.join("");
    expect(text).toContain("0.33.2");
    expect(text).toContain("self-test passed");
  });

  it("fails, naming the fabricated tag, when the release axis does not fire", async () => {
    const { repoDir, policyPath } = alignedRepo(policyWithOllama());
    const output = [];

    const status = await runSidecarPins(["check", "--policy", policyPath, "--red"], {
      repoDir,
      today: TODAY,
      resolveTag: CURRENT_RESOLVER,
      // A registry that never reports anything newer than the fabricated,
      // deliberately-old pin: exactly the blindness --red exists to catch.
      listTags: async () => ["0.33.0", "0.33.1", "0.33.2"],
      write: (line) => output.push(line),
      writeError: (line) => output.push(line),
    });

    expect(status).toBe(1);
    const text = output.join("");
    expect(text).toContain("did not fire on a deliberately old release pin");
    expect(text).toContain("ollama/ollama:0.33.2");
  });

  it("skips the release half, but still passes overall, when nothing pinned has a version to step back from", async () => {
    const { repoDir, policyPath } = alignedRepo();
    const output = [];

    const status = await runSidecarPins(["check", "--policy", policyPath, "--red"], {
      repoDir,
      today: TODAY,
      resolveTag: CURRENT_RESOLVER,
      listTags: async () => {
        throw new Error("no version-comparable pin should ever reach the registry here");
      },
      write: (line) => output.push(line),
      writeError: (line) => output.push(line),
    });

    expect(status).toBe(0);
    expect(output.join("")).toContain("no version-comparable image");
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

describe("sidecar pins: the CI job has the tools the check shells out to", () => {
  it("installs the buildx plugin alongside the Docker client", () => {
    // Axis 1 resolves a tag with `docker buildx imagetools inspect --format`.
    // Without docker-buildx-plugin that fails as "unknown flag: --format",
    // and the self-test reports 'unreachable' (pipeline 321, #820).
    const gitlabCi = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");
    const anchor = gitlabCi.slice(gitlabCi.indexOf("\n.docker_cli:"), gitlabCi.indexOf("\n.drop_to_node"));

    expect(anchor).toMatch(/apt-get install [^\n]* docker-buildx-plugin/u);
    expect(anchor).toContain("docker buildx version");
  });
});

describe("sidecar pins: every pinned .gitlab-ci.yml image is a tracked location (#807)", () => {
  // A pin the policy does not know about is a pin `check --offline` never
  // looks at: drift between .gitlab-ci.yml and the policy would go silent.
  // This reads the real files rather than a fixture, because the point is
  // whether the two are in step right now, not whether the mechanism works
  // on made-up input.
  it("lists .gitlab-ci.yml in the locations of every policy entry it pins", () => {
    const gitlabCi = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");
    const realPolicy = JSON.parse(
      readFileSync(new URL("../.github/supply-chain-policy.json", import.meta.url), "utf8"),
    );

    const pinnedImages = [...gitlabCi.matchAll(/^\s*[A-Z0-9_]+_IMAGE:\s*(\S+@sha256:[0-9a-f]{64})\s*$/gmu)].map(
      (match) => match[1],
    );
    // A fixture-free assertion that the extraction itself still works: if
    // .gitlab-ci.yml stops pinning anything by digest, the test below would
    // pass vacuously and prove nothing.
    expect(pinnedImages.length).toBeGreaterThan(0);

    const matchedEntries = new Set();
    for (const pinned of pinnedImages) {
      const tag = pinned.slice(0, pinned.indexOf("@"));
      const entry = realPolicy.containerImages.find((candidate) => candidate.tag === tag);
      if (entry) matchedEntries.add(entry.name);
    }
    // Guard the guard: at least one pinned image (postgres) must actually
    // match a policy entry, or the loop below checks nothing.
    expect(matchedEntries.size).toBeGreaterThan(0);

    for (const pinned of pinnedImages) {
      const tag = pinned.slice(0, pinned.indexOf("@"));
      const entry = realPolicy.containerImages.find((candidate) => candidate.tag === tag);
      if (!entry) continue; // not every .gitlab-ci.yml pin is policy-tracked (e.g. the scanner image)
      expect(entry.locations, `${entry.name} (${tag}) should list .gitlab-ci.yml`).toContain(
        ".gitlab-ci.yml",
      );
    }
  });
});
