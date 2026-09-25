import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

/*
 * scripts/get-orbit.sh (ADR-0031 #6, implementation slice 6): the first
 * thing a user runs. Every case here asserts the launcher stub was NOT run
 * on a failure path -- the point of the script is that it never hands
 * control to anything unverified.
 *
 * Fixtures are served via file:// (curl supports it directly, and
 * spawnSync -- used below because get-orbit.sh may exec a stub launcher
 * that outlives a plain spawn -- blocks the event loop, so a real local
 * HTTP server would never get to answer a request from the child).
 *
 * A real throwaway P-256 key pair signs fixtures the same way
 * scripts/ci/verify-release-manifest.test.mjs signs its own: cosign
 * sign-blob's output is the base64 of the raw DER bytes `openssl dgst
 * -sha256 -sign` produces, so signing that way and base64-encoding the
 * result is byte-identical to what a real release carries.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./get-orbit.sh", import.meta.url).pathname;
const cosignPub = new URL("../cosign.pub", import.meta.url).pathname;

const directories = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop(), { recursive: true, force: true });
});

function makeDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

function generateKeyPair(dir, name = "key") {
  const privatePem = join(dir, `${name}.pem`);
  const publicPem = join(dir, `${name}.pub.pem`);
  execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", privatePem]);
  execFileSync("openssl", ["ec", "-in", privatePem, "-pubout", "-out", publicPem], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return { privatePem, publicPem };
}

function signBase64(path, privatePem) {
  return execFileSync("openssl", ["dgst", "-sha256", "-sign", privatePem, path]).toString("base64");
}

function sha256Of(path) {
  return execFileSync("sha256sum", [path]).toString("utf8").split(/\s+/)[0];
}

const LAUNCHER_STUB = [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  "{",
  '  printf "ORBIT_LAUNCHER_INSTALL_SCRIPT_PATH=%s\\n" "${ORBIT_LAUNCHER_INSTALL_SCRIPT_PATH:-}"',
  '  printf "ORBIT_RELEASE_MANIFEST=%s\\n" "${ORBIT_RELEASE_MANIFEST:-}"',
  '  printf "install-script-contents=%s\\n" "$(cat "${ORBIT_LAUNCHER_INSTALL_SCRIPT_PATH:-/dev/null}" 2>/dev/null)"',
  '} > "$LAUNCHER_LOG"',
  "exit 0",
  "",
].join("\n");

function buildArchive(dir, arch) {
  const stageDir = join(dir, `stage-${arch}`);
  mkdirSync(stageDir, { recursive: true });
  const binary = join(stageDir, "orbit-launcher");
  writeFileSync(binary, LAUNCHER_STUB);
  chmodSync(binary, 0o755);
  const archivePath = join(dir, `orbit-launcher_linux_${arch}.tar.gz`);
  execFileSync("tar", ["-czf", archivePath, "-C", stageDir, "orbit-launcher"]);
  return archivePath;
}

const INSTALL_SH_CONTENTS = "#!/usr/bin/env bash\necho fake-install-sh\n";

/**
 * Lays out a release's assets on disk under <dir>/<routeDir>/..., matching
 * the path get-orbit.sh itself builds for the given channel, and returns
 * the file:// base URL to pass as ORBIT_GET_BASE_URL.
 */
function buildRelease({
  dir,
  arch,
  version = "1.2.3",
  privatePem,
  manifestOverride,
  sigOverride,
  archiveShaOverride,
  installShaOverride,
  serveBundle = false,
  routeDir = "releases/latest/download",
}) {
  const assetsDir = join(dir, routeDir);
  mkdirSync(assetsDir, { recursive: true });

  const archivePath = buildArchive(dir, arch);
  const installPath = join(dir, "install.sh");
  writeFileSync(installPath, INSTALL_SH_CONTENTS);

  const manifest = {
    schema: "https://tomlawson.io/schemas/orbit-release-manifest/v1",
    version,
    channel: "preview",
    commit: "a".repeat(40),
    image: { repository: "registry.tomlawson.io/tomlawesome/orbit", digest: `sha256:${"b".repeat(64)}` },
    launcher: { tag: "v1.0.0", commit: "c".repeat(40) },
    files: {
      [`orbit-launcher_linux_${arch}.tar.gz`]: `sha256:${archiveShaOverride ?? sha256Of(archivePath)}`,
      "install.sh": `sha256:${installShaOverride ?? sha256Of(installPath)}`,
    },
    recordedAt: "2026-09-24T00:00:00Z",
  };
  // Pretty-printed, one field per line, matching the real
  // scripts/ci/write-release-manifest.sh output -- get-orbit.sh's own
  // manifest_value() relies on that shape (each key is on its own line).
  const manifestJson = manifestOverride ?? JSON.stringify(manifest, null, 2);
  const manifestPath = join(assetsDir, "orbit-release-manifest.json");
  writeFileSync(manifestPath, manifestJson);
  const sig = sigOverride ?? signBase64(manifestPath, privatePem);
  writeFileSync(join(assetsDir, "orbit-release-manifest.json.sig"), sig);

  if (serveBundle) {
    writeFileSync(join(assetsDir, "orbit-release-manifest.json.sigstore.json"), "{}");
  }

  writeFileSync(join(assetsDir, `orbit-launcher_linux_${arch}.tar.gz`), readFileSync(archivePath));
  writeFileSync(join(assetsDir, "install.sh"), readFileSync(installPath));

  return `file://${dir}`;
}

