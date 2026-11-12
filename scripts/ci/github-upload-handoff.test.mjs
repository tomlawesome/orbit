import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FAKE_TOKEN, FakeGithub, runScript, sha256 } from "../test-support/fake-github.mjs";
import { PROCESS_TEST_TIMEOUT_MS } from "../process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

/*
 * #1824: GitLab hands the tested image and release files to a draft GitHub
 * release named handoff-<commit>; GitHub's workflows read from it and never
 * connect to GitLab. A handoff counts as ready only once handoff-complete.json,
 * uploaded last, lists every other asset with its sha256.
 */
const SCRIPT = new URL("./github-upload-handoff.sh", import.meta.url).pathname;
const COMMIT = "a".repeat(39) + "b";
const TAG = `handoff-${COMMIT}`;
const PIPELINE_URL = "https://gitlab.example/ai/orbit/-/pipelines/1";

// Names chosen so that sorted order puts handoff-complete.json FIRST: a script
// that happened to upload in alphabetical order would fail the "last" checks.
const FILES = {
  "orbit-image.oci.tar": Buffer.from([0, 1, 2, 3, 250, 251, 252, 253]),
  "orbit-release-manifest.json": Buffer.from('{"manifest":true}\n'),
  "zeta.txt": Buffer.from("zeta\n"),
};

let fake;
beforeEach(async () => {
  fake = await new FakeGithub().start();
});
afterEach(async () => {
  await fake.stop();
});

