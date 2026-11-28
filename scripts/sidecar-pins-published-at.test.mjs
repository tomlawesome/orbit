// Tests for dockerTagPublishedAt (#1997): the build time of a tag's
// linux/amd64 image, read through the registry v2 HTTP API. It must throw
// whenever the registry cannot be read, so the release gate reports "could
// not check" instead of passing. No test touches the network: fetch is
// replaced by a fake that answers by URL and records every request.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { checkPins, dockerTagPublishedAt } from "./sidecar-pins.mjs";

const REPOSITORY = "ollama/ollama";
const TAG = "0.34.0";

const AMD64_MANIFEST = `sha256:${"1".repeat(64)}`;
const ARM64_MANIFEST = `sha256:${"2".repeat(64)}`;
const ATTEST_MANIFEST = `sha256:${"3".repeat(64)}`;
const AMD64_CONFIG = `sha256:${"a".repeat(64)}`;
const ARM64_CONFIG = `sha256:${"b".repeat(64)}`;
const ATTEST_CONFIG = `sha256:${"c".repeat(64)}`;

const AMD64_CREATED = "2026-11-20T10:11:12.123456789Z";
const ARM64_CREATED = "2026-11-21T01:02:03Z";
const ATTEST_CREATED = "2026-11-22T04:05:06Z";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function headersOf(init) {
  const out = {};
  for (const [name, value] of Object.entries(init?.headers ?? {})) {
    out[name.toLowerCase()] = value;
  }
  return out;
}

// Replaces globalThis.fetch. `answer(url)` returns a Response, or throws to
// simulate a network error. Every request is recorded.
function stubRegistry(answer) {
  const requests = [];
  vi.stubGlobal("fetch", async (input, init) => {
    const url = typeof input === "string" ? input : (input.url ?? String(input));
    requests.push({ url, headers: headersOf(init) });
    return answer(url);
  });
  return requests;
}

const isToken = (url) => url.includes("/token");
const isTagManifest = (url) => url.endsWith(`/manifests/${TAG}`);
const endsWithDigest = (url, digest) => url.endsWith(`/${digest}`);

function multiArchIndex() {
  return {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        digest: ATTEST_MANIFEST,
        platform: { os: "unknown", architecture: "unknown" },
      },
      { digest: ARM64_MANIFEST, platform: { os: "linux", architecture: "arm64" } },
      { digest: AMD64_MANIFEST, platform: { os: "linux", architecture: "amd64" } },
    ],
  };
}

function manifestFor(configDigest) {
  return { schemaVersion: 2, config: { digest: configDigest } };
}

// A healthy registry; `override(url)` may return a Response (or throw) to
// break one step, or undefined to leave the step healthy.
function healthyRegistry({ index = multiArchIndex(), configs, override } = {}) {
  const configBodies = configs ?? {
    [AMD64_CONFIG]: { created: AMD64_CREATED },
    [ARM64_CONFIG]: { created: ARM64_CREATED },
    [ATTEST_CONFIG]: { created: ATTEST_CREATED },
  };
  return (url) => {
    const overridden = override?.(url);
    if (overridden !== undefined) return overridden;
    if (isToken(url)) return jsonResponse({ token: "anon-token" });
    if (isTagManifest(url)) return jsonResponse(index);
    if (endsWithDigest(url, AMD64_MANIFEST)) return jsonResponse(manifestFor(AMD64_CONFIG));
    if (endsWithDigest(url, ARM64_MANIFEST)) return jsonResponse(manifestFor(ARM64_CONFIG));
    if (endsWithDigest(url, ATTEST_MANIFEST)) return jsonResponse(manifestFor(ATTEST_CONFIG));
    for (const [digest, body] of Object.entries(configBodies)) {
      if (endsWithDigest(url, digest)) return jsonResponse(body);
    }
    return new Response("not found", { status: 404 });
  };
}

