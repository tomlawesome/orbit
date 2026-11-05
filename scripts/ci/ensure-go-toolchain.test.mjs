/**
 * scripts/ci/ensure-go-toolchain.sh <path/to/go.mod> (#1727, S-ci-2): reads the
 * Go version from the launcher's go.mod, downloads the linux-amd64 tarball and
 * go.dev's release list, checks the tarball against the list's sha256 and only
 * then unpacks it into the install prefix.
 *
 * Environment overrides the script must honour (the builder uses these names):
 *   ORBIT_GO_DL_BASE      base URL; the tarball is <base>/go<v>.linux-amd64.tar.gz
 *   ORBIT_GO_DL_JSON_URL  URL of the release list (go.dev/dl/?mode=json&include=all shape:
 *                         [{ "version": "go1.2.3", "files": [{ "filename", "sha256", ... }] }])
 *   ORBIT_GO_PREFIX       install prefix (default /usr/local); the tarball unpacks to <prefix>/go
 *
 * Served here by file:// fixtures, never the network.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./ensure-go-toolchain.sh", import.meta.url).pathname;
const ciFile = new URL("../../.gitlab-ci.yml", import.meta.url).pathname;

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * A fixture world: a go.mod, a download dir holding tarballs for `versions`,
 * a release list, and an empty install prefix.
 */
function world({ goMod, versions = [], listed = versions, shaFor = {}, skipTarball = [] }) {
  const root = mkdtempSync(join(tmpdir(), "ensure-go-"));
  const dl = join(root, "dl");
  const prefix = join(root, "prefix");
  mkdirSync(dl);
  mkdirSync(prefix);
  const goModPath = join(root, "go.mod");
  writeFileSync(goModPath, goMod);
  const files = [];
  for (const v of versions) {
    const src = join(root, `src-${v}`);
    mkdirSync(join(src, "go"), { recursive: true });
    writeFileSync(join(src, "go", "VERSION"), `go${v}\n`);
    const name = `go${v}.linux-amd64.tar.gz`;
    const tarball = join(dl, name);
    const tar = spawnSync("tar", ["-C", src, "-czf", tarball, "go"], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
    if (listed.includes(v)) {
      files.push({ filename: name, os: "linux", arch: "amd64", sha256: shaFor[v] ?? sha256(tarball) });
    }
    if (skipTarball.includes(v)) spawnSync("rm", ["-f", tarball]);
  }
  const list = join(root, "releases.json");
  writeFileSync(list, JSON.stringify([{ version: "go-fixture", stable: true, files }]));
  return { root, dl, prefix, goModPath, list };
}

function run(w) {
  return failOnProcessDeadline(
    spawnSync("bash", [script, w.goModPath], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME ?? tmpdir(),
        ORBIT_GO_DL_BASE: `file://${w.dl}`,
        ORBIT_GO_DL_JSON_URL: `file://${w.list}`,
        ORBIT_GO_PREFIX: w.prefix,
      },
      ...processGuard(),
    }),
    { label: "ensure-go-toolchain" },
  );
}

const installedVersion = (w) => readFileSync(join(w.prefix, "go", "VERSION"), "utf8").trim();
const prefixEmpty = (w) => readdirSync(w.prefix).length === 0;

describe("ensure-go-toolchain.sh version selection", () => {
  it("prefers the toolchain line over the go line", () => {
    const w = world({ goMod: "module m\n\ngo 1.27.1\n\ntoolchain go1.27.2\n", versions: ["1.27.1", "1.27.2"] });
    const r = run(w);
    expect(r.status, r.stderr).toBe(0);
    expect(installedVersion(w)).toBe("go1.27.2");
  });

  it("uses the go line when there is no toolchain line", () => {
    const w = world({ goMod: "module m\n\ngo 1.27.1\n", versions: ["1.27.1", "1.27.2"] });
    const r = run(w);
    expect(r.status, r.stderr).toBe(0);
    expect(installedVersion(w)).toBe("go1.27.1");
  });

  it("fails, with a reason on stderr and the prefix untouched, when go.mod names no version", () => {
    const w = world({ goMod: "module m\n", versions: ["1.27.1"] });
    const r = run(w);
    expect(r.status).not.toBe(0);
    expect(r.stderr.trim()).not.toBe("");
    expect(prefixEmpty(w)).toBe(true);
  });
});

