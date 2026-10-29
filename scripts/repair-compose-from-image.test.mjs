import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

/*
 * #1484: repair.sh puts back a MISSING docker-compose.yml from the
 * deployment's own image, and REPORTS, but never replaces, one that differs.
 *
 * Written from the issue (owner plan, 2026-10-27, answer 19a) before the code:
 *   - missing: read the digest-pinned ORBIT_IMAGE from .env-orbit, take
 *     docker-compose.yml from the image's deployment assets (/opt/orbit/deploy,
 *     named by the io.orbit.deployment-assets label), write it with the
 *     installer's mode (0644) and the folder's owner. A restore, not made-up
 *     content.
 *   - present but different: a finding that says so and shows what differs;
 *     the file is left as it is (it may be a deliberate edit).
 *   - present and identical: nothing to do.
 *   - image cannot be read (not pulled, digest missing): today's manual step.
 *   - .env-orbit is never touched.
 *
 * The fake `docker` below is deliberately permissive about HOW the file is
 * read out of the image, so the implementation may choose: `docker image
 * inspect --format '{{index .Config.Labels "io.orbit.deployment-assets"}}'`,
 * `docker create` + `docker cp <id>:/opt/orbit/deploy/docker-compose.yml
 * <dest|->` + `docker rm`, or `docker run --rm [--entrypoint cat] <image>
 * [cat] /opt/orbit/deploy/docker-compose.yml`. The assertions are on what the
 * operator can observe: the file on disk and repair.sh's output.
 *
 * Convention for the builder: the fake image is a directory standing in for
 * /opt/orbit/deploy inside the image (FAKE_IMAGE_DIR). Every docker argv is
 * appended, one line each, to FAKE_DOCKER_LOG. An unreadable image
 * (imageReadable: false) makes every image-reading subcommand exit 1, the way
 * a pinned digest that was never pulled does.
 */

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoDir = join(scriptsDir, "..");
const repairScriptSource = readFileSync(join(scriptsDir, "repair.sh"), "utf8");
const operationsGuide = readFileSync(join(repoDir, "docs", "administrator-operations.md"), "utf8");

const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const PINNED_IMAGE = `ghcr.io/tomlawesome/orbit@${IMAGE_DIGEST}`;
const DEPLOY_ROOT = "/opt/orbit/deploy";

// What the image carries. Trailing blank lines, no trailing-newline stripping
// surprises, trailing spaces and a non-ASCII character: a restore that goes
// through command substitution, `echo`, or a text-mode copy changes these
// bytes, and "byte for byte" is the stated acceptance.
const IMAGE_COMPOSE = Buffer.from(
  [
    "name: orbit",
    "services:",
    "  orbit-app:",
    `    image: \${ORBIT_IMAGE:?set ORBIT_IMAGE}`,
    "    # café — shipped with trailing spaces   ",
    "    restart: unless-stopped",
    "",
    "",
    "",
  ].join("\n"),
  "utf8",
);

const EDIT_MARKER = "    image: example.invalid/my-own-orbit:DELIBERATE-EDIT-1484";
const EDITED_COMPOSE = Buffer.from(
  ["name: orbit", "services:", "  orbit-app:", EDIT_MARKER, "    restart: unless-stopped", ""].join("\n"),
  "utf8",
);

const scratchDirs = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

