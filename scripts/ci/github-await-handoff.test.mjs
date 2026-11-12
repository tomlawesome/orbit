import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FAKE_TOKEN, FakeGithub, runScript, sha256 } from "../test-support/fake-github.mjs";
import { PROCESS_TEST_TIMEOUT_MS } from "../process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

/*
 * #1824: GitHub waits for the published release handoff-<commit> that GitLab
 * filled in the separate public handoff repository (GITHUB_HANDOFF_REPO), with
 * the run's read-only token. A draft is not there, a release without
 * handoff-complete.json is not there, every file is checked against that list
 * and the evidence against what this run knows. It only ever reads (GET) and
 * connects to nothing but GitHub's own API.
 */
const DECOY_REPOSITORY = "decoy-owner/orbit-itself";
const SCRIPT = new URL("./github-await-handoff.sh", import.meta.url).pathname;
const COMMIT = "c".repeat(40);
const REF = "preview";
const REGISTRY = "registry.example.com";
const DIGEST = `sha256:${"1".repeat(64)}`;
const TAG = `handoff-${COMMIT}`;

const IMAGE = "orbit-image.oci.tar";
const LAUNCHER = [
  "orbit-release-manifest.json",
  "orbit-release-manifest.json.sig",
  "orbit-launcher_linux_amd64.tar.gz",
  "orbit-launcher_linux_arm64.tar.gz",
];

const stamp = (date) => date.toISOString().replace(/\.\d+Z$/u, "Z");
const ago = (ms) => stamp(new Date(Date.now() - ms));
const DAY = 24 * 3600 * 1000;

function evidenceFor(overrides = {}) {
  return {
    commit: COMMIT,
    ref: REF,
    pipelineId: 284,
    imageDigest: DIGEST,
    imageReference: `${REGISTRY}/ai/orbit@${DIGEST}`,
    recordedAt: stamp(new Date()),
    ...overrides,
  };
}

function defaultFiles(evidence = evidenceFor(), sbom = { spdxVersion: "SPDX-2.3" }) {
  return {
    "gitlab-tested-image.json": Buffer.from(JSON.stringify(evidence)),
    "image.spdx.json": Buffer.from(JSON.stringify(sbom)),
    [IMAGE]: Buffer.from([9, 8, 7, 6, 0, 255]),
    "orbit-release-manifest.json": Buffer.from('{"manifest":1}'),
    "orbit-release-manifest.json.sig": Buffer.from("signature-bytes"),
    "orbit-launcher_linux_amd64.tar.gz": Buffer.from("amd64 archive"),
    "orbit-launcher_linux_arm64.tar.gz": Buffer.from("arm64 archive"),
  };
}

let fake;
beforeEach(async () => {
  fake = await new FakeGithub().start();
});
afterEach(async () => {
  await fake.stop();
});

/**
 * Puts a handoff on the fake. `listed` are the names handoff-complete.json
 * lists (default: all files); `absent` are listed files left off the release;
 * `lie` maps a name to a sha256 to list instead of the real one.
 */
function stage({
  files = defaultFiles(),
  listed = Object.keys(files),
  absent = [],
  lie = {},
  complete = true,
  completeCommit = COMMIT,
  tag = TAG,
  draft = false,
} = {}) {
  const release = fake.addRelease({ tag_name: tag, draft });
  for (const [name, content] of Object.entries(files)) {
    if (!absent.includes(name)) fake.addAsset(release, name, content);
  }
  const doc = {
    commit: completeCommit,
    pipelineUrl: "https://gitlab.example/ai/orbit/-/pipelines/284",
    assets: listed.map((name) => ({ name, sha256: lie[name] ?? sha256(files[name]), size: files[name].length })),
  };
  const addComplete = () => fake.addAsset(release, "handoff-complete.json", JSON.stringify(doc));
  if (complete) addComplete();
  return { release, addComplete, files };
}

async function run({ extra = {}, token = FAKE_TOKEN } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "handoff-await-"));
  const output = join(dir, "github-output");
  writeFileSync(output, "");
  const evidenceDir = join(dir, "evidence");
  const env = {
      GITHUB_API_URL: fake.apiUrl,
      GITHUB_HANDOFF_REPO: fake.repository,
      // Orbit's own repository: the handoff is never read from there.
      GITHUB_REPOSITORY: DECOY_REPOSITORY,
      GH_TOKEN: token,
      GITLAB_REGISTRY: REGISTRY,
      ORBIT_COMMIT: COMMIT,
      ORBIT_REF: REF,
      ORBIT_WAIT_MINUTES: "1",
      ORBIT_POLL_SECONDS: "0",
      ORBIT_EVIDENCE_DIR: evidenceDir,
      GITHUB_OUTPUT: output,
      ...extra,
  };
  for (const [key, value] of Object.entries(env)) if (value === null) delete env[key];
  const result = await runScript(SCRIPT, env, { cwd: dir });
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return { ...result, outputs, evidenceDir, rawOutput: readFileSync(output, "utf8") };
}