describe("dockerTagPublishedAt: what it returns", () => {
  it("returns the created time of the linux/amd64 config of a multi-architecture tag", async () => {
    const requests = stubRegistry(healthyRegistry());

    await expect(dockerTagPublishedAt(REPOSITORY, TAG)).resolves.toBe(AMD64_CREATED);

    const urls = requests.map((request) => request.url);
    expect(urls.some((url) => endsWithDigest(url, AMD64_CONFIG))).toBe(true);
    expect(urls.some((url) => endsWithDigest(url, ARM64_CONFIG))).toBe(false);
    expect(urls.some((url) => endsWithDigest(url, ATTEST_CONFIG))).toBe(false);
    expect(urls.some((url) => endsWithDigest(url, ARM64_MANIFEST))).toBe(false);
    expect(urls.some((url) => endsWithDigest(url, ATTEST_MANIFEST))).toBe(false);
  });

  it("reads the registry with an anonymous token and sends it on every registry request", async () => {
    const requests = stubRegistry(healthyRegistry());
    await dockerTagPublishedAt(REPOSITORY, TAG);

    const registryRequests = requests.filter((request) => !isToken(request.url));
    expect(registryRequests.length).toBeGreaterThanOrEqual(3);
    for (const request of registryRequests) {
      expect(request.headers.authorization).toBe("Bearer anon-token");
    }
    // The token request carries no credential of its own.
    expect(requests.filter((request) => isToken(request.url))).toHaveLength(1);
    expect(requests.find((request) => isToken(request.url)).headers.authorization).toBeUndefined();
  });

  it("returns the created time of a single-architecture tag read from its plain manifest", async () => {
    const requests = stubRegistry(
      healthyRegistry({
        index: manifestFor(AMD64_CONFIG),
      }),
    );

    await expect(dockerTagPublishedAt(REPOSITORY, TAG)).resolves.toBe(AMD64_CREATED);
    expect(requests.some((request) => endsWithDigest(request.url, AMD64_CONFIG))).toBe(true);
  });
});

describe("dockerTagPublishedAt: it throws whenever the registry cannot be read", () => {
  it("rejects when the token request answers 500", async () => {
    stubRegistry(healthyRegistry({ override: (url) => (isToken(url) ? new Response("", { status: 500 }) : undefined) }));
    await expect(dockerTagPublishedAt(REPOSITORY, TAG)).rejects.toThrow();
  });

  it("rejects when the tag manifest answers 404", async () => {
    stubRegistry(
      healthyRegistry({ override: (url) => (isTagManifest(url) ? new Response("", { status: 404 }) : undefined) }),
    );
    await expect(dockerTagPublishedAt(REPOSITORY, TAG)).rejects.toThrow();
  });

  it("rejects when the linux/amd64 manifest answers 500", async () => {
    stubRegistry(
      healthyRegistry({
        override: (url) => (endsWithDigest(url, AMD64_MANIFEST) ? new Response("", { status: 500 }) : undefined),
      }),
    );
    await expect(dockerTagPublishedAt(REPOSITORY, TAG)).rejects.toThrow();
  });

  it("rejects when the config blob answers 500", async () => {
    stubRegistry(
      healthyRegistry({
        override: (url) => (endsWithDigest(url, AMD64_CONFIG) ? new Response("", { status: 500 }) : undefined),
      }),
    );
    await expect(dockerTagPublishedAt(REPOSITORY, TAG)).rejects.toThrow();
  });

  it("rejects when a response body is not JSON", async () => {
    stubRegistry(
      healthyRegistry({
        override: (url) =>
          endsWithDigest(url, AMD64_CONFIG) ? new Response("<html>not json</html>", { status: 200 }) : undefined,
      }),
    );
    await expect(dockerTagPublishedAt(REPOSITORY, TAG)).rejects.toThrow();
  });

  it("rejects when the index has no linux/amd64 entry", async () => {
    const index = multiArchIndex();
    index.manifests = index.manifests.filter((entry) => entry.platform.architecture !== "amd64");
    stubRegistry(healthyRegistry({ index }));
    await expect(dockerTagPublishedAt(REPOSITORY, TAG)).rejects.toThrow();
  });

  it("rejects when fetch itself rejects with a network error", async () => {
    stubRegistry(() => {
      throw new TypeError("fetch failed");
    });
    await expect(dockerTagPublishedAt(REPOSITORY, TAG)).rejects.toThrow();
  });
});

