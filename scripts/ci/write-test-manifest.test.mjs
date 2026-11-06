/**
 * scripts/ci/write-test-manifest.sh (#1107): writes an ADR-0031 #1-shaped
 * release manifest for a locally built, unpublished image, so a CI harness
 * can hand install.sh an already-verified manifest via ORBIT_RELEASE_MANIFEST
 * instead of install.sh self-fetching one that does not exist yet (pipeline
 * 1626's "Could not download the release manifest for channel latest").
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { failOnProcessDeadline, processGuard } from "../process-budget.mjs";
import { digest as installDigest, eventLines, imageRepository, makePreprovisionedDeployment, makeTarget, runInstall } from "../install-test-support.mjs";

const script = new URL("./write-test-manifest.sh", import.meta.url).pathname;

const VALID_DIGEST = `sha256:${"a".repeat(64)}`;

// Name chosen by the tests (the spec leaves it to the builder): extra releases
// an update may start from, space or comma separated.
const EXTRA = "ORBIT_TEST_MANIFEST_UPDATE_FROM";

function run(args, env = {}) {
  return failOnProcessDeadline(
    spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, ...env }, ...processGuard() }),
    { label: "write-test-manifest" },
  );
}

describe("write-test-manifest.sh", () => {
  it("writes a manifest with the given repository and digest, schema-shaped like write-release-manifest.sh's output", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "write-test-manifest-"));
    const output = join(outputDir, "orbit-release-manifest.json");

    const result = run([output, "127.0.0.1:5000/tomlawesome/orbit", VALID_DIGEST]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(output);

    const manifest = JSON.parse(readFileSync(output, "utf8"));
    expect(manifest.schema).toBe("https://tomlawson.io/schemas/orbit-release-manifest/v1");
    expect(manifest.image).toEqual({
      repository: "127.0.0.1:5000/tomlawesome/orbit",
      digest: VALID_DIGEST,
    });
    // Every other field is schema-valid, fixed placeholder content: install.sh
    // (handed the manifest directly via ORBIT_RELEASE_MANIFEST) reads only
    // "digest", so nothing else has to be real for these harnesses.
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.launcher.tag).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(manifest.launcher.commit).toMatch(/^[0-9a-f]{40}$/);
    for (const fileDigest of Object.values(manifest.files)) {
      expect(fileDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(manifest.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("carries updateFrom and releases, so install.sh's update path accepts it (#1667)", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "write-test-manifest-"));
    const output = join(outputDir, "orbit-release-manifest.json");

    expect(run([output, "127.0.0.1:5000/tomlawesome/orbit", VALID_DIGEST]).status).toBe(0);

    const manifest = JSON.parse(readFileSync(output, "utf8"));
    for (const list of [manifest.updateFrom, manifest.releases]) {
      expect(Array.isArray(list)).toBe(true);
      for (const entry of list) expect(entry).toMatch(/^v\d+\.\d+\.\d+$/);
    }
    expect(manifest.releases.slice(0, manifest.updateFrom.length)).toEqual(manifest.updateFrom);
  });

  describe("ORBIT_TEST_MANIFEST_VERSION (#1749)", () => {
    const manifestVersion = (env) => {
      const output = join(mkdtempSync(join(tmpdir(), "write-test-manifest-")), "m.json");
      const result = run([output, "127.0.0.1:5000/tomlawesome/orbit", VALID_DIGEST], env);
      return { result, output };
    };

    it("writes the given release version as the manifest version", () => {
      const { result, output } = manifestVersion({ ORBIT_TEST_MANIFEST_VERSION: "v0.3.7" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8")).version).toBe("v0.3.7");
    });

    it("accepts a pre-release version", () => {
      const { result, output } = manifestVersion({ ORBIT_TEST_MANIFEST_VERSION: "v0.3.7-rc.1" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8")).version).toBe("v0.3.7-rc.1");
    });

    for (const [label, value] of [["unset", undefined], ["empty", ""]]) {
      it(`writes 0.0.0-ci-test when the variable is ${label}`, () => {
        const { result, output } = manifestVersion({ ORBIT_TEST_MANIFEST_VERSION: value });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(readFileSync(output, "utf8")).version).toBe("0.0.0-ci-test");
      });
    }

    for (const bad of ["0.3.7", "latest", "v1.2", 'v0.3.7","x":"y']) {
      it(`refuses ${JSON.stringify(bad)} and writes no manifest`, () => {
        const { result, output } = manifestVersion({ ORBIT_TEST_MANIFEST_VERSION: bad });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("ORBIT_TEST_MANIFEST_VERSION");
        expect(existsSync(output)).toBe(false);
      });
    }
  });

  it("creates the output directory if it does not exist yet", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "write-test-manifest-"));
    const output = join(outputDir, "nested", "orbit-release-manifest.json");

    const result = run([output, "127.0.0.1:5000/tomlawesome/orbit", VALID_DIGEST]);

    expect(result.status).toBe(0);
    expect(() => readFileSync(output, "utf8")).not.toThrow();
  });

  it("refuses a digest that is not an immutable sha256 manifest digest", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "write-test-manifest-"));
    const output = join(outputDir, "orbit-release-manifest.json");

    const result = run([output, "127.0.0.1:5000/tomlawesome/orbit", "latest"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not an immutable manifest digest");
  });

  it("refuses a repository that is not a plain registry reference", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "write-test-manifest-"));
    const output = join(outputDir, "orbit-release-manifest.json");

    const result = run([output, "not a repository", VALID_DIGEST]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not a plain registry reference");
  });

  it("refuses missing arguments, naming which one", () => {
    expect(run([]).stderr).toContain("an output path is required");
    expect(run(["/tmp/x.json"]).stderr).toContain("an image repository is required");
    expect(run(["/tmp/x.json", "127.0.0.1:5000/tomlawesome/orbit"]).stderr).toContain(
      "an image digest is required",
    );
  });

  it("lists an extra update-from version in updateFrom and releases, keeping v0.0.0 (#1665)", () => {
    const output = join(mkdtempSync(join(tmpdir(), "write-test-manifest-")), "m.json");
    const result = run([output, "127.0.0.1:5000/tomlawesome/orbit", VALID_DIGEST], { [EXTRA]: "v0.3.5" });
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(output, "utf8"));
    expect(manifest.updateFrom).toContain("v0.3.5");
    expect(manifest.updateFrom).toContain("v0.0.0");
    expect(manifest.releases).toContain("v0.3.5");
    expect(manifest.releases).toContain("v0.0.0");
    expect(manifest.releases.slice(0, manifest.updateFrom.length)).toEqual(manifest.updateFrom);
  });

  it("refuses an extra update-from version that is not a release version (#1665)", () => {
    const output = join(mkdtempSync(join(tmpdir(), "write-test-manifest-")), "m.json");
    const result = run([output, "127.0.0.1:5000/tomlawesome/orbit", VALID_DIGEST], { [EXTRA]: "latest" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("write-test-manifest:");
  });
});

describe("install.sh's update-path check against a write-test-manifest.sh manifest (#1665)", () => {
  function update(installed, env) {
    const output = join(mkdtempSync(join(tmpdir(), "write-test-manifest-")), "m.json");
    const written = run([output, imageRepository, `sha256:${installDigest}`], env);
    expect(written.status, written.stderr).toBe(0);
    const dir = makeTarget();
    makePreprovisionedDeployment(dir, [
      `ORBIT_IMAGE=${imageRepository}@sha256:${"c".repeat(64)}`,
      `ORBIT_CONFIG_APPLIED_DIGEST=sha256:${"c".repeat(64)}`,
      `ORBIT_CONFIG_APPLIED_VERSION=${installed}`,
    ]);
    return runInstall(dir, { ORBIT_RELEASE_MANIFEST: output }, ["--plain", "--update"]);
  }

  it("accepts an update from v0.3.5 when that version is passed", () => {
    const result = update("v0.3.5", { [EXTRA]: "v0.3.5" });
    expect(result.stdout).not.toContain("reason=update-path");
    expect(result.stderr).not.toContain("This install is on");
    expect(/^docker pull /mu.test(result.calls)).toBe(true);
  });

  it("refuses an update from v0.3.5 when it is not passed", () => {
    const result = update("v0.3.5", {});
    expect(result.status).not.toBe(0);
    expect(eventLines(result.stdout).some((e) => e.includes("reason=update-path"))).toBe(true);
    expect(/^docker pull /mu.test(result.calls)).toBe(false);
  });
});