function scratchDir(prefix = "orbit-repair-compose-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

// A deployment folder as the installer leaves it, minus docker-compose.yml
// (the caller adds it, or not). repair.sh forces its cwd to its own checkout,
// so it is copied into the folder and never pointed at the real repository.
function makeDeployment({ compose }) {
  const targetDir = scratchDir();
  mkdirSync(join(targetDir, "scripts"));
  writeFileSync(join(targetDir, "scripts", "repair.sh"), repairScriptSource);
  chmodSync(join(targetDir, "scripts", "repair.sh"), 0o755);
  if (compose !== undefined) {
    writeFileSync(join(targetDir, "docker-compose.yml"), compose);
    chmodSync(join(targetDir, "docker-compose.yml"), 0o644);
  }
  writeFileSync(
    join(targetDir, ".env-orbit"),
    [
      "APP_URL=https://orbit.repair-test.internal",
      `ORBIT_IMAGE=${PINNED_IMAGE}`,
      "ORBIT_CONFIG_APPLIED_VERSION=v0.3.0",
      `ORBIT_CONFIG_APPLIED_DIGEST=${IMAGE_DIGEST}`,
      "OIDC_ISSUER=https://auth.repair-test.internal/application/o/orbit/",
      "OIDC_CLIENT_ID=repair-test-client",
      "OIDC_CLIENT_SECRET=repair-test-secret",
      "OIDC_CALLBACK_URL=https://orbit.repair-test.internal/api/auth/callback",
      "COMPOSE_PROJECT_NAME=repairtest",
      "",
    ].join("\n"),
  );
  chmodSync(join(targetDir, ".env-orbit"), 0o600);
  mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
  for (const name of ["session-secret", "postgres-password", "document-kek", "oidc-client-secret"]) {
    writeFileSync(join(targetDir, ".orbit-secrets", name), "a".repeat(64) + "\n");
    chmodSync(join(targetDir, ".orbit-secrets", name), 0o600);
  }
  return targetDir;
}

// A fake `docker` whose "image" is a directory standing in for /opt/orbit/deploy.
// Answers the image-reading subcommands an implementation might reasonably use
// (see the header); everything else the diagnosis issues is a quiet success
// with empty output (no containers, no volumes), and anything unknown fails
// like real Docker rejecting it.
function writeFakeDocker(binDir, { imageDir, logPath, imageReadable }) {
  const script = `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> '${logPath}'
readable=${imageReadable ? 1 : 0}
image_dir='${imageDir}'
deploy_root='${DEPLOY_ROOT}'

# Map a path inside the fake image to the host directory standing in for it.
host_path() {
  local p="\${1#*:}"
  case "$p" in
    "$deploy_root"|"$deploy_root"/.) printf '%s\\n' "$image_dir" ;;
    "$deploy_root"/*) printf '%s\\n' "$image_dir/\${p#"$deploy_root"/}" ;;
    *) return 1 ;;
  esac
}

case "\${1:-}" in
  ps|info|volume|compose) exit 0 ;;
  image)
    [[ "\${2:-}" == "inspect" ]] || exit 1
    [[ "$readable" == 1 ]] || { echo "Error: No such image" >&2; exit 1; }
    joined="$*"
    if [[ "$joined" == *"io.orbit.deployment-assets"* ]]; then
      printf '%s\\n' "$deploy_root"
    elif [[ "$joined" == *"Config.Labels"* ]]; then
      printf 'map[io.orbit.deployment-assets:%s]\\n' "$deploy_root"
    else
      printf 'sha256:${"c".repeat(64)}\\n'
    fi
    exit 0
    ;;
  inspect)
    # Container inspection: there are no containers in this fake.
    exit 1
    ;;
  create)
    [[ "$readable" == 1 ]] || { echo "Error: No such image" >&2; exit 1; }
    printf 'fakecontainer1484\\n'
    exit 0
    ;;
  rm) exit 0 ;;
  cp)
    [[ "$readable" == 1 ]] || exit 1
    args=("\${@:2}")
    positional=()
    for a in "\${args[@]}"; do
      case "$a" in
        -) positional+=("$a") ;;
        -*) ;;
        *) positional+=("$a") ;;
      esac
    done
    src="\${positional[0]:-}"
    dest="\${positional[1]:-}"
    [[ "$src" == *:* ]] || exit 1
    from="$(host_path "$src")" || exit 1
    [[ -e "$from" ]] || { echo "Error: not found" >&2; exit 1; }
    if [[ "$dest" == "-" ]]; then
      tar -C "$(dirname "$from")" -cf - "$(basename "$from")"
    elif [[ -d "$dest" ]]; then
      cp -R "$from" "$dest/"
    else
      cp "$from" "$dest"
    fi
    exit 0
    ;;
  run)
    [[ "$readable" == 1 ]] || { echo "Error: No such image" >&2; exit 1; }
    # docker run [opts] [--entrypoint cat] IMAGE [cat] /opt/orbit/deploy/<file>
    for a in "$@"; do
      if [[ "$a" == "$deploy_root"/* ]]; then
        from="$(host_path "x:$a")" || exit 1
        [[ -f "$from" ]] || { echo "cat: $a: No such file or directory" >&2; exit 1; }
        cat "$from"
        exit 0
      fi
    done
    exit 1
    ;;
esac
printf 'fake docker: unsupported: %s\\n' "$*" >&2
exit 1
`;
  writeFileSync(join(binDir, "docker"), script);
  chmodSync(join(binDir, "docker"), 0o755);
}

// Runs repair.sh with the fake docker first on PATH and a hostile umask (077),
// so a restored file only gets the installer's 0644 if repair.sh sets it.
function runRepair(targetDir, args, { imageReadable = true, image = IMAGE_COMPOSE } = {}) {
  const binDir = scratchDir("orbit-repair-compose-bin-");
  const imageDir = scratchDir("orbit-repair-compose-image-");
  if (image !== null) writeFileSync(join(imageDir, "docker-compose.yml"), image);
  const logPath = join(binDir, "docker-argv.log");
  writeFileSync(logPath, "");
  writeFakeDocker(binDir, { imageDir, logPath, imageReadable });
  const result = failOnProcessDeadline(
    spawnSync(
      "bash",
      ["-c", 'umask 077; exec bash "$@"', "repair", join(targetDir, "scripts", "repair.sh"), ...args],
      {
        cwd: targetDir,
        encoding: "utf8",
        input: "y\n",
        env: {
          HOME: process.env.HOME ?? tmpdir(),
          PATH: `${binDir}:${process.env.PATH}`,
          ORBIT_REPAIR_PROMPTS: "machine",
          FAKE_IMAGE_DIR: imageDir,
          FAKE_DOCKER_LOG: logPath,
        },
        ...processGuard(),
      },
    ),
    { label: "runRepair" },
  );
  return { ...result, dockerLog: readFileSync(logPath, "utf8"), combined: `${result.stdout}\n${result.stderr}` };
}

function lines(text) {
  return text.split("\n").filter(Boolean);
}

// A finding line about the Compose file that is NOT today's managed-file-missing
// and not the unrelated interpolation check.
function composeFindings(stdout) {
  return lines(stdout).filter(
    (line) =>
      line.startsWith("finding ") &&
      /compose/i.test(line) &&
      !/managed-file-missing|compose-interpolation-failed/.test(line),
  );
}

function fileMode(path) {
  return (statSync(path).mode & 0o777).toString(8);
}

function snapshot(path) {
  const stat = statSync(path);
  return { bytes: readFileSync(path).toString("hex"), mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs };
}

const MANUAL_STEP = /recreate the missing managed file from your install source/i;

describe("repair.sh restores a missing docker-compose.yml from the image (#1484)", () => {
  it("writes the image's copy back byte for byte, with the installer's mode and the folder's owner", () => {
    const targetDir = makeDeployment({});
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(false);

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    const restored = join(targetDir, "docker-compose.yml");
    expect(existsSync(restored), `docker-compose.yml was not restored.\n${result.combined}`).toBe(true);
    expect(readFileSync(restored).equals(IMAGE_COMPOSE)).toBe(true);
    expect(fileMode(restored)).toBe("644");
    const folder = statSync(targetDir);
    const file = statSync(restored);
    expect(file.uid).toBe(folder.uid);
    expect(file.gid).toBe(folder.gid);
    expect(file.isSymbolicLink?.() ?? false).toBe(false);
  });

  it("reads the file from the image pinned in .env-orbit (the digest, never a tag or a pull)", () => {
    const targetDir = makeDeployment({});

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(result.dockerLog).toContain(IMAGE_DIGEST);
    expect(lines(result.dockerLog).filter((argv) => /^pull(\s|$)/.test(argv))).toEqual([]);
  });

  it("needs no manual step: the run does not skip managed-file-missing and the final diagnosis no longer reports it", () => {
    const targetDir = makeDeployment({});

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(result.stdout).not.toContain("execute action=manual resolves=managed-file-missing");
    expect(result.stdout).not.toContain("managed-file-missing");
    expect(result.combined).not.toMatch(MANUAL_STEP);
  });

  it("proposes the restore in --plan instead of a manual step, and --plan changes nothing", () => {
    const targetDir = makeDeployment({});

    const result = runRepair(targetDir, ["--plan"]);

    expect(result.stdout).not.toContain("action=manual resolves=managed-file-missing");
    expect(result.combined).not.toMatch(MANUAL_STEP);
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(false);
  });

  it("never touches .env-orbit while restoring", () => {
    const targetDir = makeDeployment({});
    const before = snapshot(join(targetDir, ".env-orbit"));

    runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(snapshot(join(targetDir, ".env-orbit"))).toEqual(before);
  });

  it("a second run finds nothing to restore and leaves the restored file as it was", () => {
    const targetDir = makeDeployment({});
    runRepair(targetDir, ["--execute", "--safe-only"]);
    const restored = join(targetDir, "docker-compose.yml");
    expect(existsSync(restored), "first run did not restore docker-compose.yml").toBe(true);
    const before = snapshot(restored);

    const second = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(snapshot(restored)).toEqual(before);
    expect(composeFindings(second.stdout)).toEqual([]);
    expect(second.stdout).not.toContain("managed-file-missing");
  });
});

describe("repair.sh reports, but never replaces, a docker-compose.yml that differs from the image (#1484)", () => {
  it("--check names the difference in a finding ", () => {
    const targetDir = makeDeployment({ compose: EDITED_COMPOSE });

    const result = runRepair(targetDir, ["--check"]);

    expect(composeFindings(result.stdout).length, `no Compose-file finding.\n${result.combined}`).toBeGreaterThan(0);
    // "Shows what differs": the operator's own line is in the output.
    expect(result.combined).toContain("DELIBERATE-EDIT-1484");
  });

  it("--execute --safe-only leaves an edited file byte-identical (content, mode, mtime)", () => {
    const targetDir = makeDeployment({ compose: EDITED_COMPOSE });
    const composePath = join(targetDir, "docker-compose.yml");
    const before = snapshot(composePath);

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(snapshot(composePath)).toEqual(before);
    expect(readFileSync(composePath).equals(EDITED_COMPOSE)).toBe(true);
    // Still reported after the run, not silently dropped.
    expect(composeFindings(result.stdout).length).toBeGreaterThan(0);
  });

  it("does not replace the edited file even when the operator confirms everything it asks", () => {
    const targetDir = makeDeployment({ compose: EDITED_COMPOSE });

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(result.stdout).not.toMatch(/execute action=restore[a-z-]*compose[a-z-]* .*result=done/);
    expect(readFileSync(join(targetDir, "docker-compose.yml")).equals(EDITED_COMPOSE)).toBe(true);
    expect(existsSync(join(targetDir, "docker-compose.yml.orig"))).toBe(false);
  });

  it("does not touch .env-orbit when it reports drift", () => {
    const targetDir = makeDeployment({ compose: EDITED_COMPOSE });
    const before = snapshot(join(targetDir, ".env-orbit"));

    runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(snapshot(join(targetDir, ".env-orbit"))).toEqual(before);
  });
});

describe("repair.sh does nothing about an identical docker-compose.yml (#1484)", () => {
  it("raises no Compose-file finding and rewrites nothing", () => {
    const targetDir = makeDeployment({ compose: IMAGE_COMPOSE });
    const composePath = join(targetDir, "docker-compose.yml");
    const before = snapshot(composePath);

    const check = runRepair(targetDir, ["--check"]);
    const execute = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(composeFindings(check.stdout)).toEqual([]);
    expect(composeFindings(execute.stdout)).toEqual([]);
    expect(check.stdout).not.toContain("managed-file-missing");
    expect(snapshot(composePath)).toEqual(before);
  });
});

describe("repair.sh keeps today's manual step when the image cannot be read (#1484)", () => {
  it("a missing docker-compose.yml with the image unavailable stays missing and stays a manual step", () => {
    const targetDir = makeDeployment({});

    const result = runRepair(targetDir, ["--execute", "--safe-only"], { imageReadable: false });

    expect(result.stdout).toContain("execute action=manual resolves=managed-file-missing result=skipped");
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(false);

    const plan = runRepair(targetDir, ["--plan"], { imageReadable: false });
    expect(plan.stdout).toContain("plan action=manual resolves=managed-file-missing");
    expect(plan.combined).toMatch(MANUAL_STEP);
  });

  it("an image that lacks docker-compose.yml is treated as unreadable, not as an empty file", () => {
    const targetDir = makeDeployment({});

    const result = runRepair(targetDir, ["--execute", "--safe-only"], { image: null });

    expect(result.stdout).toContain("execute action=manual resolves=managed-file-missing result=skipped");
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(false);
  });

  it("a present docker-compose.yml with the image unavailable is not reported as drifted", () => {
    const targetDir = makeDeployment({ compose: EDITED_COMPOSE });

    const result = runRepair(targetDir, ["--check"], { imageReadable: false });

    expect(composeFindings(result.stdout)).toEqual([]);
    expect(readFileSync(join(targetDir, "docker-compose.yml")).equals(EDITED_COMPOSE)).toBe(true);
  });
});

describe("docs/administrator-operations.md describes what Repair does with the Compose file (#1484)", () => {
  // Paragraphs (blank-line separated blocks, list items included) that talk
  // about Repair and the Compose file together.
  const relevant = operationsGuide
    .split(/\n\s*\n/)
    .filter((block) => /repair/i.test(block) && /docker-compose\.yml|compose file/i.test(block))
    .join("\n\n");

  it("has a passage about Repair and the Compose file", () => {
    expect(relevant, "no paragraph mentions both Repair and docker-compose.yml").not.toBe("");
  });

  it("says a missing Compose file is restored from the image", () => {
    expect(relevant).toMatch(/missing/i);
    expect(relevant).toMatch(/restor/i);
    expect(relevant).toMatch(/\bimage\b/i);
  });

  it("says a deliberate edit is reported and never overwritten", () => {
    expect(relevant).toMatch(/deliberate/i);
    expect(relevant).toMatch(/report/i);
    expect(relevant).toMatch(/never\s+(overwr[a-z]*|replac[a-z]*)/i);
  });
});
