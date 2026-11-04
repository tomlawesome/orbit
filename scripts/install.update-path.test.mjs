// scripts/install.sh --update refuses an update from more than
// UPGRADE_FROM_COUNT releases back (#1667, owner answers 40a and 41a). The
// signed release manifest carries `updateFrom` (the releases an update is
// allowed from) and `releases` (every stable release, newest first); the
// installed version is `.env-orbit`'s ORBIT_CONFIG_APPLIED_VERSION. The
// refusal is `fail_with update-path abort "<line>"`, before anything is
// pulled. Written from the specification alone (issue #1667 body, its design
// note and owner answer 41a), before the change. Fixtures: install-test-support.mjs.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { UPGRADE_FROM_COUNT } from "./ci/upgrade-versions.mjs";
import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";
import {
  baseEnvironment,
  digest,
  eventLines,
  imageRepository,
  installScript,
  makeFakeBin,
  makeTarget,
  makePreprovisionedDeployment,
  readOptional,
  revision,
  runInstall,
} from "./install-test-support.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const TARGET = "v0.3.6";
// Newest first, as the manifest lists them; the target itself is not yet a tag.
const RELEASES = ["v0.3.5", "v0.3.4", "v0.3.3", "v0.3.2", "v0.3.1", "v0.3.0"];
const TERMINAL = "phase=identity component=image state=failed reason=update-path action=abort";
const NO_VERSION_LINE =
  "This install's .env-orbit does not record an Orbit release version (ORBIT_CONFIG_APPLIED_VERSION), so the installer cannot tell which releases it may update from. Run \"bash scripts/repair.sh --check\" from this directory.";