const FAKE_COSIGN_PASS = [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  '[ "${1:-}" = "verify-blob" ] || { echo "unknown command" >&2; exit 1; }',
  "exit 0",
  "",
].join("\n");

function makeFakeCosign(dir) {
  const binDir = join(dir, "cosign-bin");
  mkdirSync(binDir, { recursive: true });
  const cosign = join(binDir, "cosign");
  writeFileSync(cosign, FAKE_COSIGN_PASS);
  chmodSync(cosign, 0o755);
  return binDir;
}

// The test host may have a real cosign on PATH (a shared executable, per
// this host's environment skill); a happy-path test with no bundle would
// otherwise have it try, and fail, to verify one for real. Tests that want
// cosign present prepend their own fake ahead of this filtered PATH.
const pathWithoutCosign = process.env.PATH.split(":")
  .filter((dir) => dir && !existsSync(join(dir, "cosign")))
  .join(":");

function run({ baseUrl, env = {}, launcherLog }) {
  return failOnProcessDeadline(
    spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        PATH: pathWithoutCosign,
        HOME: process.env.HOME ?? tmpdir(),
        ORBIT_GET_BASE_URL: baseUrl,
        LAUNCHER_LOG: launcherLog,
        ...env,
      },
      ...processGuard(),
    }),
    { label: "get-orbit" },
  );
}

const arch = process.arch === "arm64" ? "arm64" : "amd64";

