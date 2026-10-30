import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
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
//
// #1558 hooks (all optional, the defaults keep every older case as it was):
// `label` is what the image's io.orbit.deployment-assets label reads;
// `labelAfterRun` replaces it once one `docker run` has happened (the
// diagnosis read the file, then the label changed); `raceHook` is a bash
// snippet run inside every `docker run`, with $n the 1-based run count, to
// make something appear on disk at a chosen moment.
function writeFakeDocker(
  binDir,
  { imageDir, logPath, imageReadable, label = DEPLOY_ROOT, labelAfterRun, raceHook = "" },
) {
  const script = `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> '${logPath}'
readable=${imageReadable ? 1 : 0}
image_dir='${imageDir}'
deploy_root='${DEPLOY_ROOT}'
runs_file='${logPath}.runs'
label='${label}'
runs_so_far="$(cat "$runs_file" 2>/dev/null || echo 0)"
${labelAfterRun === undefined ? "" : `if [[ "$runs_so_far" -ge 1 ]]; then label='${labelAfterRun}'; fi`}

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
      printf '%s\\n' "$label"
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
    n=$((runs_so_far + 1))
    echo "$n" > "$runs_file"
    # A run while the restore's temporary file exists in the folder is the restore's own read.
    if compgen -G "$PWD/.docker-compose.yml.repair.*" >/dev/null; then echo restore-read >> '${logPath}.restore-reads'; fi
    ${raceHook}
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
function runRepair(targetDir, args, { imageReadable = true, image = IMAGE_COMPOSE, ...dockerOptions } = {}) {
  const binDir = scratchDir("orbit-repair-compose-bin-");
  const imageDir = scratchDir("orbit-repair-compose-image-");
  if (image !== null) writeFileSync(join(imageDir, "docker-compose.yml"), image);
  const logPath = join(binDir, "docker-argv.log");
  writeFileSync(logPath, "");
  writeFakeDocker(binDir, { imageDir, logPath, imageReadable, ...dockerOptions });
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
  const restoreReadsPath = `${logPath}.restore-reads`;
  const restoreReads = existsSync(restoreReadsPath) ? lines(readFileSync(restoreReadsPath, "utf8")).length : 0;
  return { ...result, dockerLog: readFileSync(logPath, "utf8"), restoreReads, combined: `${result.stdout}\n${result.stderr}` };
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

// Review findings for #1484: the drift report must show what differs without
// printing anything that looks like a credential, and must stay short.
describe("repair.sh --check drift report hides credentials and stays short (#1484 review)", () => {
  const HIDDEN = "(line hidden: it looks like a credential)";

  // The image's compose file with extra lines added to the deployment folder's copy.
  function composeWithExtra(extra) {
    const text = IMAGE_COMPOSE.toString("utf8").split("\n");
    text.splice(text.indexOf("services:") + 1, 0, ...extra);
    return Buffer.from(text.join("\n"), "utf8");
  }

  function check(extra) {
    const targetDir = makeDeployment({ compose: composeWithExtra(extra) });
    return runRepair(targetDir, ["--check"]);
  }

  it("never prints a DB_PASSWORD value, and says the line is hidden", () => {
    const result = check(["      DB_PASSWORD: hunter2-not-real"]);

    expect(composeFindings(result.stdout).length, `no Compose-file finding.\n${result.combined}`).toBeGreaterThan(0);
    expect(result.stdout).not.toContain("hunter2-not-real");
    expect(result.stderr).not.toContain("hunter2-not-real");
    const hidden = lines(result.combined).find((l) => l.includes(HIDDEN));
    expect(hidden, `no hidden-line text in:\n${result.combined}`).toBeDefined();
    expect(hidden).toContain("<");
  });

  it.each([
    ["secret", "      SESSION_SECRET: zz-secret-value-not-real"],
    ["token", "      AUTH_TOKEN: zz-token-value-not-real"],
    ["passphrase", "      KEY_PASSPHRASE: zz-passphrase-value-not-real"],
    ["api_key", "      API_KEY: zz-apikey-value-not-real"],
    ["api-key", "      x-api-key: zz-apikeyhyphen-value-not-real"],
    ["private_key", "      PRIVATE_KEY: zz-privatekey-value-not-real"],
    ["upper-case keyword", "      MY_SECRET: ZZ-UPPER-VALUE-NOT-REAL"],
  ])("hides a %s line (case-insensitive)", (_label, line) => {
    const value = line.split(": ")[1];
    const result = check([line]);

    expect(result.combined).not.toContain(value);
    expect(result.combined).toContain(HIDDEN);
  });

  it("hides a URL carrying credentials even when the line has no keyword", () => {
    const result = check(["      DATABASE_URL: postgres://orbit:s3cr3t-not-real@db:5432/orbit"]);

    expect(composeFindings(result.stdout).length, `no Compose-file finding.\n${result.combined}`).toBeGreaterThan(0);
    expect(result.combined).not.toContain("s3cr3t-not-real");
  });

  it("shows a harmless differing line as it is", () => {
    const result = check(["      LOG_LEVEL: harmless-not-real"]);

    expect(result.combined).toContain("harmless-not-real");
    expect(result.combined).not.toContain(HIDDEN);
    expect(result.combined).not.toContain("(more differences not shown)");
  });

  it("shows exactly 20 differing lines and says more were not shown when there are more than 20", () => {
    const extra = Array.from({ length: 30 }, (_, i) => `    # extra-line-${String(i + 1).padStart(2, "0")}`);
    const result = check(extra);

    const shown = lines(result.combined).filter((l) => /extra-line-\d+/.test(l));
    expect(shown).toHaveLength(20);
    expect(result.combined).toContain("(more differences not shown)");
  });

  it("shows all 20 lines and no 'more' note when there are exactly 20", () => {
    const extra = Array.from({ length: 20 }, (_, i) => `    # extra-line-${String(i + 1).padStart(2, "0")}`);
    const result = check(extra);

    const shown = lines(result.combined).filter((l) => /extra-line-\d+/.test(l));
    expect(shown).toHaveLength(20);
    expect(result.combined).not.toContain("(more differences not shown)");
  });

  it("cuts a long differing line to 200 bytes", () => {
    const result = check([`    # ${"q".repeat(400)}`]);

    expect(result.combined).toContain("q".repeat(150));
    expect(result.combined).not.toContain("q".repeat(201));
  });
});

