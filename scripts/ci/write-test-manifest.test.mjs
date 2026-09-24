/**
 * scripts/ci/write-test-manifest.sh (#1107): writes an ADR-0031 #1-shaped
 * release manifest for a locally built, unpublished image, so a CI harness
 * can hand install.sh an already-verified manifest via ORBIT_RELEASE_MANIFEST
 * instead of install.sh self-fetching one that does not exist yet (pipeline
 * 1626's "Could not download the release manifest for channel latest").
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../process-budget.mjs";

const script = new URL("./write-test-manifest.sh", import.meta.url).pathname;

const VALID_DIGEST = `sha256:${"a".repeat(64)}`;

function run(args) {
  return failOnProcessDeadline(
    spawnSync("bash", [script, ...args], { encoding: "utf8", ...processGuard() }),
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
});