const downloaded = (name) => fake.requests.some((r) => r.path.includes("/dl/") && decodeURIComponent(r.path).endsWith(`/${name}`));
const listCalls = () => fake.requests.filter((r) => r.method === "GET" && /\/releases$/u.test(r.path)).length;

describe("github-await-handoff.sh, a good handoff", () => {
  it("fetches the evidence and SBOM and reports them, without the image or launcher files", async () => {
    const { files } = stage();
    const result = await run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.outputs.digest).toBe(DIGEST);
    expect(result.outputs.source_reference).toBe(`${REGISTRY}/ai/orbit@${DIGEST}`);
    expect(result.outputs.pipeline_url).toContain("/pipelines/284");
    expect(readFileSync(result.outputs.evidence).equals(files["gitlab-tested-image.json"])).toBe(true);
    expect(readFileSync(result.outputs.sbom).equals(files["image.spdx.json"])).toBe(true);
    expect(result.outputs.evidence.startsWith(result.evidenceDir)).toBe(true);
    for (const key of ["image_archive", "release_manifest", "release_manifest_sig", "launcher_amd64_archive", "launcher_arm64_archive"]) {
      expect(result.outputs, key).not.toHaveProperty(key);
    }
    for (const name of [IMAGE, ...LAUNCHER]) expect(downloaded(name), name).toBe(false);
  });

  it("also downloads the image archive when asked", async () => {
    const { files } = stage();
    const result = await run({ extra: { ORBIT_FETCH_IMAGE: "1" } });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(result.outputs.image_archive).equals(files[IMAGE])).toBe(true);
    expect(result.outputs).not.toHaveProperty("release_manifest");
  });

  it("also downloads the manifest, signature and both launcher archives when asked", async () => {
    const { files } = stage();
    const result = await run({ extra: { ORBIT_FETCH_LAUNCHER_ASSETS: "1" } });
    expect(result.status, result.stderr).toBe(0);
    const byOutput = {
      release_manifest: "orbit-release-manifest.json",
      release_manifest_sig: "orbit-release-manifest.json.sig",
      launcher_amd64_archive: "orbit-launcher_linux_amd64.tar.gz",
      launcher_arm64_archive: "orbit-launcher_linux_arm64.tar.gz",
    };
    for (const [key, name] of Object.entries(byOutput)) {
      expect(readFileSync(result.outputs[key]).equals(files[name]), key).toBe(true);
    }
    expect(result.outputs).not.toHaveProperty("image_archive");
    expect(downloaded(IMAGE)).toBe(false);
  });

  it("finds the right release among many other releases, past the first page", async () => {
    // The target is created first, so it is last in the list.
    stage();
    for (let i = 0; i < 40; i += 1) fake.addRelease({ tag_name: `handoff-${String(i).padStart(40, "0")}` });
    fake.addRelease({ tag_name: "v1.0.0", draft: false });
    const result = await run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.outputs.digest).toBe(DIGEST);
  });

  it("ignores a wrong sha256 or missing file for an asset it was not asked to fetch", async () => {
    const files = defaultFiles();
    stage({ files, lie: { [IMAGE]: "0".repeat(64), "orbit-release-manifest.json.sig": "0".repeat(64) }, absent: ["orbit-launcher_linux_arm64.tar.gz"] });
    const result = await run();
    expect(result.status, result.stderr).toBe(0);
  });

  it("uses the token only against the fake API, never prints it, and writes none of it to the outputs", async () => {
    stage();
    const result = await run({ extra: { ORBIT_FETCH_IMAGE: "1", ORBIT_FETCH_LAUNCHER_ASSETS: "1" } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr + result.rawOutput).not.toContain(FAKE_TOKEN);
    expect(fake.requests.filter((r) => r.path.startsWith("/api")).every((r) => r.authorized)).toBe(true);
  });

  it("reads only from the handoff repository and makes only GET requests", async () => {
    stage();
    const result = await run({ extra: { ORBIT_FETCH_IMAGE: "1", ORBIT_FETCH_LAUNCHER_ASSETS: "1" } });
    expect(result.status, result.stderr).toBe(0);
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.mutations()).toEqual([]);
    expect(fake.outsideRepository()).toEqual([]);
  });

  it("does not hold up on a handoff for another commit sitting beside it", async () => {
    stage({ tag: `handoff-${"d".repeat(40)}`, completeCommit: "d".repeat(40) });
    stage();
    const result = await run();
    expect(result.status, result.stderr).toBe(0);
  });
});