describe("get-orbit.sh", () => {
  it("embeds the cosign public key byte for byte", () => {
    const source = readFileSync(script, "utf8");
    const match = /embedded_public_key='([\s\S]*?)'/u.exec(source);
    expect(match).not.toBeNull();
    expect(`${match[1]}\n`).toBe(readFileSync(cosignPub, "utf8"));
  });

  it("verifies, downloads and runs the stub launcher with the verified install script path", () => {
    const dir = makeDir("get-orbit-");
    const { privatePem, publicPem } = generateKeyPair(dir);
    const baseUrl = buildRelease({ dir, arch, privatePem });
    const launcherLog = join(dir, "launcher.log");
    const cache = makeDir("get-orbit-cache-");

    const result = run({
      baseUrl,
      launcherLog,
      env: {
        XDG_CACHE_HOME: cache,
        ORBIT_GET_TEST_PUBLIC_KEY_FILE: publicPem,
        ORBIT_GET_TEST_ALLOW_KEY_OVERRIDE: "1",
      },
    });

    expect(result.status).toBe(0);
    const logged = readFileSync(launcherLog, "utf8");
    expect(logged).toContain(`ORBIT_LAUNCHER_INSTALL_SCRIPT_PATH=${cache}/orbit/1.2.3/install.sh`);
    expect(logged).toContain(`ORBIT_RELEASE_MANIFEST=${cache}/orbit/1.2.3/orbit-release-manifest.json`);
    expect(logged).toContain("install-script-contents=#!/usr/bin/env bash");
  });

  it("runs a pinned ORBIT_VERSION when the signed manifest is for that version", () => {
    const dir = makeDir("get-orbit-");
    const { privatePem, publicPem } = generateKeyPair(dir);
    const baseUrl = buildRelease({ dir, arch, privatePem, version: "1.2.3", routeDir: "releases/download/v1.2.3", serveBundle: false });
    const launcherLog = join(dir, "launcher.log");
    const cache = makeDir("get-orbit-cache-");

    const result = run({
      baseUrl,
      launcherLog,
      env: {
        XDG_CACHE_HOME: cache,
        ORBIT_VERSION: "v1.2.3",
        ORBIT_GET_TEST_PUBLIC_KEY_FILE: publicPem,
        ORBIT_GET_TEST_ALLOW_KEY_OVERRIDE: "1",
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(launcherLog, "utf8")).toContain(`${cache}/orbit/1.2.3/install.sh`);
  });

  it("runs a pinned ORBIT_VERSION for a pre-release tag (e.g. a throwaway e2e tag, #1121)", () => {
    const dir = makeDir("get-orbit-");
    const { privatePem, publicPem } = generateKeyPair(dir);
    const baseUrl = buildRelease({
      dir,
      arch,
      privatePem,
      version: "1.3.0-e2e.1",
      routeDir: "releases/download/v1.3.0-e2e.1",
      serveBundle: false,
    });
    const launcherLog = join(dir, "launcher.log");
    const cache = makeDir("get-orbit-cache-");

    const result = run({
      baseUrl,
      launcherLog,
      env: {
        XDG_CACHE_HOME: cache,
        ORBIT_VERSION: "v1.3.0-e2e.1",
        ORBIT_GET_TEST_PUBLIC_KEY_FILE: publicPem,
        ORBIT_GET_TEST_ALLOW_KEY_OVERRIDE: "1",
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(launcherLog, "utf8")).toContain(`${cache}/orbit/1.3.0-e2e.1/install.sh`);
  });

  it("refuses a validly signed manifest for a different version than ORBIT_VERSION asked for", () => {
    const dir = makeDir("get-orbit-");
    const { privatePem, publicPem } = generateKeyPair(dir);
    // A real, correctly signed older release served where v1.2.3 was asked
    // for: the signature passes, so only the version check can catch it.
    const baseUrl = buildRelease({ dir, arch, privatePem, version: "1.0.0", routeDir: "releases/download/v1.2.3" });
    const launcherLog = join(dir, "launcher.log");

    const result = run({
      baseUrl,
      launcherLog,
      env: {
        XDG_CACHE_HOME: makeDir("get-orbit-cache-"),
        ORBIT_VERSION: "v1.2.3",
        ORBIT_GET_TEST_PUBLIC_KEY_FILE: publicPem,
        ORBIT_GET_TEST_ALLOW_KEY_OVERRIDE: "1",
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("asked for v1.2.3 but the signed manifest is for v1.0.0");
    expect(() => readFileSync(launcherLog)).toThrow();
  });

  it("refuses a tampered manifest and does not run the launcher", () => {
    const dir = makeDir("get-orbit-");
    const { privatePem, publicPem } = generateKeyPair(dir);
    const baseUrl = buildRelease({ dir, arch, privatePem });
    // Tamper after signing: the manifest on disk no longer matches what was
    // signed, the way a corrupted or substituted download would look.
    writeFileSync(
      join(dir, "releases", "latest", "download", "orbit-release-manifest.json"),
      JSON.stringify({ version: "9.9.9", files: {} }, null, 2),
    );
    const launcherLog = join(dir, "launcher.log");

    const result = run({
      baseUrl,
      launcherLog,
      env: {
        XDG_CACHE_HOME: makeDir("get-orbit-cache-"),
        ORBIT_GET_TEST_PUBLIC_KEY_FILE: publicPem,
        ORBIT_GET_TEST_ALLOW_KEY_OVERRIDE: "1",
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not verify the release manifest");
    expect(() => readFileSync(launcherLog)).toThrow();
  });

  it("refuses a signature made with the wrong key", () => {
    const dir = makeDir("get-orbit-");
    const { privatePem: attackerKey } = generateKeyPair(dir, "attacker");
    const { publicPem } = generateKeyPair(dir, "committed");
    const baseUrl = buildRelease({ dir, arch, privatePem: attackerKey });
    const launcherLog = join(dir, "launcher.log");

    const result = run({
      baseUrl,
      launcherLog,
      env: {
        XDG_CACHE_HOME: makeDir("get-orbit-cache-"),
        ORBIT_GET_TEST_PUBLIC_KEY_FILE: publicPem,
        ORBIT_GET_TEST_ALLOW_KEY_OVERRIDE: "1",
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not verify the release manifest");
    expect(() => readFileSync(launcherLog)).toThrow();
  });

  it("refuses a launcher archive whose sha256 does not match the manifest", () => {
    const dir = makeDir("get-orbit-");
    const { privatePem, publicPem } = generateKeyPair(dir);
    const baseUrl = buildRelease({ dir, arch, privatePem, archiveShaOverride: "0".repeat(64) });
    const launcherLog = join(dir, "launcher.log");

    const result = run({
      baseUrl,
      launcherLog,
      env: {
        XDG_CACHE_HOME: makeDir("get-orbit-cache-"),
        ORBIT_GET_TEST_PUBLIC_KEY_FILE: publicPem,
        ORBIT_GET_TEST_ALLOW_KEY_OVERRIDE: "1",
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("launcher archive does not match");
    expect(() => readFileSync(launcherLog)).toThrow();
  });

  it("refuses install.sh whose sha256 does not match the manifest", () => {
    const dir = makeDir("get-orbit-");
    const { privatePem, publicPem } = generateKeyPair(dir);
    const baseUrl = buildRelease({ dir, arch, privatePem, installShaOverride: "0".repeat(64) });
    const launcherLog = join(dir, "launcher.log");

    const result = run({
      baseUrl,
      launcherLog,
      env: {
        XDG_CACHE_HOME: makeDir("get-orbit-cache-"),
        ORBIT_GET_TEST_PUBLIC_KEY_FILE: publicPem,
        ORBIT_GET_TEST_ALLOW_KEY_OVERRIDE: "1",
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("install.sh does not match");
    expect(() => readFileSync(launcherLog)).toThrow();
  });

  it("refuses an unsupported architecture before any download", () => {
    const dir = makeDir("get-orbit-");
    const fakeUnameDir = join(dir, "uname-bin");
    mkdirSync(fakeUnameDir, { recursive: true });
    const fakeUname = join(fakeUnameDir, "uname");
    writeFileSync(
      fakeUname,
      ["#!/usr/bin/env bash", '[ "$1" = "-s" ] && echo Linux && exit 0', "echo mips64", "exit 0", ""].join("\n"),
    );
    chmodSync(fakeUname, 0o755);
    const launcherLog = join(dir, "launcher.log");

    const result = run({
      baseUrl: `file://${dir}`,
      launcherLog,
      env: {
        XDG_CACHE_HOME: makeDir("get-orbit-cache-"),
        PATH: `${fakeUnameDir}:${pathWithoutCosign}`,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsupported architecture");
    expect(() => readFileSync(launcherLog)).toThrow();
  });

  it("refuses ORBIT_CHANNEL=preview without making any network request (#1107)", () => {
    const dir = makeDir("get-orbit-");
    const launcherLog = join(dir, "launcher.log");

    const result = run({
      baseUrl: `file://${join(dir, "never-fetched")}`,
      launcherLog,
      env: {
        ORBIT_CHANNEL: "preview",
        XDG_CACHE_HOME: makeDir("get-orbit-cache-"),
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("only installs stable releases");
    expect(result.stderr).toContain("ORBIT_RELEASE_MANIFEST");
    expect(() => readFileSync(launcherLog)).toThrow();
  });

  it("on latest, refuses without a countersignature bundle when cosign is on PATH", () => {
    const dir = makeDir("get-orbit-");
    const { privatePem, publicPem } = generateKeyPair(dir);
    const baseUrl = buildRelease({ dir, arch, privatePem });
    const launcherLog = join(dir, "launcher.log");
    const cosignBin = makeFakeCosign(dir);

    const result = run({
      baseUrl,
      launcherLog,
      env: {
        XDG_CACHE_HOME: makeDir("get-orbit-cache-"),
        ORBIT_GET_TEST_PUBLIC_KEY_FILE: publicPem,
        ORBIT_GET_TEST_ALLOW_KEY_OVERRIDE: "1",
        PATH: `${cosignBin}:${pathWithoutCosign}`,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no countersignature bundle for this release yet");
    expect(() => readFileSync(launcherLog)).toThrow();
  });

  it("refuses to swap the embedded key without the second test-only flag", () => {
    const dir = makeDir("get-orbit-");
    const { privatePem, publicPem } = generateKeyPair(dir);
    const baseUrl = buildRelease({ dir, arch, privatePem });
    const launcherLog = join(dir, "launcher.log");

    const result = run({
      baseUrl,
      launcherLog,
      env: {
        XDG_CACHE_HOME: makeDir("get-orbit-cache-"),
        ORBIT_GET_TEST_PUBLIC_KEY_FILE: publicPem,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing to swap the trust anchor");
    expect(() => readFileSync(launcherLog)).toThrow();
  });
});
