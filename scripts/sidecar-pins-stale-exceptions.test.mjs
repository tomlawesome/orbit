import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkPins, runSidecarPins } from "./sidecar-pins.mjs";

// Specification: ai/orbit#1950. `check --packages` accepts named, expiring
// `stale-package` exceptions (owner decision 89a). A pending upgrade is covered
// only when image, package, installedVersion and availableVersion all match.

const LIVE_DATE = "2099-12-31";
const EXCEPTION_EXPIRY = "2098-01-02";
const TRACKING = 7777;
const TODAY = "2026-11-23";
const POSTGRES_TAG = "postgres:18-alpine";

const POSTGRES_DIGEST = `sha256:${"1".repeat(64)}`;
const POSTGRES_INDEX = `sha256:${"2".repeat(64)}`;
const NODE_DIGEST = `sha256:${"3".repeat(64)}`;
const NODE_INDEX = `sha256:${"4".repeat(64)}`;
const BASE_DIGEST = `sha256:${"5".repeat(64)}`;
const BASE_INDEX = `sha256:${"6".repeat(64)}`;

const scratchDirs = [];
afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-sidecar-stale-"));
  scratchDirs.push(dir);
  return dir;
}

function pinEntry(fields) {
  return {
    platform: "linux/amd64",
    license: "MIT",
    updateOwner: "Orbit maintainers",
    resolvedOn: "2026-11-01",
    reviewBy: LIVE_DATE,
    ...fields,
  };
}

function policy(exceptions = []) {
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
    thresholds: {
      sourceVulnerabilities: ["HIGH", "CRITICAL"],
      sourceSecrets: ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"],
      imageVulnerabilities: ["HIGH", "CRITICAL"],
    },
    exceptions,
    containerImages: [
      pinEntry({
        name: "Orbit base image",
        tag: "ghcr.io/tomlawesome/orbit-base-image:latest",
        reference: `ghcr.io/tomlawesome/orbit-base-image:latest@${BASE_DIGEST}`,
        indexDigest: BASE_INDEX,
        locations: ["Dockerfile"],
        source: "https://gitlab.tomlawson.io/ai/orbit-base-image",
        registry: "https://github.com/tomlawesome/orbit/pkgs/container/orbit-base-image",
        licenseSource: "https://github.com/nodejs/node/blob/main/LICENSE",
      }),
      pinEntry({
        name: "PostgreSQL database",
        tag: POSTGRES_TAG,
        reference: `${POSTGRES_TAG}@${POSTGRES_DIGEST}`,
        indexDigest: POSTGRES_INDEX,
        locations: ["docker-compose.yml"],
        source: "https://github.com/docker-library/postgres",
        registry: "https://hub.docker.com/_/postgres",
        licenseSource: "https://github.com/docker-library/postgres/blob/master/LICENSE",
      }),
      pinEntry({
        name: "Node.js build and runtime",
        tag: "node:24-alpine",
        reference: `node:24-alpine@${NODE_DIGEST}`,
        indexDigest: NODE_INDEX,
        locations: ["tests/oidc/Dockerfile"],
        source: "https://github.com/nodejs/docker-node",
        registry: "https://hub.docker.com/_/node",
        licenseSource: "https://github.com/nodejs/docker-node/blob/main/LICENSE",
      }),
    ],
    mutableImageReferences: [],
  };
}

function exception(overrides = {}) {
  return {
    kind: "stale-package",
    image: POSTGRES_TAG,
    package: "libxml2",
    installedVersion: "2.13.9-r2",
    availableVersion: "2.13.9-r3",
    owner: "Orbit maintainers",
    rationale: "Upstream has not rebuilt the image yet.",
    expiresOn: EXCEPTION_EXPIRY,
    trackingIssue: TRACKING,
    ...overrides,
  };
}

