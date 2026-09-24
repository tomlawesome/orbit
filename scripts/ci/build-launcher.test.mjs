/**
 * scripts/ci/build-launcher.sh (ADR-0031 #3, implementation slice 2): clones
 * the pinned launcher source, refuses unless the tag resolves to
 * launcher/pin.json's commit, and builds both platform archives.
 *
 * Exercised against a tiny fixture Go module in a local git repository
 * (standing in for the GitHub mirror, never the network) and a stubbed `go`
 * on PATH, the same shape sign-release-manifest.test.mjs uses to stub
 * cosign: the point is proving build-launcher.sh resolves and refuses
 * correctly and wires the right flags and archive layout, not re-proving
 * that `go build` itself works.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./build-launcher.sh", import.meta.url).pathname;

const GO_STUB = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  "printf 'go\\x1f%s\\x1e' \"$*\" >> \"$STUB_LOG\"",
  'case "${1:-}" in',
  "  env)",
  '    if [ "${2:-}" = "GOVERSION" ]; then',
  '      printf \'%s\\n\' "${STUB_GO_VERSION:-go1.27.1}"',
  "      exit 0",
  "    fi",
  '    echo "go stub: unsupported env request: ${2:-}" >&2',
  "    exit 1",
  "    ;;",
  "  build)",
  "    shift",
  '    output=""',
  '    while [ "$#" -gt 0 ]; do',
  '      case "$1" in',
  '        -o) output="$2"; shift 2 ;;',
  '        -ldflags) shift 2 ;;',
  '        -trimpath) shift ;;',
  '        ./*) shift ;;',
  '        *) shift ;;',
  "      esac",
  "    done",
  '    [ -n "$output" ] || { echo "go stub: no -o given" >&2; exit 1; }',
  '    if [ -n "${STUB_GO_BUILD_EXIT:-}" ] && [ "${STUB_GO_BUILD_EXIT}" != "0" ]; then',
  '      exit "$STUB_GO_BUILD_EXIT"',
  "    fi",
  '    printf \'#!/bin/sh\\necho stub-orbit-launcher %s %s\\n\' "${GOOS:-?}" "${GOARCH:-?}" > "$output"',
  '    chmod +x "$output"',
  "    exit 0",
  "    ;;",
  '  *) echo "go stub: unknown subcommand ${1:-}" >&2; exit 1 ;;',
  "esac",
  "",
].join("\n");

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${result.stderr}`);
  }
  return result.stdout;
}

const MODULE = "github.com/tomlawesome/orbit-launcher-fixture";

/**
 * A minimal Go module shaped like orbit-launcher's own layout: a go.mod
 * naming a Go version and module path, an internal/release package with the
 * Version/Revision vars build-launcher.sh's ldflags target, and a
 * cmd/orbit-launcher main package. Committed and tagged v0.1.0 (lightweight,
 * like the real pin), standing in for the GitHub mirror build-launcher.sh
 * clones.
 */
function deployLauncherRemote({ goVersion = "1.27.1" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "orbit-launcher-fixture-"));
  runGit(dir, ["init", "--quiet", "--initial-branch=dev"]);
  runGit(dir, ["config", "user.email", "test@example.invalid"]);
  runGit(dir, ["config", "user.name", "Test"]);

  writeFileSync(join(dir, "go.mod"), `module ${MODULE}\n\ngo ${goVersion}\n`);
  mkdirSync(join(dir, "internal", "release"), { recursive: true });
  writeFileSync(
    join(dir, "internal", "release", "doc.go"),
    'package release\n\nvar (\n\tVersion  = "dev"\n\tRevision = "unknown"\n)\n',
  );
  mkdirSync(join(dir, "cmd", "orbit-launcher"), { recursive: true });
  writeFileSync(
    join(dir, "cmd", "orbit-launcher", "main.go"),
    `package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("orbit-launcher") }\n`,
  );

  runGit(dir, ["add", "-A"]);
  runGit(dir, ["commit", "--quiet", "-m", "v0.1.0"]);
  runGit(dir, ["tag", "v0.1.0"]);
  const commit = runGit(dir, ["rev-parse", "HEAD"]).trim();

  return { dir, commit };
}

