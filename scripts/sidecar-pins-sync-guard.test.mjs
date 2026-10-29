// #1551: `sync` must never record an index that does not hold the pinned
// image, and `check` must flag a pin that names an index rather than the
// linux/amd64 manifest. Written from the issue, before the code.
//
// Stub convention (copied from sidecar-pins.test.mjs): `resolveTag` is
// injected and answers `{ indexDigest, platformDigest }` for a tag. A pin is a
// child of the tag's current index exactly when it equals `platformDigest`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runSidecarPins } from "./sidecar-pins.mjs";

const LIVE_DATE = "2099-12-31";
const TODAY = "2026-10-29";
const OLD_DATE = "2026-08-30";

const hex = (character) => `sha256:${character.repeat(64)}`;
const BASE_DIGEST = hex("5");
const BASE_INDEX = hex("6");
const POSTGRES_DIGEST = hex("1");
const POSTGRES_INDEX = hex("2");
const POSTGRES_NEW_DIGEST = hex("9");
const POSTGRES_NEW_INDEX = hex("8");
// node:24-alpine: the pin names the OLD build's amd64 manifest; the tag has
// since been republished, so the current index does not contain it.
const NODE_DIGEST = hex("3");
const NODE_INDEX = hex("4");
const NODE_REBUILD_DIGEST = hex("f");
const NODE_REBUILD_INDEX = hex("b");
const TIKA_DIGEST = hex("c");
const TIKA_INDEX = hex("d");

const scratchDirs = [];
afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

function entry(fields) {
  return {
    platform: "linux/amd64",
    license: "MIT",
    updateOwner: "Orbit maintainers",
    resolvedOn: OLD_DATE,
    reviewBy: LIVE_DATE,
    ...fields,
  };
}

const baseImage = () =>
  entry({
    name: "Orbit base image",
    tag: "ghcr.io/tomlawesome/orbit-base-image:latest",
    reference: `ghcr.io/tomlawesome/orbit-base-image:latest@${BASE_DIGEST}`,
    indexDigest: BASE_INDEX,
    locations: ["Dockerfile"],
    source: "https://gitlab.tomlawson.io/ai/orbit-base-image",
    registry: "https://github.com/tomlawesome/orbit/pkgs/container/orbit-base-image",
    licenseSource: "https://github.com/nodejs/node/blob/main/LICENSE",
  });

const postgres = () =>
  entry({
    name: "PostgreSQL database",
    tag: "postgres:18-alpine",
    reference: `postgres:18-alpine@${POSTGRES_DIGEST}`,
    indexDigest: POSTGRES_INDEX,
    locations: ["docker-compose.yml"],
    source: "https://github.com/docker-library/postgres",
    registry: "https://hub.docker.com/_/postgres",
    licenseSource: "https://github.com/docker-library/postgres/blob/master/LICENSE",
  });

const node = () =>
  entry({
    name: "Node.js build and runtime",
    tag: "node:24-alpine",
    reference: `node:24-alpine@${NODE_DIGEST}`,
    indexDigest: NODE_INDEX,
    locations: ["tests/oidc/Dockerfile"],
    source: "https://github.com/nodejs/docker-node",
    registry: "https://hub.docker.com/_/node",
    licenseSource: "https://github.com/nodejs/docker-node/blob/main/LICENSE",
  });

// Tika pinned to the multi-platform INDEX: its pin digest equals its index.
const tikaPinnedToIndex = () =>
  entry({
    name: "Apache Tika parser",
    tag: "apache/tika:4.0.0-full",
    reference: `apache/tika:4.0.0-full@${TIKA_INDEX}`,
    indexDigest: TIKA_INDEX,
    license: "Apache-2.0",
    locations: ["docker-compose.yml"],
    source: "https://github.com/apache/tika-docker",
    registry: "https://hub.docker.com/r/apache/tika",
    licenseSource: "https://github.com/apache/tika/blob/main/LICENSE.txt",
  });