function makeDir(files = FILES) {
  const dir = mkdtempSync(join(tmpdir(), "handoff-dir-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

function upload({ dir = makeDir(), commit = COMMIT, token = FAKE_TOKEN, extra = {} } = {}) {
  const env = {
    GITHUB_API_URL: fake.apiUrl,
    GITHUB_UPLOADS_URL: fake.uploadsUrl,
    GITHUB_REPOSITORY: fake.repository,
    ORBIT_COMMIT: commit,
    ORBIT_PIPELINE_URL: PIPELINE_URL,
    ORBIT_HANDOFF_DIR: dir,
    ...extra,
  };
  if (token !== undefined) env.GITHUB_HANDOFF_TOKEN = token;
  return runScript(SCRIPT, env);
}

const noMutation = () => expect(fake.mutations()).toEqual([]);

describe("github-upload-handoff.sh", () => {
  it("creates one draft named for the commit and uploads every file, then handoff-complete.json last", async () => {
    const result = await upload();
    expect(result.status, result.stderr).toBe(0);

    const drafts = fake.draftsFor(TAG);
    expect(drafts).toHaveLength(1);
    expect(fake.releases).toHaveLength(1);
    const [release] = drafts;
    expect(release.draft).toBe(true);

    const names = fake.uploads.map((u) => u.name);
    expect(names.at(-1)).toBe("handoff-complete.json");
    expect([...names].sort()).toEqual([...Object.keys(FILES), "handoff-complete.json"].sort());
    for (const [name, content] of Object.entries(FILES)) {
      expect(release.assets.find((a) => a.name === name).content.equals(content), name).toBe(true);
    }
  });

  it("writes handoff-complete.json with the commit, pipeline and every other asset's name, sha256 and size", async () => {
    const result = await upload();
    expect(result.status, result.stderr).toBe(0);
    const complete = fake.uploads.find((u) => u.name === "handoff-complete.json");
    const doc = JSON.parse(complete.body.toString("utf8"));
    expect(doc.commit).toBe(COMMIT);
    expect(doc.pipelineUrl).toBe(PIPELINE_URL);
    expect(doc.assets.map((a) => a.name).sort()).toEqual(Object.keys(FILES).sort());
    for (const asset of doc.assets) {
      expect(asset.sha256).toBe(sha256(FILES[asset.name]));
      expect(asset.size).toBe(FILES[asset.name].length);
    }
  });

  it("ignores a subdirectory and a symlink: only regular files are assets", async () => {
    const dir = makeDir();
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "inner.txt"), "inner");
    symlinkSync(join(dir, "zeta.txt"), join(dir, "link.txt"));
    const result = await upload({ dir });
    expect(result.status, result.stderr).toBe(0);
    expect(fake.uploads.map((u) => u.name).sort()).toEqual([...Object.keys(FILES), "handoff-complete.json"].sort());
  });

  it("run twice for the same commit leaves one draft with the second run's files", async () => {
    expect((await upload()).status).toBe(0);
    const changed = { ...FILES, "zeta.txt": Buffer.from("zeta changed, and longer\n") };
    const second = await upload({ dir: makeDir(changed) });
    expect(second.status, second.stderr).toBe(0);

    expect(fake.releases).toHaveLength(1);
    const [release] = fake.draftsFor(TAG);
    const names = release.assets.map((a) => a.name).sort();
    expect(names).toEqual([...Object.keys(FILES), "handoff-complete.json"].sort());
    expect(release.assets.find((a) => a.name === "zeta.txt").content.toString()).toBe("zeta changed, and longer\n");
    const doc = JSON.parse(release.assets.find((a) => a.name === "handoff-complete.json").content.toString());
    expect(doc.assets.find((a) => a.name === "zeta.txt").sha256).toBe(sha256(changed["zeta.txt"]));
    // Still last within the second run.
    expect(fake.uploads.at(-1).name).toBe("handoff-complete.json");
  });

  it("finds its draft past the first page of releases, rather than making a second", async () => {
    // The target is the oldest of 40, so it is on page two of 30.
    fake.addRelease({ tag_name: TAG, draft: true });
    for (let i = 0; i < 40; i += 1) fake.addRelease({ tag_name: `handoff-${String(i).padStart(40, "0")}` });
    const before = fake.releases.length;
    const result = await upload();
    expect(result.status, result.stderr).toBe(0);
    expect(fake.releases).toHaveLength(before);
    expect(fake.draftsFor(TAG)[0].assets.map((a) => a.name)).toContain("handoff-complete.json");
  });

  it("leaves other commits' drafts alone", async () => {
    const other = fake.addRelease({ tag_name: `handoff-${"d".repeat(40)}`, assets: [{ name: "x.txt", content: "x" }] });
    const result = await upload();
    expect(result.status, result.stderr).toBe(0);
    expect(other.assets.map((a) => a.name)).toEqual(["x.txt"]);
    expect(fake.releases).toHaveLength(2);
  });

  it("only sends the token to the API and uploads hosts, and never prints it", async () => {
    const result = await upload();
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(FAKE_TOKEN);
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.requests.every((r) => r.authorized)).toBe(true);
  });

  describe("failures", () => {
    it("a failed upload exits non-zero, never uploads handoff-complete.json, and does not print the token", async () => {
      fake.failWhen = (r) => (r.assetName === "orbit-release-manifest.json" ? 500 : undefined);
      const result = await upload();
      expect(result.status).not.toBe(0);
      expect(fake.uploads.map((u) => u.name)).not.toContain("handoff-complete.json");
      expect(fake.requests.some((r) => r.assetName === "handoff-complete.json")).toBe(false);
      expect(result.stdout + result.stderr).not.toContain(FAKE_TOKEN);
    });

    it("a failed upload of the last real file still leaves out handoff-complete.json", async () => {
      fake.failWhen = (r) => (r.assetName === "zeta.txt" ? 503 : undefined);
      const result = await upload();
      expect(result.status).not.toBe(0);
      expect(fake.requests.some((r) => r.assetName === "handoff-complete.json")).toBe(false);
    });

    it("a failed release lookup exits non-zero and changes nothing", async () => {
      fake.failWhen = (r) => (r.method === "GET" ? 500 : undefined);
      const result = await upload();
      expect(result.status).not.toBe(0);
      expect(fake.uploads).toEqual([]);
    });

    it("a failed draft creation exits non-zero and uploads nothing", async () => {
      fake.failWhen = (r) => (r.method === "POST" && r.path.endsWith("/releases") ? 500 : undefined);
      const result = await upload();
      expect(result.status).not.toBe(0);
      expect(fake.uploads).toEqual([]);
    });

    it("a rejected token exits non-zero without printing it", async () => {
      const result = await upload({ token: "wrong-fake-token-for-tests" });
      expect(result.status).not.toBe(0);
      expect(fake.uploads).toEqual([]);
      expect(result.stdout + result.stderr).not.toContain("wrong-fake-token-for-tests");
    });
  });

  describe("refusals", () => {
    for (const bad of ["abc123", "A".repeat(40), "g".repeat(40), "a".repeat(41), `${"a".repeat(39)} `, ""]) {
      it(`refuses the commit ${JSON.stringify(bad)} before any request`, async () => {
        const result = await upload({ commit: bad });
        expect(result.status).not.toBe(0);
        expect(fake.requests).toEqual([]);
      });
    }

    it("refuses an empty directory before any request", async () => {
      const result = await upload({ dir: makeDir({}) });
      expect(result.status).not.toBe(0);
      expect(fake.requests).toEqual([]);
    });

    it("refuses a directory holding only subdirectories", async () => {
      const dir = makeDir({});
      mkdirSync(join(dir, "nested"));
      writeFileSync(join(dir, "nested", "inner.txt"), "inner");
      const result = await upload({ dir });
      expect(result.status).not.toBe(0);
      expect(fake.uploads).toEqual([]);
    });

    it("refuses a missing token", async () => {
      const result = await upload({ token: undefined });
      expect(result.status).not.toBe(0);
      expect(fake.requests).toEqual([]);
    });

    it("refuses to touch a published release with the handoff tag", async () => {
      const published = fake.addRelease({ tag_name: TAG, draft: false, assets: [{ name: "keep.txt", content: "keep" }] });
      const result = await upload();
      expect(result.status).not.toBe(0);
      noMutation();
      expect(published.assets.map((a) => a.name)).toEqual(["keep.txt"]);
    });

    it("a published release for another commit does not stop a good handoff", async () => {
      fake.addRelease({ tag_name: `handoff-${"e".repeat(40)}`, draft: false });
      const result = await upload();
      expect(result.status, result.stderr).toBe(0);
      expect(fake.draftsFor(TAG)).toHaveLength(1);
    });
  });
});
