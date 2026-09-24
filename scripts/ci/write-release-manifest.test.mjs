import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/*
 * scripts/ci/write-release-manifest.sh (ADR-0031 #1, implementation slice
 * 3). Its likeliest failure is a malformed field reaching the manifest a
 * user's get-orbit.sh trusts, so this pins the shape checks the way
 * scripts/ci/gitlab-record-tested-image.sh's own inline validation is pinned
 * by its callers: every field is refused before it is written, never
 * sanitised. The launcher archives and get-orbit.sh are fixture files here --
 * real ones come from later ADR-0031 slices (build_launcher, get-orbit.sh)
 * this script does not depend on directly.
 */
const script = new URL("./write-release-manifest.sh", import.meta.url).pathname;

const DIGEST = `sha256:${"1".repeat(64)}`;
const COMMIT = "a".repeat(40);
const LAUNCHER_COMMIT = "b".repeat(40);

const directories = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop(), { recursive: true, force: true });
});

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** A workspace with fixture files standing in for the not-yet-built inputs. */
function workspace({
  amd64 = "amd64 archive bytes",
  arm64 = "arm64 archive bytes",
  install = "install.sh bytes",
  getOrbit = "get-orbit.sh bytes",
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "write-release-manifest-"));
  directories.push(dir);
  const files = {
    amd64Archive: join(dir, "orbit-launcher_linux_amd64.tar.gz"),
    arm64Archive: join(dir, "orbit-launcher_linux_arm64.tar.gz"),
    installScript: join(dir, "install.sh"),
    getOrbitScript: join(dir, "get-orbit.sh"),
  };
  writeFileSync(files.amd64Archive, amd64);
  writeFileSync(files.arm64Archive, arm64);
  writeFileSync(files.installScript, install);
  writeFileSync(files.getOrbitScript, getOrbit);
  return { dir, files };
}

function run({ dir, files, args = ["registry.example/ai/orbit", DIGEST], env = {}, dropEnv = [] }) {
  const outputDir = join(dir, "out");
  const fullEnv = {
    PATH: process.env.PATH,
    CI_COMMIT_SHA: COMMIT,
    ORBIT_VERSION: "1.4.0",
    ORBIT_CHANNEL: "preview",
    ORBIT_LAUNCHER_TAG: "v1.2.3",
    ORBIT_LAUNCHER_COMMIT: LAUNCHER_COMMIT,
    ORBIT_LAUNCHER_AMD64_ARCHIVE: files.amd64Archive,
    ORBIT_LAUNCHER_ARM64_ARCHIVE: files.arm64Archive,
    ORBIT_INSTALL_SCRIPT: files.installScript,
    ORBIT_GET_ORBIT_SCRIPT: files.getOrbitScript,
    // Isolate the manifest under the workspace rather than the real repo
    // root: the script always writes to <repoRoot>/.orbit-supply-chain, so
    // the test reads it back from there via ORBIT_REPO_ROOT_OVERRIDE is not
    // needed -- instead it just runs the script with cwd = the real repo and
    // reads the real output path, cleaning it up after.
    ...env,
  };
  for (const name of dropEnv) delete fullEnv[name];
  return execFileSync("bash", [script, ...args], { encoding: "utf8", env: fullEnv });
}

const repoRoot = new URL("../..", import.meta.url).pathname;
const manifestPath = join(repoRoot, ".orbit-supply-chain", "orbit-release-manifest.json");

afterEach(() => {
  rmSync(manifestPath, { force: true });
});