function policy(containerImages) {
  return {
    schemaVersion: 1,
    scanner: {
      name: "Trivy",
      version: "0.72.0",
      image: `aquasec/trivy@${hex("a")}`,
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
    containerImages,
    mutableImageReferences: [],
  };
}

function writeFile(repoDir, relativePath, content) {
  const path = join(repoDir, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

// A repo whose files hold exactly what each policy entry pins.
function repoFor(images) {
  const repoDir = mkdtempSync(join(tmpdir(), "orbit-sidecar-pins-guard-"));
  scratchDirs.push(repoDir);
  const compose = images
    .filter((image) => image.locations.includes("docker-compose.yml"))
    .map((image, index) => `  svc${index}:\n    image: ${image.reference}\n`)
    .join("");
  writeFile(repoDir, "Dockerfile", `FROM ${images[0].reference} AS base\n`);
  writeFile(repoDir, "docker-compose.yml", `services:\n${compose}`);
  const nodeImage = images.find((image) => image.tag === "node:24-alpine");
  if (nodeImage) writeFile(repoDir, "tests/oidc/Dockerfile", `FROM ${nodeImage.reference}\n`);
  const policyPath = join(repoDir, "policy.json");
  writeFileSync(policyPath, `${JSON.stringify(policy(images), null, 2)}\n`, "utf8");
  return { repoDir, policyPath };
}

function resolverFor(map) {
  return async (tag) => {
    if (!(tag in map)) throw new Error(`no fake resolution for ${tag}`);
    return map[tag];
  };
}

async function run(argv, { repoDir, resolveTag }) {
  const output = [];
  const status = await runSidecarPins(argv, {
    repoDir,
    today: TODAY,
    resolveTag,
    write: (text) => output.push(text),
    writeError: (text) => output.push(text),
  });
  return { status, text: output.join("") };
}

const entryFor = (policyPath, tag) =>
  JSON.parse(readFileSync(policyPath, "utf8")).containerImages.find((image) => image.tag === tag);

// The tag was republished: the pin file still names the OLD amd64 manifest,
// which the new index does not contain.
const REBUILT_NODE = {
  indexDigest: NODE_REBUILD_INDEX,
  platformDigest: NODE_REBUILD_DIGEST,
};

describe("sidecar pins sync: never records an index that does not hold the pin (#1551)", () => {
  it("changes nothing for a pin that is not a child of the tag's current index", async () => {
    const images = [baseImage(), node()];
    const { repoDir, policyPath } = repoFor(images);
    const before = readFileSync(policyPath, "utf8");

    const { status } = await run(["sync", "--policy", policyPath], {
      repoDir,
      resolveTag: resolverFor({ "node:24-alpine": REBUILT_NODE }),
    });

    expect(status).toBe(0);
    expect(readFileSync(policyPath, "utf8")).toBe(before);
    expect(entryFor(policyPath, "node:24-alpine").indexDigest).toBe(NODE_INDEX);
  });

  it("prints a line naming the skipped pin and saying it was skipped", async () => {
    const images = [baseImage(), node()];
    const { repoDir, policyPath } = repoFor(images);

    const { text } = await run(["sync", "--policy", policyPath], {
      repoDir,
      resolveTag: resolverFor({ "node:24-alpine": REBUILT_NODE }),
    });

    const line = text.split("\n").find((l) => /skip/i.test(l) && l.includes("node:24-alpine"));
    expect(line, `no line naming node:24-alpine and 'skip' in:\n${text}`).toBeDefined();
    // The reason is the point of the line: the pin is not in the current index.
    expect(line).toMatch(/index/i);
  });

  it("keeps the old resolvedOn on the policy entry of a skipped pin", async () => {
    const images = [baseImage(), node()];
    const { repoDir, policyPath } = repoFor(images);

    await run(["sync", "--policy", policyPath], {
      repoDir,
      resolveTag: resolverFor({ "node:24-alpine": REBUILT_NODE }),
    });

    const kept = entryFor(policyPath, "node:24-alpine");
    expect(kept.resolvedOn).toBe(OLD_DATE);
    expect(kept).toEqual(node());
  });

  it("still syncs the other pins when one is skipped", async () => {
    const images = [baseImage(), postgres(), node()];
    const { repoDir, policyPath } = repoFor(images);
    // Dependabot bumped postgres in the compose file; node's file is untouched.
    writeFile(
      repoDir,
      "docker-compose.yml",
      `services:\n  postgres:\n    image: postgres:18-alpine@${POSTGRES_NEW_DIGEST}\n`,
    );

    const { status, text } = await run(["sync", "--policy", policyPath], {
      repoDir,
      resolveTag: resolverFor({
        "postgres:18-alpine": {
          indexDigest: POSTGRES_NEW_INDEX,
          platformDigest: POSTGRES_NEW_DIGEST,
        },
        "node:24-alpine": REBUILT_NODE,
      }),
    });

    expect(status).toBe(0);
    const synced = entryFor(policyPath, "postgres:18-alpine");
    expect(synced.reference).toBe(`postgres:18-alpine@${POSTGRES_NEW_DIGEST}`);
    expect(synced.indexDigest).toBe(POSTGRES_NEW_INDEX);
    expect(synced.resolvedOn).toBe(TODAY);
    expect(entryFor(policyPath, "node:24-alpine")).toEqual(node());
    expect(text).toMatch(/skip/i);
  });

  it("records the index and today's date when the pin is a child of the current index", async () => {
    const images = [baseImage(), node()];
    const { repoDir, policyPath } = repoFor(images);
    // The tag moved on, and the file was bumped to the new amd64 manifest.
    writeFile(repoDir, "tests/oidc/Dockerfile", `FROM node:24-alpine@${NODE_REBUILD_DIGEST}\n`);

    const { status } = await run(["sync", "--policy", policyPath], {
      repoDir,
      resolveTag: resolverFor({ "node:24-alpine": REBUILT_NODE }),
    });

    expect(status).toBe(0);
    const synced = entryFor(policyPath, "node:24-alpine");
    expect(synced.reference).toBe(`node:24-alpine@${NODE_REBUILD_DIGEST}`);
    expect(synced.indexDigest).toBe(NODE_REBUILD_INDEX);
    expect(synced.resolvedOn).toBe(TODAY);
  });

  it("records the current index when the pin is a child and only the index moved", async () => {
    const images = [baseImage(), node()];
    const { repoDir, policyPath } = repoFor(images);

    const { status, text } = await run(["sync", "--policy", policyPath], {
      repoDir,
      resolveTag: resolverFor({
        "node:24-alpine": { indexDigest: NODE_REBUILD_INDEX, platformDigest: NODE_DIGEST },
      }),
    });

    expect(status).toBe(0);
    expect(text).not.toMatch(/skip/i);
    const synced = entryFor(policyPath, "node:24-alpine");
    expect(synced.indexDigest).toBe(NODE_REBUILD_INDEX);
    expect(synced.resolvedOn).toBe(TODAY);
  });
});

describe("sidecar pins check: a pin must be the linux/amd64 manifest, not the index (#1551)", () => {
  it("flags a pin whose digest is the multi-platform index, naming the pin, and fails", async () => {
    const images = [baseImage(), tikaPinnedToIndex()];
    const { repoDir, policyPath } = repoFor(images);

    const { status, text } = await run(["check", "--policy", policyPath, "--only", "tika"], {
      repoDir,
      resolveTag: resolverFor({
        "apache/tika:4.0.0-full": { indexDigest: TIKA_INDEX, platformDigest: TIKA_DIGEST },
      }),
    });

    expect(status).not.toBe(0);
    expect(text).toContain("apache/tika:4.0.0-full");
    expect(text).toMatch(/multi-platform|\bis an? (?:image )?index\b|names? the index/i);
  });

  it("does not flag a pin that is the linux/amd64 manifest", async () => {
    const images = [baseImage(), postgres()];
    const { repoDir, policyPath } = repoFor(images);

    const { status, text } = await run(["check", "--policy", policyPath, "--only", "postgres"], {
      repoDir,
      resolveTag: resolverFor({
        "postgres:18-alpine": { indexDigest: POSTGRES_INDEX, platformDigest: POSTGRES_DIGEST },
      }),
    });

    expect(status).toBe(0);
    expect(text).not.toMatch(/multi-platform|\bis an? (?:image )?index\b|names? the index/i);
  });
});