function writePinFile(dir, { tag = "v0.1.0", commit }) {
  const path = join(dir, "pin.json");
  writeFileSync(path, JSON.stringify({ tag, commit }));
  return path;
}

/**
 * process.env.PATH with every directory that holds a `node` executable
 * removed -- the golang job image build_launcher actually runs in has no
 * node on PATH at all (#1107 pipeline 1626), so this is what proves
 * build-launcher.sh's pin-reading no longer needs it.
 */
function pathWithoutNode() {
  return (process.env.PATH ?? "")
    .split(":")
    .filter((dir) => dir && !existsSync(join(dir, "node")))
    .join(":");
}

function runBuild({ outputDir, pinFile, remote, goVersion, goBuildExit, path } = {}) {
  const stubDir = mkdtempSync(join(tmpdir(), "go-stub-"));
  const goStub = join(stubDir, "go");
  writeFileSync(goStub, GO_STUB);
  chmodSync(goStub, 0o755);
  const logFile = join(stubDir, "calls.log");
  writeFileSync(logFile, "");

  const env = {
    PATH: `${stubDir}:${path ?? process.env.PATH}`,
    HOME: process.env.HOME ?? tmpdir(),
    ORBIT_GO: goStub,
    ORBIT_LAUNCHER_REMOTE: remote,
    ORBIT_LAUNCHER_PIN_FILE: pinFile,
    STUB_LOG: logFile,
    ...(goVersion ? { STUB_GO_VERSION: `go${goVersion}` } : {}),
    ...(goBuildExit !== undefined ? { STUB_GO_BUILD_EXIT: String(goBuildExit) } : {}),
  };

  const result = failOnProcessDeadline(
    spawnSync("bash", [script, ...(outputDir !== undefined ? [outputDir] : [])], {
      encoding: "utf8",
      env,
      ...processGuard(),
    }),
    { label: "build-launcher" },
  );
  const calls = () =>
    readFileSync(logFile, "utf8")
      .split("\x1e")
      .filter(Boolean)
      .map((call) => call.split("\x1f").filter(Boolean));
  return { result, calls };
}