describe("dockerTagPublishedAt: a config with no created time", () => {
  it("does not reject and returns no usable time", async () => {
    stubRegistry(healthyRegistry({ configs: { [AMD64_CONFIG]: { architecture: "amd64" } } }));

    const result = await dockerTagPublishedAt(REPOSITORY, TAG);
    expect(result).toBeFalsy();
  });
});

describe("checkPins: a build time without a zone is never trusted", () => {
  const LIVE_DATE = "2099-12-31";
  const NOW = new Date("2026-11-27T12:00:00.000Z");
  const OLLAMA_DIGEST = `sha256:${"7".repeat(64)}`;
  const OLLAMA_INDEX = `sha256:${"e".repeat(64)}`;
  const BASE_DIGEST = `sha256:${"5".repeat(64)}`;
  const BASE_INDEX = `sha256:${"6".repeat(64)}`;

  const scratch = [];
  afterEach(() => {
    while (scratch.length > 0) rmSync(scratch.pop(), { recursive: true, force: true });
  });

  function entry(overrides) {
    return {
      locations: ["docker-compose.yml"],
      platform: "linux/amd64",
      updateOwner: "Orbit maintainers",
      resolvedOn: "2026-08-30",
      reviewBy: LIVE_DATE,
      ...overrides,
    };
  }

  function policy() {
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
      containerImages: [
        entry({
          name: "Orbit base image",
          tag: "ghcr.io/tomlawesome/orbit-base-image:latest",
          reference: `ghcr.io/tomlawesome/orbit-base-image:latest@${BASE_DIGEST}`,
          indexDigest: BASE_INDEX,
          locations: ["Dockerfile"],
          source: "https://gitlab.tomlawson.io/ai/orbit-base-image",
          registry: "https://github.com/tomlawesome/orbit/pkgs/container/orbit-base-image",
          license: "MIT",
          licenseSource: "https://github.com/nodejs/node/blob/main/LICENSE",
        }),
        entry({
          name: "Ollama optional local AI service",
          tag: "ollama/ollama:0.33.3",
          reference: `ollama/ollama:0.33.3@${OLLAMA_DIGEST}`,
          indexDigest: OLLAMA_INDEX,
          source: "https://github.com/ollama/ollama",
          registry: "https://hub.docker.com/r/ollama/ollama",
          license: "MIT",
          licenseSource: "https://github.com/ollama/ollama/blob/main/LICENSE",
        }),
      ],
      mutableImageReferences: [],
    };
  }

  async function releaseFor(rawTime) {
    const repoDir = mkdtempSync(join(tmpdir(), "orbit-sidecar-pins-published-at-"));
    scratch.push(repoDir);
    const result = await checkPins({
      policy: policy(),
      repoDir,
      drift: false,
      resolveTag: async () => ({ indexDigest: OLLAMA_INDEX, platformDigest: OLLAMA_DIGEST }),
      listTags: async () => ["0.33.3", "0.34.0"],
      tagPublishedAt: async () => rawTime,
      now: NOW,
      today: "2026-11-27",
    });
    return { result, release: result.images[0].axes.release };
  }

  it.each([
    ["a date and time with no zone", "2026-11-27T20:59:50"],
    ["a date only", "2026-11-27"],
  ])("reports behind, not cooling, when the build time is %s", async (_label, rawTime) => {
    const { result, release } = await releaseFor(rawTime);

    expect(release.status).toBe("behind");
    expect(release.status).not.toBe("cooling");
    expect(release.latestVersion).toBe("0.34.0");
    expect(release.summary).toMatch(/build time could not be trusted/iu);
    expect(result.exitCode).toBe(1);
  });
});