describe("write-release-manifest.sh", () => {
  it("writes the manifest with the exact schema fields, hashing the real fixture bytes", () => {
    const { dir, files } = workspace();
    const stdout = run({ dir, files });
    expect(stdout).toContain(".orbit-supply-chain/orbit-release-manifest.json");

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      schema: "https://tomlawson.io/schemas/orbit-release-manifest/v1",
      version: "1.4.0",
      channel: "preview",
      commit: COMMIT,
      image: { repository: "registry.example/ai/orbit", digest: DIGEST },
      launcher: { tag: "v1.2.3", commit: LAUNCHER_COMMIT },
      files: {
        "orbit-launcher_linux_amd64.tar.gz": `sha256:${sha256("amd64 archive bytes")}`,
        "orbit-launcher_linux_arm64.tar.gz": `sha256:${sha256("arm64 archive bytes")}`,
        "install.sh": `sha256:${sha256("install.sh bytes")}`,
        "get-orbit.sh": `sha256:${sha256("get-orbit.sh bytes")}`,
      },
    });
    expect(manifest.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
  });

  it("changes the file hash when the archive content changes", () => {
    const { dir, files } = workspace({ amd64: "different bytes" });
    run({ dir, files });
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.files["orbit-launcher_linux_amd64.tar.gz"]).toBe(`sha256:${sha256("different bytes")}`);
  });

  it("refuses a missing image repository or digest argument", () => {
    const { dir, files } = workspace();
    expect(() => run({ dir, files, args: [] })).toThrow(/image repository is required/);
    expect(() => run({ dir, files, args: ["registry.example/ai/orbit"] })).toThrow(/image digest is required/);
  });

  it("refuses a non-hex or wrong-length image digest", () => {
    const { dir, files } = workspace();
    expect(() => run({ dir, files, args: ["registry.example/ai/orbit", "sha256:not-hex"] })).toThrow(
      /not an immutable manifest digest/,
    );
    expect(() => run({ dir, files, args: ["registry.example/ai/orbit", `sha256:${"1".repeat(63)}`] })).toThrow(
      /not an immutable manifest digest/,
    );
  });

  it("refuses an image repository that is not a plain registry reference", () => {
    const { dir, files } = workspace();
    expect(() => run({ dir, files, args: ["not a repository!", DIGEST] })).toThrow(
      /not a plain registry reference/,
    );
  });

  it("refuses a missing or malformed ORBIT_VERSION", () => {
    const { dir, files } = workspace();
    expect(() => run({ dir, files, dropEnv: ["ORBIT_VERSION"] })).toThrow(/ORBIT_VERSION is not set/);
    expect(() => run({ dir, files, env: { ORBIT_VERSION: "v1" } })).toThrow(
      /not a plain semantic version/,
    );
  });

  it("refuses a missing or malformed ORBIT_CHANNEL", () => {
    const { dir, files } = workspace();
    expect(() => run({ dir, files, dropEnv: ["ORBIT_CHANNEL"] })).toThrow(/ORBIT_CHANNEL is not set/);
    expect(() => run({ dir, files, env: { ORBIT_CHANNEL: "preview/../x" } })).toThrow(
      /not a plain channel name/,
    );
  });

  it("refuses a missing or malformed launcher pin", () => {
    const { dir, files } = workspace();
    expect(() => run({ dir, files, dropEnv: ["ORBIT_LAUNCHER_TAG"] })).toThrow(/ORBIT_LAUNCHER_TAG is not set/);
    expect(() => run({ dir, files, env: { ORBIT_LAUNCHER_TAG: "1.2.3" } })).toThrow(
      /not a plain vX\.Y\.Z tag/,
    );
    expect(() => run({ dir, files, dropEnv: ["ORBIT_LAUNCHER_COMMIT"] })).toThrow(
      /ORBIT_LAUNCHER_COMMIT is not set/,
    );
    expect(() => run({ dir, files, env: { ORBIT_LAUNCHER_COMMIT: "short" } })).toThrow(
      /not an exact commit SHA/,
    );
  });

  it("refuses a CI_COMMIT_SHA that is not an exact commit SHA", () => {
    const { dir, files } = workspace();
    expect(() => run({ dir, files, env: { CI_COMMIT_SHA: "short" } })).toThrow(/not an exact commit SHA/);
  });

  it("refuses missing launcher archives, naming which input slice 2 must supply", () => {
    const { dir, files } = workspace();
    expect(() =>
      run({ dir, files, env: { ORBIT_LAUNCHER_AMD64_ARCHIVE: join(dir, "missing.tar.gz") } }),
    ).toThrow(/ORBIT_LAUNCHER_AMD64_ARCHIVE does not point at a readable file/);
    expect(() =>
      run({ dir, files, env: { ORBIT_LAUNCHER_ARM64_ARCHIVE: join(dir, "missing.tar.gz") } }),
    ).toThrow(/ORBIT_LAUNCHER_ARM64_ARCHIVE does not point at a readable file/);
  });

  it("refuses a missing install.sh or get-orbit.sh", () => {
    const { dir, files } = workspace();
    expect(() =>
      run({ dir, files, env: { ORBIT_INSTALL_SCRIPT: join(dir, "missing.sh") } }),
    ).toThrow(/install script is not a readable file/);
    expect(() =>
      run({ dir, files, env: { ORBIT_GET_ORBIT_SCRIPT: join(dir, "missing.sh") } }),
    ).toThrow(/get-orbit script is not a readable file/);
  });
});