describe("github-await-handoff.sh, waiting", () => {
  it("does not see a draft release, even one with handoff-complete.json, and fails at the deadline", async () => {
    stage({ draft: true });
    const result = await run({ extra: { ORBIT_WAIT_MINUTES: "0" } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(TAG);
    expect(result.rawOutput).toBe("");
    expect(downloaded("gitlab-tested-image.json")).toBe(false);
    expect(fake.mutations()).toEqual([]);
  });

  it("keeps polling a draft until it is published", async () => {
    const { release } = stage({ draft: true });
    fake.onRequest = () => {
      if (release.draft && listCalls() >= 3) release.draft = false;
    };
    const result = await run();
    expect(result.status, result.stderr).toBe(0);
    expect(listCalls()).toBeGreaterThanOrEqual(3);
    expect(result.outputs.digest).toBe(DIGEST);
  });

  it("keeps polling a release without handoff-complete.json until it appears", async () => {
    const { addComplete } = stage({ complete: false });
    let added = false;
    fake.onRequest = () => {
      if (!added && listCalls() >= 3) {
        added = true;
        addComplete();
      }
    };
    const result = await run();
    expect(result.status, result.stderr).toBe(0);
    expect(listCalls()).toBeGreaterThanOrEqual(3);
    expect(result.outputs.digest).toBe(DIGEST);
  });

  it("keeps polling until the release itself appears", async () => {
    let staged = false;
    fake.onRequest = () => {
      if (!staged && listCalls() >= 2) {
        staged = true;
        stage();
      }
    };
    const result = await run();
    expect(result.status, result.stderr).toBe(0);
    expect(listCalls()).toBeGreaterThanOrEqual(2);
  });

  it("at the deadline, fails clearly when the release has no handoff-complete.json", async () => {
    stage({ complete: false });
    const result = await run({ extra: { ORBIT_WAIT_MINUTES: "0" } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("handoff-complete.json");
    expect(result.stderr).toContain(COMMIT);
    expect(result.rawOutput).toBe("");
  });

  it("at the deadline, fails clearly when there is no release at all", async () => {
    const result = await run({ extra: { ORBIT_WAIT_MINUTES: "0" } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(TAG);
    expect(result.rawOutput).toBe("");
  });

  it("refuses an unset GITHUB_HANDOFF_REPO before any request, even with GITHUB_REPOSITORY set", async () => {
    stage();
    const result = await run({ extra: { GITHUB_HANDOFF_REPO: null } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("GITHUB_HANDOFF_REPO");
    expect(fake.requests).toEqual([]);
    expect(result.rawOutput).toBe("");
  });

  it("rejects a wait or poll that is not a whole number", async () => {
    stage();
    for (const extra of [{ ORBIT_WAIT_MINUTES: "soon" }, { ORBIT_POLL_SECONDS: "-1" }]) {
      const result = await run({ extra });
      expect(result.status, JSON.stringify(extra)).not.toBe(0);
    }
  });
});

describe("github-await-handoff.sh, handoff refusals", () => {
  const fetchAll = { ORBIT_FETCH_IMAGE: "1", ORBIT_FETCH_LAUNCHER_ASSETS: "1" };

  it("refuses a handoff-complete.json that names another commit", async () => {
    stage({ completeCommit: "e".repeat(40) });
    const result = await run();
    expect(result.status).not.toBe(0);
    expect(result.rawOutput).toBe("");
  });

  for (const name of ["gitlab-tested-image.json", "image.spdx.json"]) {
    it(`refuses when ${name} is missing from the list`, async () => {
      const files = defaultFiles();
      stage({ files, listed: Object.keys(files).filter((n) => n !== name) });
      const result = await run();
      expect(result.status).not.toBe(0);
      expect(result.rawOutput).toBe("");
    });

    it(`refuses when ${name} is listed but not on the release`, async () => {
      stage({ absent: [name] });
      const result = await run();
      expect(result.status).not.toBe(0);
      expect(result.rawOutput).toBe("");
    });

    it(`refuses when the downloaded ${name} differs from its listed sha256`, async () => {
      stage({ lie: { [name]: "f".repeat(64) } });
      const result = await run();
      expect(result.status).not.toBe(0);
      expect(result.rawOutput).toBe("");
    });
  }

  it("refuses an image archive missing from the list, missing from the release, or altered, when it is wanted", async () => {
    const files = defaultFiles();
    for (const options of [
      { files, listed: Object.keys(files).filter((n) => n !== IMAGE) },
      { files, absent: [IMAGE] },
      { files, lie: { [IMAGE]: "a".repeat(64) } },
    ]) {
      const local = await new FakeGithub().start();
      const previous = fake;
      fake = local;
      try {
        stage(options);
        const result = await run({ extra: { ORBIT_FETCH_IMAGE: "1" } });
        expect(result.status, JSON.stringify(Object.keys(options))).not.toBe(0);
        expect(result.outputs).not.toHaveProperty("image_archive");
      } finally {
        fake = previous;
        await local.stop();
      }
    }
  });

  for (const name of LAUNCHER) {
    it(`refuses ${name} missing from the list, missing from the release, or altered, when launcher assets are wanted`, async () => {
      const files = defaultFiles();
      for (const options of [
        { files, listed: Object.keys(files).filter((n) => n !== name) },
        { files, absent: [name] },
        { files, lie: { [name]: "a".repeat(64) } },
      ]) {
        const local = await new FakeGithub().start();
        const previous = fake;
        fake = local;
        try {
          stage(options);
          const result = await run({ extra: { ORBIT_FETCH_LAUNCHER_ASSETS: "1" } });
          expect(result.status, `${name} ${Object.keys(options).join(",")}`).not.toBe(0);
          expect(result.rawOutput).toBe("");
        } finally {
          fake = previous;
          await local.stop();
        }
      }
    });
  }

  it("passes with every wanted asset present and correct (the neighbour of the refusals above)", async () => {
    stage();
    const result = await run({ extra: fetchAll });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(result.outputs.image_archive)).toBe(true);
  });
});

describe("github-await-handoff.sh, evidence checks", () => {
  const refuse = async (evidence, sbom) => {
    stage({ files: defaultFiles(evidence, sbom) });
    const result = await run();
    expect(result.status, JSON.stringify(evidence)).not.toBe(0);
    expect(result.rawOutput).toBe("");
  };

  it("refuses evidence for another commit", () => refuse(evidenceFor({ commit: "d".repeat(40) })));
  it("refuses evidence for another ref", () => refuse(evidenceFor({ ref: "hotfix/1.2.3" })));
  it("refuses evidence that is not a JSON object", () => refuse([evidenceFor()]));

  for (const [label, digest] of [
    ["too short", `sha256:${"1".repeat(63)}`],
    ["not hex", `sha256:${"g".repeat(64)}`],
    ["upper case", `sha256:${"A".repeat(64)}`],
    ["a tag", "latest"],
    ["no prefix", "1".repeat(64)],
  ]) {
    it(`refuses an image digest that is ${label}`, () =>
      refuse(evidenceFor({ imageDigest: digest, imageReference: `${REGISTRY}/ai/orbit@${digest}` })));
  }

  it("refuses an image reference in another registry", () =>
    refuse(evidenceFor({ imageReference: `elsewhere.example.com/ai/orbit@${DIGEST}` })));
  it("refuses an image reference that names another digest", () =>
    refuse(evidenceFor({ imageReference: `${REGISTRY}/ai/orbit@sha256:${"2".repeat(64)}` })));
  it("refuses an image reference that is a tag", () => refuse(evidenceFor({ imageReference: `${REGISTRY}/ai/orbit:preview` })));
  it("refuses evidence older than seven days", () => refuse(evidenceFor({ recordedAt: ago(8 * DAY) })));
  it("refuses evidence more than five minutes in the future", () => refuse(evidenceFor({ recordedAt: stamp(new Date(Date.now() + 10 * 60 * 1000)) })));
  it("refuses a timestamp that is not UTC", () => refuse(evidenceFor({ recordedAt: "2026-11-10T10:00:00+01:00" })));
  it("refuses a missing timestamp", () => {
    const evidence = evidenceFor();
    delete evidence.recordedAt;
    return refuse(evidence);
  });
  it("refuses an SBOM that is not an SPDX document", () => refuse(evidenceFor(), { packages: [] }));

  it("accepts evidence six days old and one a minute ahead (the neighbours of the age limits)", async () => {
    for (const recordedAt of [ago(6 * DAY), stamp(new Date(Date.now() + 60 * 1000))]) {
      const local = await new FakeGithub().start();
      const previous = fake;
      fake = local;
      try {
        stage({ files: defaultFiles(evidenceFor({ recordedAt })) });
        const result = await run();
        expect(result.status, `${recordedAt}: ${result.stderr}`).toBe(0);
      } finally {
        fake = previous;
        await local.stop();
      }
    }
  });
});