describe("ensure-go-toolchain.sh checksum verification", () => {
  const goMod = "module m\n\ngo 1.27.1\n";

  it("unpacks into the prefix when the sha256 matches go.dev's list", () => {
    const w = world({ goMod, versions: ["1.27.1"] });
    const r = run(w);
    expect(r.status, r.stderr).toBe(0);
    expect(installedVersion(w)).toBe("go1.27.1");
  });

  it("fails on a sha256 mismatch, names the expected and the actual digest, and leaves the prefix empty", () => {
    const expected = "a".repeat(64);
    const w = world({ goMod, versions: ["1.27.1"], shaFor: { "1.27.1": expected } });
    const actual = sha256(join(w.dl, "go1.27.1.linux-amd64.tar.gz"));
    const r = run(w);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(expected);
    expect(r.stderr).toContain(actual);
    expect(prefixEmpty(w)).toBe(true);
  });

  it("fails, prefix untouched, when the list has no entry for the file", () => {
    const w = world({ goMod, versions: ["1.27.1", "1.27.2"], listed: ["1.27.2"] });
    const r = run(w);
    expect(r.status).not.toBe(0);
    expect(r.stderr.trim()).not.toBe("");
    expect(prefixEmpty(w)).toBe(true);
  });

  it("matches the filename exactly: an entry for a longer version does not stand in", () => {
    const w = world({ goMod, versions: ["1.27.1", "1.27.10"], listed: ["1.27.10"] });
    const r = run(w);
    expect(r.status).not.toBe(0);
    expect(prefixEmpty(w)).toBe(true);
  });

  for (const [label, bad] of [
    ["too short", "abc123"],
    ["not hex", "z".repeat(64)],
    ["65 characters", "a".repeat(65)],
    ["empty", ""],
  ]) {
    it(`fails, prefix untouched, when the listed sha256 is malformed (${label})`, () => {
      const w = world({ goMod, versions: ["1.27.1"], shaFor: { "1.27.1": bad } });
      const r = run(w);
      expect(r.status).not.toBe(0);
      expect(r.stderr.trim()).not.toBe("");
      expect(prefixEmpty(w)).toBe(true);
    });
  }

  it("fails, prefix untouched, when the tarball download fails", () => {
    const w = world({ goMod, versions: ["1.27.1"], skipTarball: ["1.27.1"] });
    const r = run(w);
    expect(r.status).not.toBe(0);
    expect(r.stderr.trim()).not.toBe("");
    expect(prefixEmpty(w)).toBe(true);
  });

  it("fails, prefix untouched, when the release list download fails", () => {
    const w = world({ goMod, versions: ["1.27.1"] });
    spawnSync("rm", ["-f", w.list]);
    const r = run(w);
    expect(r.status).not.toBe(0);
    expect(prefixEmpty(w)).toBe(true);
  });
});

describe("the launcher jobs in .gitlab-ci.yml use the checked download", () => {
  const lines = readFileSync(ciFile, "utf8").split("\n");
  function jobBody(name) {
    const start = lines.findIndex((l) => l === `${name}:`);
    expect(start, `job ${name} exists`).toBeGreaterThanOrEqual(0);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^[A-Za-z_.][^\s:]*:/.test(lines[i])) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end).join("\n");
  }

  for (const job of ["upgrade_cell_launcher", "launcher_install_compat"]) {
    it(`${job} does not curl the Go tarball from go.dev/dl`, () => {
      expect(jobBody(job)).not.toMatch(/curl[^\n]*go\.dev\/dl/);
    });
    it(`${job} calls scripts/ci/ensure-go-toolchain.sh`, () => {
      expect(jobBody(job)).toContain("scripts/ci/ensure-go-toolchain.sh");
    });
  }
});