function manifestFile({ version = TARGET, channel = "preview", releases = RELEASES, updateFrom = releases.slice(0, UPGRADE_FROM_COUNT), omit = [] } = {}) {
  const manifest = {
    schema: "https://tomlawson.io/schemas/orbit-release-manifest/v1",
    version,
    channel,
    commit: revision,
    updateFrom,
    releases,
    image: { repository: imageRepository, digest: `sha256:${digest}` },
    launcher: { tag: "v1.0.0", commit: revision },
    files: {},
    recordedAt: "2026-11-03T00:00:00Z",
  };
  for (const key of omit) delete manifest[key];
  const path = join(mkdtempSync(join(tmpdir(), "orbit-update-path-manifest-")), "orbit-release-manifest.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

/**
 * A deployment folder whose `.env-orbit` records an installed image, the applied
 * digest stamp and, unless null, the applied version. The stamp is what marks
 * an earlier install (the engine's environmentHasAppliedStamp).
 */
function installedFolder(installedVersion) {
  const targetDir = makeTarget();
  const lines = [`ORBIT_IMAGE=${imageRepository}@sha256:${"c".repeat(64)}`, `ORBIT_CONFIG_APPLIED_DIGEST=sha256:${"c".repeat(64)}`];
  if (installedVersion !== null) lines.push(`ORBIT_CONFIG_APPLIED_VERSION=${installedVersion}`);
  makePreprovisionedDeployment(targetDir, lines);
  return targetDir;
}

function update(installedVersion, manifestOptions = {}, extraEnv = {}) {
  const version = manifestOptions.version ?? TARGET;
  const manifest = manifestFile(manifestOptions);
  return runInstall(installedFolder(installedVersion), { ORBIT_RELEASE_MANIFEST: manifest, FAKE_DOCKER_VERSION: version, ...extraEnv }, ["--plain", "--update"]);
}

const pulled = (result) => /^docker pull /mu.test(result.calls);
const orbitLines = (stderr) => stderr.split("\n").filter((line) => line.startsWith("Orbit installer: "));

function expectRefused(result, line) {
  expect(result.status).not.toBe(0);
  expect(eventLines(result.stdout).filter((event) => event.startsWith(TERMINAL))).toHaveLength(1);
  expect(orbitLines(result.stderr)).toEqual([`Orbit installer: ${line}`]);
  expect(pulled(result)).toBe(false);
  expect(result.calls).not.toMatch(/^docker (compose (?!version)|run |volume rm )/mu);
}

function expectNotRefused(result) {
  expect(result.stdout).not.toContain("reason=update-path");
  expect(result.stderr).not.toContain("This install is on");
  // Past the check, the run goes on to pull the image the manifest names.
  expect(pulled(result)).toBe(true);
}

describe("install.sh --update: the update-path rule (#1667)", () => {
  it("allows an update from each of the last UPGRADE_FROM_COUNT releases", () => {
    for (const installed of RELEASES.slice(0, UPGRADE_FROM_COUNT)) expectNotRefused(update(installed));
  });

  it("refuses the release just beyond those, naming the newest release as the stop", () => {
    const installed = RELEASES[UPGRADE_FROM_COUNT];
    expectRefused(update(installed), `This install is on ${installed}. Update to ${RELEASES[0]} first, then to ${TARGET}.`);
  });

  it("names the stop the issue gives: v0.3.1 to v0.3.6 goes through v0.3.4", () => {
    // The manifest states the allowed set itself; its length is the window.
    const result = update("v0.3.1", { updateFrom: ["v0.3.5", "v0.3.4", "v0.3.3"] });
    expectRefused(result, "This install is on v0.3.1. Update to v0.3.4 first, then to v0.3.6.");
  });

  it("names the stop as the release exactly the window ahead of the installed one, for every refused version", () => {
    RELEASES.slice(UPGRADE_FROM_COUNT).forEach((installed, offset) => {
      const stop = RELEASES[offset];
      expectRefused(update(installed), `This install is on ${installed}. Update to ${stop} first, then to ${TARGET}.`);
    });
  });

  it("does not count a retracted release: it is absent from the lists, so the window reaches one release further back", () => {
    // v0.3.3 was retracted and the writer left it out; v0.3.2 is then the third stable release back.
    const releases = ["v0.3.5", "v0.3.4", "v0.3.2", "v0.3.1", "v0.3.0"];
    expectNotRefused(update("v0.3.2", { releases }));
    // ... and the next one back is refused, with the stop counted over stable releases only.
    expectRefused(update("v0.3.1", { releases }), "This install is on v0.3.1. Update to v0.3.5 first, then to v0.3.6.");
  });

  it("refuses an install on a retracted release by name, since it is not a stable release", () => {
    const releases = ["v0.3.5", "v0.3.4", "v0.3.2", "v0.3.1", "v0.3.0"];
    expectRefused(
      update("v0.3.3", { releases }),
      "This install is on v0.3.3, which is not a stable Orbit release this installer can update from.",
    );
  });

  it("allows an update to the same version as the one installed, even when it is not in releases (41a)", () => {
    // A preview build of a version that never became a tag.
    expectNotRefused(update(TARGET));
  });

  it("allows a same-version update when the version is not in releases and updateFrom is empty", () => {
    expectNotRefused(update("v0.4.0", { version: "v0.4.0", releases: RELEASES, updateFrom: [] }));
  });

  it("refuses an installed version that is not in releases and is not the target, by name", () => {
    expectRefused(
      update("v1.0.0"),
      "This install is on v1.0.0, which is not a stable Orbit release this installer can update from.",
    );
  });

  it("refuses an installed version newer than the target (no downgrades)", () => {
    const result = update("v0.3.7");
    expect(result.status).not.toBe(0);
    expect(eventLines(result.stdout).filter((event) => event.startsWith(TERMINAL))).toHaveLength(1);
    expect(orbitLines(result.stderr)).toHaveLength(1);
    expect(orbitLines(result.stderr)[0]).toContain("v0.3.7");
    expect(pulled(result)).toBe(false);
  });

  it("refuses a target older than a release the install is on, even when that release is listed", () => {
    // A manifest pinned to an older build than the install: newer-than-target, listed in releases.
    const result = update("v0.3.4", { version: "v0.3.2" });
    expect(result.status).not.toBe(0);
    expect(eventLines(result.stdout).filter((event) => event.startsWith(TERMINAL))).toHaveLength(1);
    expect(orbitLines(result.stderr)).toHaveLength(1);
    expect(orbitLines(result.stderr)[0]).toContain("v0.3.4");
    expect(pulled(result)).toBe(false);
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["without the v", "0.3.5"],
    ["short", "v0.3"],
    ["a prerelease suffix", "v0.3.5-rc1"],
    ["a channel word", "latest"],
    ["a leading zero", "v0.03.5"],
  ])("refuses an installed version that is %s, with the clear line and no guess", (_name, installed) => {
    expectRefused(update(installed), NO_VERSION_LINE);
  });

  it("refuses a manifest with no updateFrom, as predating the policy", () => {
    const result = update("v0.3.5", { omit: ["updateFrom"] });
    expect(result.status).not.toBe(0);
    expect(eventLines(result.stdout).filter((event) => event.startsWith(TERMINAL))).toHaveLength(1);
    expect(orbitLines(result.stderr)).toHaveLength(1);
    expect(pulled(result)).toBe(false);
  });

  it("refuses a manifest whose lists hold something that is not vX.Y.Z", () => {
    for (const options of [
      { updateFrom: ["v0.3.5", "latest"] },
      { releases: ["v0.3.5", "main", "v0.3.4"] },
    ]) {
      const result = update("v0.3.5", options);
      expect(result.status).not.toBe(0);
      expect(eventLines(result.stdout).filter((event) => event.startsWith(TERMINAL))).toHaveLength(1);
      expect(pulled(result)).toBe(false);
    }
  });

  it("does not read the fields on a fresh install: no .env-orbit image, a manifest without or with broken lists", () => {
    for (const manifest of [
      manifestFile({ omit: ["updateFrom", "releases"] }),
      manifestFile({ updateFrom: ["not-a-version"], releases: ["nor-this"] }),
    ]) {
      const targetDir = makeTarget();
      makePreprovisionedDeployment(targetDir);
      const result = runInstall(targetDir, { ORBIT_RELEASE_MANIFEST: manifest, FAKE_DOCKER_VERSION: TARGET }, ["--plain", "--install"]);
      expect(result.stdout).not.toContain("reason=update-path");
      expect(pulled(result)).toBe(true);
    }
  });

  it("treats a folder configure.sh prepared but nothing installed as a fresh install (an image, no applied stamp)", () => {
    // The acceptance job runs configure.sh, then install.sh with no flag.
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir, [`ORBIT_IMAGE=${imageRepository}@sha256:${"c".repeat(64)}`]);
    const result = runInstall(targetDir, { ORBIT_RELEASE_MANIFEST: manifestFile(), FAKE_DOCKER_VERSION: TARGET }, ["--plain"]);
    expect(result.stdout).not.toContain("reason=update-path");
    expect(pulled(result)).toBe(true);
  });

  it("ends the run with the terminal event first and then exactly one stderr line, with nothing between", () => {
    const manifest = manifestFile();
    const targetDir = installedFolder(RELEASES[UPGRADE_FROM_COUNT]);
    const logDir = mkdtempSync(join(tmpdir(), "orbit-install-log-"));
    const line = `This install is on ${RELEASES[UPGRADE_FROM_COUNT]}. Update to ${RELEASES[0]} first, then to ${TARGET}.`;
    // Both streams into one pipe, so the order they were written in is visible.
    const merged = failOnProcessDeadline(
      spawnSync("bash", ["-c", 'exec bash "$0" "$@" 2>&1', installScript, "--plain", "--update"], {
        cwd: targetDir,
        encoding: "utf8",
        env: { ...baseEnvironment(makeFakeBin(), logDir), ORBIT_RELEASE_MANIFEST: manifest, FAKE_DOCKER_VERSION: TARGET },
        ...processGuard(),
      }),
      { label: "update-path merged" },
    );
    expect(merged.status).not.toBe(0);
    const lines = merged.stdout.split("\n").filter(Boolean);
    const terminalAt = lines.findIndex((entry) => entry.startsWith(TERMINAL));
    expect(terminalAt).toBeGreaterThanOrEqual(0);
    expect(lines[terminalAt + 1]).toBe(`Orbit installer: ${line}`);
    expect(lines.filter((entry) => entry.startsWith("Orbit installer: "))).toHaveLength(1);
    expect(lines.at(-1)).toBe(`Orbit installer: ${line}`);
    expect(lines.filter((entry) => entry.startsWith("phase=") && / state=failed /.test(entry))).toHaveLength(1);
    expect(readOptional(join(logDir, "calls.log"))).not.toMatch(/^docker pull /mu);
    // On its own stderr: exactly that one line, no Docker detail before it.
    const separate = update(RELEASES[UPGRADE_FROM_COUNT]);
    expect(separate.stderr.trim()).toBe(`Orbit installer: ${line}`);
  });
});

describe("install.sh --update: write-test-manifest output (#1667)", () => {
  it("is accepted by the update path, so the acceptance update jobs do not hit the new refusal", () => {
    const manifest = join(mkdtempSync(join(tmpdir(), "orbit-test-manifest-")), "orbit-release-manifest.json");
    const written = spawnSync("bash", [new URL("./ci/write-test-manifest.sh", import.meta.url).pathname, manifest, imageRepository, `sha256:${digest}`], {
      encoding: "utf8",
    });
    expect(written.status, written.stderr).toBe(0);
    const { version } = JSON.parse(readFileSync(manifest, "utf8"));
    // The harness's installs report whichever version the placeholder manifest names.
    const result = runInstall(
      installedFolder(version),
      { ORBIT_RELEASE_MANIFEST: manifest, FAKE_DOCKER_VERSION: version },
      ["--plain", "--update"],
    );
    expectNotRefused(result);
  });
});

// Preview installs (#1678, owner decision 58a): with ORBIT_CHANNEL=preview and a
// verified manifest whose channel is "preview", an update is allowed from any
// earlier recorded version and never to an older one. Every other case keeps
// the stable rule above. Written from the specification alone.
describe("install.sh --update: preview installs update from any earlier version (#1678)", () => {
  const PREVIEW = { ORBIT_CHANNEL: "preview" };
  const previewUpdate = (installed, manifestOptions = {}) => update(installed, { channel: "preview", ...manifestOptions }, PREVIEW);

  it("allows an install 5 releases back, which is not in updateFrom", () => {
    expect(RELEASES.slice(0, UPGRADE_FROM_COUNT)).not.toContain(RELEASES[4]);
    expectNotRefused(previewUpdate(RELEASES[4]));
  });

  it("allows an installed version absent from releases entirely (a preview train never tagged), v0.3.7 to v0.4.0", () => {
    expectNotRefused(previewUpdate("v0.3.7", { version: "v0.4.0" }));
  });

  it("allows a manifest with no updateFrom", () => {
    expectNotRefused(previewUpdate("v0.3.5", { omit: ["updateFrom"] }));
  });

  it("allows the same version", () => {
    expectNotRefused(previewUpdate(TARGET));
  });

  it("refuses a target older than the installed version with the downgrade line, before any pull", () => {
    const result = previewUpdate("v0.3.7");
    expect(result.status).not.toBe(0);
    expect(eventLines(result.stdout).filter((event) => event.startsWith(TERMINAL))).toHaveLength(1);
    expect(orbitLines(result.stderr)).toHaveLength(1);
    expect(orbitLines(result.stderr)[0]).toBe(update("v0.3.7").stderr.trim());
    expect(orbitLines(result.stderr)[0]).toContain("v0.3.7");
    expect(pulled(result)).toBe(false);
  });

  it("refuses a missing installed version with the same line as the stable rule", () => {
    expectRefused(previewUpdate(null), NO_VERSION_LINE);
  });

  it.each([
    ["empty", ""],
    ["without the v", "0.3.5"],
    ["short", "v0.3"],
    ["a prerelease suffix", "v0.3.5-rc1"],
    ["a channel word", "latest"],
    ["a leading zero", "v0.03.5"],
  ])("refuses an installed version that is %s with the same line", (_name, installed) => {
    expectRefused(previewUpdate(installed), NO_VERSION_LINE);
  });

  it.each([["latest"], ["v0.4"], ["0.4.0"], ["v0.4.0-rc1"], [""]])(
    "refuses a manifest version %j that is not vX.Y.Z as an update-path abort, before any pull",
    (version) => {
      const manifest = manifestFile({ version, channel: "preview" });
      const result = runInstall(installedFolder("v0.3.5"), { ...PREVIEW, ORBIT_RELEASE_MANIFEST: manifest, FAKE_DOCKER_VERSION: TARGET }, ["--plain", "--update"]);
      expect(result.status).not.toBe(0);
      expect(eventLines(result.stdout).filter((event) => event.startsWith(TERMINAL))).toHaveLength(1);
      expect(pulled(result)).toBe(false);
    },
  );

  it("keeps the stable rule when the manifest's channel is latest, even with ORBIT_CHANNEL=preview", () => {
    const installed = RELEASES[UPGRADE_FROM_COUNT];
    expectRefused(
      update(installed, { channel: "latest" }, PREVIEW),
      `This install is on ${installed}. Update to ${RELEASES[0]} first, then to ${TARGET}.`,
    );
  });

  it("keeps the stable rule when the manifest's channel is preview but ORBIT_CHANNEL is unset", () => {
    const installed = RELEASES[UPGRADE_FROM_COUNT];
    expectRefused(
      update(installed, { channel: "preview" }),
      `This install is on ${installed}. Update to ${RELEASES[0]} first, then to ${TARGET}.`,
    );
  });
});