describe("build-launcher.sh", () => {
  it("builds both archives with the pinned version ldflags and the exact layout", () => {
    const { dir: remote, commit } = deployLauncherRemote();
    const pinFile = writePinFile(remote, { commit });
    const outputDir = mkdtempSync(join(tmpdir(), "build-launcher-out-"));

    const { result, calls } = runBuild({ outputDir, pinFile, remote });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const buildCalls = calls().filter((call) => call[1]?.startsWith("build "));
    expect(buildCalls).toHaveLength(2);
    for (const call of buildCalls) {
      expect(call[1]).toContain("-trimpath");
      expect(call[1]).toContain(
        `-ldflags -s -w -buildid= -X ${MODULE}/internal/release.Version=v0.1.0 -X ${MODULE}/internal/release.Revision=${commit}`,
      );
    }

    for (const arch of ["amd64", "arm64"]) {
      const archive = join(outputDir, `orbit-launcher_linux_${arch}.tar.gz`);
      const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
      expect(listing.status).toBe(0);
      expect(listing.stdout.trim().split("\n")).toEqual(["orbit-launcher"]);

      const extractDir = mkdtempSync(join(tmpdir(), "build-launcher-extract-"));
      const extract = spawnSync("tar", ["-xzf", archive, "-C", extractDir], { encoding: "utf8" });
      expect(extract.status).toBe(0);
      const run = spawnSync(join(extractDir, "orbit-launcher"), [], { encoding: "utf8" });
      expect(run.stdout).toContain(`stub-orbit-launcher linux ${arch}`);
    }
  });

  it("refuses when the tag resolves to a commit other than the pin", () => {
    const { dir: remote, commit } = deployLauncherRemote();
    const wrongCommit = commit.replace(/^./u, commit[0] === "0" ? "1" : "0");
    const pinFile = writePinFile(remote, { commit: wrongCommit });
    const outputDir = mkdtempSync(join(tmpdir(), "build-launcher-out-"));

    const { result } = runBuild({ outputDir, pinFile, remote });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to build an unpinned source");
    expect(result.stderr).toContain(commit);
    expect(result.stderr).toContain(wrongCommit);
  });

  it("refuses a tag the remote does not have", () => {
    const { dir: remote, commit } = deployLauncherRemote();
    const pinFile = writePinFile(remote, { tag: "v9.9.9", commit });
    const outputDir = mkdtempSync(join(tmpdir(), "build-launcher-out-"));

    const { result } = runBuild({ outputDir, pinFile, remote });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has no tag v9.9.9");
  });

  it("refuses a malformed pin file", () => {
    const { dir: remote, commit } = deployLauncherRemote();
    const outputDir = mkdtempSync(join(tmpdir(), "build-launcher-out-"));

    const badTag = writePinFile(remote, { tag: "0.1.0", commit });
    expect(runBuild({ outputDir, pinFile: badTag, remote }).result.status).toBe(1);
    expect(runBuild({ outputDir, pinFile: badTag, remote }).result.stderr).toContain(
      "not a plain vX.Y.Z tag",
    );

    const badCommit = join(remote, "bad-commit-pin.json");
    writeFileSync(badCommit, JSON.stringify({ tag: "v0.1.0", commit: "not-a-sha" }));
    const badResult = runBuild({ outputDir, pinFile: badCommit, remote }).result;
    expect(badResult.status).toBe(1);
    expect(badResult.stderr).toContain("not a 40-hex sha");
  });

  it("refuses without an output directory argument", () => {
    const { dir: remote, commit } = deployLauncherRemote();
    const pinFile = writePinFile(remote, { commit });

    const { result } = runBuild({ outputDir: undefined, pinFile, remote });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("an output directory is required");
  });

  it("refuses when the job's Go toolchain is older than go.mod requires", () => {
    const { dir: remote, commit } = deployLauncherRemote({ goVersion: "1.99.0" });
    const pinFile = writePinFile(remote, { commit });
    const outputDir = mkdtempSync(join(tmpdir(), "build-launcher-out-"));

    const { result } = runBuild({ outputDir, pinFile, remote, goVersion: "1.27.1" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires go 1.99.0");
    expect(result.stderr).toContain("go1.27.1");
  });

  it("accepts a toolchain newer than go.mod requires", () => {
    const { dir: remote, commit } = deployLauncherRemote({ goVersion: "1.20.0" });
    const pinFile = writePinFile(remote, { commit });
    const outputDir = mkdtempSync(join(tmpdir(), "build-launcher-out-"));

    const { result } = runBuild({ outputDir, pinFile, remote, goVersion: "1.27.1" });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("fails when go build fails, rather than packing a missing binary", () => {
    const { dir: remote, commit } = deployLauncherRemote();
    const pinFile = writePinFile(remote, { commit });
    const outputDir = mkdtempSync(join(tmpdir(), "build-launcher-out-"));

    const { result } = runBuild({ outputDir, pinFile, remote, goBuildExit: 1 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("go build failed for linux/amd64");
  });

  it("reads the pin and builds with no node on PATH (build_launcher's golang image has none, #1107)", () => {
    const { dir: remote, commit } = deployLauncherRemote();
    const pinFile = writePinFile(remote, { commit });
    const outputDir = mkdtempSync(join(tmpdir(), "build-launcher-out-"));
    const noNodePath = pathWithoutNode();
    expect(noNodePath.split(":").some((dir) => existsSync(join(dir, "node")))).toBe(false);

    const { result } = runBuild({ outputDir, pinFile, remote, path: noNodePath });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(existsSync(join(outputDir, "orbit-launcher_linux_amd64.tar.gz"))).toBe(true);
    expect(existsSync(join(outputDir, "orbit-launcher_linux_arm64.tar.gz"))).toBe(true);
  });

  it("refuses a missing pin file, naming the missing slice", () => {
    const { dir: remote } = deployLauncherRemote();
    const outputDir = mkdtempSync(join(tmpdir(), "build-launcher-out-"));

    const { result } = runBuild({
      outputDir,
      pinFile: join(remote, "nonexistent-pin.json"),
      remote,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no pin file at");
  });
});