// #1558 (review of #1484): repair.sh must not trust an image whose
// io.orbit.deployment-assets label is wrong or empty, and a file or symlink
// that appears where docker-compose.yml should go must never be overwritten.
describe("repair.sh does not trust an image with a wrong or empty deployment-assets label (#1558)", () => {
  // The fake image does hold the file under DEPLOY_ROOT, so a repair that
  // ignored the label would restore it: only the label check stops that.
  const BAD_LABELS = [
    ["empty", ""],
    ["blank", "   "],
    ["names another directory", "/opt/orbit/other"],
    ["names a lookalike directory", "/opt/orbit/deploy-evil"],
    ["is a relative path", "opt/orbit/deploy"],
    ["climbs out with ..", "/opt/orbit/deploy/../../etc"],
    ["is not a path at all", "not a path; rm -rf /"],
    ["is the unset-label placeholder", "<no value>"],
  ];

  function dockerRuns(log) {
    return lines(log).filter((argv) => /^run(\s|$)/.test(argv));
  }

  it.each(BAD_LABELS)("a missing docker-compose.yml is not restored when the label %s", (_name, label) => {
    const targetDir = makeDeployment({});

    const result = runRepair(targetDir, ["--execute", "--safe-only"], { label });

    expect(existsSync(join(targetDir, "docker-compose.yml")), result.combined).toBe(false);
    expect(result.stdout).toContain("execute action=manual resolves=managed-file-missing result=skipped");
    expect(result.stdout).not.toContain("compose-file-restorable");
    expect(dockerRuns(result.dockerLog), "the image was read despite its label").toEqual([]);
  });

  it.each(BAD_LABELS)("a present docker-compose.yml is not compared with the image when the label %s", (_name, label) => {
    const targetDir = makeDeployment({ compose: EDITED_COMPOSE });

    const result = runRepair(targetDir, ["--check"], { label });

    expect(composeFindings(result.stdout)).toEqual([]);
    expect(dockerRuns(result.dockerLog), "the image was read despite its label").toEqual([]);
    expect(readFileSync(join(targetDir, "docker-compose.yml")).equals(EDITED_COMPOSE)).toBe(true);
  });

  it("the restore itself refuses when the label turns wrong after the diagnosis read the image", () => {
    const targetDir = makeDeployment({});

    // Run 1 is the diagnosis reading the image; the label changes after it.
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { labelAfterRun: "/opt/orbit/other" });

    expect(existsSync(join(targetDir, "docker-compose.yml")), result.combined).toBe(false);
    expect(result.stdout).toContain("execute action=restore-compose-file resolves=compose-file-restorable result=failed");
    expect(result.status).toBe(4);
    expect(dockerRuns(result.dockerLog)).toHaveLength(1);
    expect(readdirSync(targetDir).filter((name) => name.includes(".repair."))).toEqual([]);
  });
});