function writeFile(repoDir, relativePath, content) {
  const path = join(repoDir, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function alignedRepo(document) {
  const repoDir = scratchDir();
  writeFile(repoDir, "Dockerfile", `FROM ${document.containerImages[0].reference} AS base\n`);
  writeFile(
    repoDir,
    "docker-compose.yml",
    `services:\n  postgres:\n    image: ${document.containerImages[1].reference}\n`,
  );
  writeFile(repoDir, "tests/oidc/Dockerfile", `FROM ${document.containerImages[2].reference}\n`);
  const policyPath = join(repoDir, "policy.json");
  writeFileSync(policyPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { repoDir, policyPath };
}

const CURRENT_RESOLVER = async (tag) => {
  const map = {
    [POSTGRES_TAG]: { indexDigest: POSTGRES_INDEX, platformDigest: POSTGRES_DIGEST },
    "node:24-alpine": { indexDigest: NODE_INDEX, platformDigest: NODE_DIGEST },
  };
  if (!(tag in map)) throw new Error(`no fake resolution for ${tag}`);
  return map[tag];
};

const LIBXML2 = "(1/2) Upgrading libxml2 (2.13.9-r2 -> 2.13.9-r3)";
const MUSL = "(2/2) Upgrading musl (1.2.5-r9 -> 1.2.5-r10)";
const APK = (...lines) => ({ manager: "apk", output: [...lines, "OK: 12 MiB in 40 packages"].join("\n") });
const APT_LINE =
  "Inst libapt-pkg7.0 [3.2.0] (3.2.1ubuntu0.1 Ubuntu:26.04/resolute-updates [amd64])";

async function check(exceptions, simulation) {
  const document = policy(exceptions);
  const { repoDir } = alignedRepo(document);
  const result = await checkPins({
    policy: document,
    repoDir,
    only: "postgres",
    packages: true,
    resolveTag: CURRENT_RESOLVER,
    simulatePackages: async () => simulation,
    today: TODAY,
  });
  return result.images.find((image) => image.tag === POSTGRES_TAG);
}

async function run(exceptions, simulation, extraArgs = []) {
  const document = policy(exceptions);
  const { repoDir, policyPath } = alignedRepo(document);
  const output = [];
  const status = await runSidecarPins(
    ["check", "--packages", "--policy", policyPath, "--only", "postgres", ...extraArgs],
    {
      repoDir,
      today: TODAY,
      resolveTag: CURRENT_RESOLVER,
      simulatePackages: async () => simulation,
      write: (text) => output.push(text),
      writeError: (text) => output.push(text),
    },
  );
  return { status, text: output.join("") };
}

describe("sidecar pins: stale-package exceptions on the packages axis (#1950)", () => {
  it("rule 2: every pending upgrade covered gives status excepted and exit 0", async () => {
    const image = await check([exception()], APK(LIBXML2));
    expect(image.axes.packages.status).toBe("excepted");

    const { status } = await run([exception()], APK(LIBXML2));
    expect(status).toBe(0);
  });

  it("rule 2: the report lists each covered upgrade with its expiry and tracking issue", async () => {
    const { text } = await run([exception()], APK(LIBXML2));
    expect(text).toContain("libxml2");
    expect(text).toContain(EXCEPTION_EXPIRY);
    expect(text).toContain(String(TRACKING));
  });

  it("rule 2: several upgrades each covered by their own exception is excepted, exit 0", async () => {
    const exceptions = [
      exception(),
      exception({ package: "musl", installedVersion: "1.2.5-r9", availableVersion: "1.2.5-r10" }),
    ];
    const image = await check(exceptions, APK(LIBXML2, MUSL));
    expect(image.axes.packages.status).toBe("excepted");
    const { status } = await run(exceptions, APK(LIBXML2, MUSL));
    expect(status).toBe(0);
  });

  it("rule 2: one uncovered upgrade makes the image stale, exit 1, listing only the uncovered one", async () => {
    const image = await check([exception()], APK(LIBXML2, MUSL));
    expect(image.axes.packages.status).toBe("stale");
    const pending = JSON.stringify(image.axes.packages.pending);
    expect(pending).toContain("musl");
    expect(pending).not.toContain("libxml2");

    const { status, text } = await run([exception()], APK(LIBXML2, MUSL));
    expect(status).toBe(1);
    expect(text).toContain("musl");
  });

  it("rule 2: a newer available version than the exception names is uncovered", async () => {
    const newer = "(1/1) Upgrading libxml2 (2.13.9-r2 -> 2.13.9-r4)";
    const image = await check([exception()], APK(newer));
    expect(image.axes.packages.status).toBe("stale");
    expect(JSON.stringify(image.axes.packages.pending)).toContain("2.13.9-r4");
    const { status } = await run([exception()], APK(newer));
    expect(status).toBe(1);
  });

  it("rule 2: a different installed version is uncovered", async () => {
    const other = "(1/1) Upgrading libxml2 (2.13.8-r0 -> 2.13.9-r3)";
    const image = await check([exception()], APK(other));
    expect(image.axes.packages.status).toBe("stale");
  });

  it("rule 2: a different package name is uncovered", async () => {
    const other = "(1/1) Upgrading libxslt (2.13.9-r2 -> 2.13.9-r3)";
    const image = await check([exception()], APK(other));
    expect(image.axes.packages.status).toBe("stale");
  });

  it("rule 2: an exception naming another image does not cover this one", async () => {
    const wrongImage = exception({ image: "node:24-alpine" });
    const image = await check([wrongImage], APK(LIBXML2));
    expect(image.axes.packages.status).toBe("stale");
    const { status } = await run([wrongImage], APK(LIBXML2));
    expect(status).toBe(1);
  });

  it("rule 2: an upgrade line that cannot be parsed is uncovered, never silently dropped", async () => {
    const garbled = "(2/2) Upgrading ??? no versions here";
    const image = await check([exception()], APK(LIBXML2, garbled));
    expect(image.axes.packages.status).toBe("stale");
    expect(JSON.stringify(image.axes.packages.pending)).toContain("no versions here");
    const { status } = await run([exception()], APK(LIBXML2, garbled));
    expect(status).toBe(1);
  });

  it("rule 2: apt output is parsed into package, installed and available version", async () => {
    const apt = {
      manager: "apt",
      output: ["Reading package lists...", APT_LINE, "Conf libapt-pkg7.0 (3.2.1ubuntu0.1 Ubuntu [amd64])"].join("\n"),
    };
    const covering = exception({
      package: "libapt-pkg7.0",
      installedVersion: "3.2.0",
      availableVersion: "3.2.1ubuntu0.1",
    });
    expect((await check([covering], apt)).axes.packages.status).toBe("excepted");
    expect((await run([covering], apt)).status).toBe(0);

    const newer = exception({
      package: "libapt-pkg7.0",
      installedVersion: "3.2.0",
      availableVersion: "3.2.2",
    });
    expect((await check([newer], apt)).axes.packages.status).toBe("stale");
  });

  it("rule 2: no pending upgrades is current, exit 0, even with an exception present", async () => {
    const image = await check([exception()], APK());
    expect(image.axes.packages.status).toBe("current");
    expect((await run([], APK())).status).toBe(0);
  });

  it("rule 2: an exception that matches nothing is reported as unused, not as a failure", async () => {
    const { status, text } = await run([exception()], APK());
    expect(status).toBe(0);
    expect(text).toMatch(/unused/iu);
    expect(text).toContain("libxml2");
  });

  it("rule 2: an unused exception is noted while the other upgrades are still covered", async () => {
    const spare = exception({ package: "zlib", installedVersion: "1.3.1-r1", availableVersion: "1.3.1-r2" });
    const { status, text } = await run([exception(), spare], APK(LIBXML2));
    expect(status).toBe(0);
    expect(text).toMatch(/unused/iu);
    expect(text).toContain("zlib");
  });

  it("rule 3: the packages axis is still skipped, and exceptions ignored, without --packages", async () => {
    const document = policy([exception()]);
    const { repoDir } = alignedRepo(document);
    const result = await checkPins({
      policy: document,
      repoDir,
      only: "postgres",
      resolveTag: CURRENT_RESOLVER,
      simulatePackages: async () => {
        throw new Error("the package axis must not run without --packages");
      },
      today: TODAY,
    });
    expect(result.images[0].axes.packages.status).toBe("skipped");
    expect(result.exitCode).toBe(0);
  });

  it("rule 3: an image that cannot be queried is still exit 2, exceptions or not", async () => {
    const document = policy([exception()]);
    const { repoDir } = alignedRepo(document);
    const result = await checkPins({
      policy: document,
      repoDir,
      only: "postgres",
      packages: true,
      resolveTag: CURRENT_RESOLVER,
      simulatePackages: async () => {
        throw new Error("docker pull failed");
      },
      today: TODAY,
    });
    expect(result.images[0].axes.packages.status).toBe("unreachable");
    expect(result.exitCode).toBe(2);
  });

  it("rule 3: a moved tag still fails the digest axis (exit 1) even when packages are excepted", async () => {
    const document = policy([exception()]);
    const { repoDir } = alignedRepo(document);
    const result = await checkPins({
      policy: document,
      repoDir,
      only: "postgres",
      packages: true,
      resolveTag: async () => ({
        indexDigest: `sha256:${"8".repeat(64)}`,
        platformDigest: `sha256:${"9".repeat(64)}`,
      }),
      simulatePackages: async () => APK(LIBXML2),
      today: TODAY,
    });
    expect(result.images[0].axes.packages.status).toBe("excepted");
    expect(result.exitCode).toBe(1);
  });

  it("rule 1: an expired stale-package exception makes the check refuse the policy (exit 2)", async () => {
    const { status, text } = await run([exception({ expiresOn: "2026-11-22" })], APK(LIBXML2));
    expect(status).toBe(2);
    expect(text).toMatch(/Exception 1/u);
    expect(text).toMatch(/expired/iu);
    expect(text).not.toMatch(/only a vulnerability/iu);
  });

  it("rule 4: the stale remedy text names the stale-package kind and its fields", async () => {
    const { text } = await run([], APK(LIBXML2));
    expect(text).toContain("stale-package");
    for (const field of ["installedVersion", "availableVersion", "trackingIssue"]) {
      expect(text).toContain(field);
    }
  });
});