describe("repair.sh never overwrites a file or symlink that appears before the restore (#1558)", () => {
  const RACE_CONTENT = "# written by someone else while repair was deciding";
  const leftovers = (targetDir) => readdirSync(targetDir).filter((name) => name.includes(".repair."));

  // Each case: the shell that makes the thing appear, and how to check it afterwards.
  function appearances(targetDir) {
    const dest = join(targetDir, "docker-compose.yml");
    const elsewhere = scratchDir("orbit-repair-compose-elsewhere-");
    const realTarget = join(elsewhere, "real-target.yml");
    writeFileSync(realTarget, RACE_CONTENT);
    return [
      {
        name: "a regular file",
        create: `printf '%s' '${RACE_CONTENT}' > '${dest}'`,
        verify() {
          expect(lstatSync(dest).isSymbolicLink()).toBe(false);
          expect(readFileSync(dest, "utf8")).toBe(RACE_CONTENT);
        },
      },
      {
        name: "a symlink to an existing file",
        create: `ln -s '${realTarget}' '${dest}'`,
        verify() {
          expect(lstatSync(dest).isSymbolicLink()).toBe(true);
          expect(readlinkSync(dest)).toBe(realTarget);
          expect(readFileSync(realTarget, "utf8")).toBe(RACE_CONTENT);
        },
      },
      {
        name: "a dangling symlink",
        create: `ln -s '${join(elsewhere, "nowhere.yml")}' '${dest}'`,
        verify() {
          expect(lstatSync(dest).isSymbolicLink()).toBe(true);
          expect(readlinkSync(dest)).toBe(join(elsewhere, "nowhere.yml"));
          expect(existsSync(join(elsewhere, "nowhere.yml"))).toBe(false);
        },
      },
    ];
  }

  const CASES = ["a regular file", "a symlink to an existing file", "a dangling symlink"];

  describe("between the diagnosis and the restore", () => {
    it.each(CASES)("%s is noticed by the re-check and left alone, with the image not read again", (name) => {
      const targetDir = makeDeployment({});
      const appearance = appearances(targetDir).find((a) => a.name === name);

      // Run 1 is the diagnosis reading the image; the thing appears right after.
      const result = runRepair(targetDir, ["--execute", "--safe-only"], {
        raceHook: `if [[ "$n" == 1 ]]; then ${appearance.create}; fi`,
      });

      appearance.verify();
      expect(result.stdout).toContain("execute action=restore-compose-file resolves=compose-file-restorable result=failed");
      expect(result.stdout).not.toMatch(/execute action=restore-compose-file .*result=done/);
      expect(result.status).toBe(4);
      // Stopped at the re-check: the restore never went on to read the image.
      expect(result.restoreReads).toBe(0);
      expect(leftovers(targetDir)).toEqual([]);
    });
  });

  describe("at the moment of the move (the refusing move)", () => {
    it.each(CASES)("%s is kept, the move is refused, and repair reports failed", (name) => {
      const targetDir = makeDeployment({});
      const appearance = appearances(targetDir).find((a) => a.name === name);

      // The restore's own read of the image writes into its temporary file in
      // the folder; the thing appears while that read is under way, so the
      // re-check at the top has already passed.
      const result = runRepair(targetDir, ["--execute", "--safe-only"], {
        raceHook: `if compgen -G '${targetDir}/.docker-compose.yml.repair.*' >/dev/null; then ${appearance.create}; fi`,
      });

      appearance.verify();
      expect(result.stdout).toContain("execute action=restore-compose-file resolves=compose-file-restorable result=failed");
      expect(result.stdout).not.toMatch(/execute action=restore-compose-file .*result=done/);
      expect(result.status).toBe(4);
      // The restore did read the image, so this is the move's refusal, not the re-check.
      expect(result.restoreReads).toBe(1);
      expect(leftovers(targetDir), "the temporary file was left behind").toEqual([]);
    });

    it("leaves the existing file's mode and bytes untouched (not the image's 0644 copy)", () => {
      const targetDir = makeDeployment({});
      const dest = join(targetDir, "docker-compose.yml");

      runRepair(targetDir, ["--execute", "--safe-only"], {
        raceHook: `if compgen -G '${targetDir}/.docker-compose.yml.repair.*' >/dev/null; then printf 'hand-made\\n' > '${dest}'; chmod 0600 '${dest}'; fi`,
      });

      expect(readFileSync(dest, "utf8")).toBe("hand-made\n");
      expect(fileMode(dest)).toBe("600");
    });
  });
});
