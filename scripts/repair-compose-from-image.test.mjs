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

  it("O-SEC1: strips control characters from allow-listed drift lines before printing them", () => {
    const hostile = Buffer.from(
      ["name: orbit", "services:", "  orbit-app:", "    restart: unless-stopped\x1b[31mRED\x07\rSPOOF", ""].join("\n"),
      "utf8",
    );
    const targetDir = makeDeployment({ compose: hostile });

    const result = runRepair(targetDir, ["--check"]);

    expect(result.stderr).toContain("restart: unless-stopped");
    // eslint-disable-next-line no-control-regex
    expect(result.stderr).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
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

// #1584 D-F1: the "READ-ONLY BY CONSTRUCTION" header is the allowlist of what diagnosis may ask
// the Docker daemon for. It once said every `docker` call was an inspect-class read; the
// diagnosis also runs two throwaway containers (the Compose-file read here, and
// `configure.sh --check`'s engine). A reader trusting the old text (a verb-restricted socket
// proxy, an audit of what runs on a production daemon) was told something false. These tests
// hold the paragraph and the code to each other.
describe("repair.sh's read-only contract says what diagnosis actually runs (#1584)", () => {
  // From the heading line to the next heading (`# Database credential handling`), comment
  // markers removed and whitespace folded, so wrapping does not matter.
  const contract = (() => {
    const all = repairScriptSource.split("\n");
    const start = all.findIndex((line) => /^#\s*READ-ONLY BY CONSTRUCTION/.test(line));
    expect(start, "repair.sh no longer has the READ-ONLY BY CONSTRUCTION heading").toBeGreaterThan(-1);
    const end = all.findIndex((line, index) => index > start && /^#\s*Database credential handling\s*$/.test(line));
    expect(end, "repair.sh no longer has the Database credential handling heading after it").toBeGreaterThan(start);
    return all
      .slice(start, end)
      .map((line) => line.replace(/^#\s?/, ""))
      .join(" ")
      .replace(/\s+/g, " ");
  })();

  it("names the throwaway container that reads the Compose file out of the image", () => {
    expect(contract).toContain("docker run --rm --pull never --network none --entrypoint cat");
  });

  it("names the configuration check, which runs the engine in a container", () => {
    expect(contract).toContain("configure.sh --check");
  });

  it("says what a Docker endpoint that refuses `run` costs", () => {
    const sentences = contract.split(/(?<=[.:;])\s+/);
    const costed =
      contract.includes("stays managed-file-missing") ||
      sentences.some((sentence) => /compose/i.test(sentence) && /manual/i.test(sentence));
    expect(costed, "no sentence ties the Compose file and a manual step to a refused run").toBe(true);
  });

  it("no longer claims that every docker invocation is an inspect-class read", () => {
    expect(contract).not.toMatch(/Every\s+`?docker`?\s+invocation is one of/);
  });

  // The configuration check's container sees the whole deployment directory (secrets
  // included), read-only; the paragraph must say so rather than claim no deployment file is touched.
  it("does not claim the containers touch no deployment file, and says the secrets are mounted read-only", () => {
    expect(contract).not.toContain("touch no volume and no deployment file");
    const sentences = contract.split(/(?<=[.:;])\s+/);
    const mountSentence = sentences.some(
      (sentence) => /read-only|:ro\b/.test(sentence) && /mount/.test(sentence) && /\.orbit-secrets|secrets/.test(sentence),
    );
    expect(mountSentence, "no sentence names the read-only mount of the deployment directory and its secrets").toBe(true);
  });

  // The two containers differ: the Compose-file read mounts nothing, the configuration check
  // bind-mounts the deployment directory read-only. A line that covers both must not say "no
  // volume" / "no mount"; each container's mounts are stated on its own.
  it("the shared line about both throwaway containers names no mount for both", () => {
    const start = contract.indexOf("two throwaway containers");
    expect(start, "the contract no longer introduces the two throwaway containers").toBeGreaterThan(-1);
    const first = contract.indexOf("the configuration check", start);
    expect(first, "the contract no longer describes the configuration check container").toBeGreaterThan(start);
    const shared = contract.slice(start, first);
    expect(shared, "the shared line says both containers get no volume or mount").not.toMatch(/no (volume|mount)/i);

    const composeStart = contract.indexOf("the Compose-file read,", first);
    expect(composeStart, "the contract no longer describes the Compose-file read container on its own").toBeGreaterThan(first);
    const composeRead = contract.slice(composeStart, composeStart + 400);
    expect(composeRead, "the Compose-file read's own description does not say it mounts nothing").toMatch(/mounts nothing/i);
  });

  it("names the .orbit-image pin that configure.sh resolves first, as the image source the never-pull guard checks", () => {
    expect(contract).toContain(".orbit-image");
  });

  it("lists docker info among the reads", () => {
    expect(contract).toContain("docker info");
  });
});

// The behavioural half of the same contract. This fixture has no scripts/configure.sh, so
// Step 5 is skipped and the only container run is the Compose-file read. The pieces of the
// paragraph that stay true: that read is a `--rm`, `--pull never`, `--network none` cat, and
// diagnosis never creates, copies out of, removes, starts, stops, pulls or composes up anything.
// (T2.3: the refused-run behaviour the paragraph promises is the two cases above, "keeps
// today's manual step when the image cannot be read".)
describe.each([["--check"], ["--plan"]])("repair.sh %s reads the Compose file only through the throwaway cat run (#1584)", (mode) => {
  it("every container run is a --rm --pull never --network none cat of the Compose file, and no mutating verb is used", () => {
    const targetDir = makeDeployment({ compose: IMAGE_COMPOSE });

    const result = runRepair(targetDir, [mode]);

    const argvs = lines(result.dockerLog);
    const runs = argvs.filter((argv) => /^run(\s|$)/.test(argv));
    expect(runs.length, "diagnosis did not read the image's Compose file").toBeGreaterThanOrEqual(1);
    for (const argv of runs) {
      for (const part of ["--rm", "--pull never", "--network none", "--entrypoint cat"]) {
        expect(argv, `docker run lacks ${part}`).toContain(part);
      }
      expect(argv.endsWith(`${PINNED_IMAGE} ${DEPLOY_ROOT}/docker-compose.yml`), `unexpected run: ${argv}`).toBe(true);
    }
    expect(argvs.filter((argv) => /^(create|cp|rm|start|stop|pull|exec)(\s|$)|^compose\b.*\bup\b/.test(argv))).toEqual([]);
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

// Review findings for #1484, rewritten for #1607 O-R1: the drift report is
// deny-by-default. Each differing line is a comment (hidden whole), a line on
// an allow-listed key (shown in full), a keyed line (key named, value hidden),
// or anything else (hidden whole). It must also stay short. Values are fake.
describe("repair.sh --check drift report hides credentials and stays short (#1484 review)", () => {
  const HIDDEN = "(value hidden)";

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

  // The listing's own lines: the ones the diff marks with `<`.
  const listed = (result) => lines(result.combined).filter((l) => l.startsWith("<"));
  const wholeLineHidden = (l) => /^<\s*\(line hidden\)\s*$/.test(l);
  const commentHidden = (l) => /^<\s+# \(comment hidden\)\s*$/.test(l);

  it("never prints a DB_PASSWORD value, and says the value is hidden", () => {
    const result = check(["      DB_PASSWORD: hunter2-not-real"]);

    expect(composeFindings(result.stdout).length, `no Compose-file finding.\n${result.combined}`).toBeGreaterThan(0);
    expect(result.stdout).not.toContain("hunter2-not-real");
    expect(result.stderr).not.toContain("hunter2-not-real");
    const hidden = lines(result.combined).find((l) => l.includes(`DB_PASSWORD: ${HIDDEN}`));
    expect(hidden, `no 'DB_PASSWORD: ${HIDDEN}' text in:\n${result.combined}`).toBeDefined();
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
  ])("names the key and hides the value, keyword or not (%s)", (_label, line) => {
    const key = line.trim().split(":")[0];
    const value = line.split(": ")[1];
    const result = check([line]);

    expect(result.combined).not.toContain(value);
    expect(result.combined).toContain(`${key}: ${HIDDEN}`);
  });

  it("hides a URL carrying credentials even when the line has no keyword", () => {
    const result = check(["      DATABASE_URL: postgres://orbit:s3cr3t-not-real@db:5432/orbit"]);

    expect(composeFindings(result.stdout).length, `no Compose-file finding.\n${result.combined}`).toBeGreaterThan(0);
    expect(result.combined).not.toContain("s3cr3t-not-real");
    expect(result.combined).not.toContain("orbit:");
    expect(result.combined).toContain(`DATABASE_URL: ${HIDDEN}`);
  });

  it("names a harmless environment line by its key only", () => {
    const result = check(["      LOG_LEVEL: harmless-not-real"]);

    expect(result.combined).toContain(`LOG_LEVEL: ${HIDDEN}`);
    expect(result.combined).not.toContain("harmless-not-real");
  });

  it("shows an allow-listed structural line in full", () => {
    const result = check(["    mem_limit: 3g-not-real"]);

    expect(result.combined).toContain("    mem_limit: 3g-not-real");
    expect(result.combined).not.toContain(HIDDEN);
    expect(result.combined).not.toContain("(line hidden)");
  });

  it("shows exactly 20 differing lines and says more were not shown when there are more than 20", () => {
    const extra = Array.from({ length: 30 }, (_, i) => `    image: example.invalid/extra-line-${String(i + 1).padStart(2, "0")}`);
    const result = check(extra);

    const shown = lines(result.combined).filter((l) => /extra-line-\d+/.test(l));
    expect(shown).toHaveLength(20);
    expect(result.combined).toContain("(more differences not shown)");
  });

  it("shows all 20 lines and no 'more' note when there are exactly 20", () => {
    const extra = Array.from({ length: 20 }, (_, i) => `    image: example.invalid/extra-line-${String(i + 1).padStart(2, "0")}`);
    const result = check(extra);

    const shown = lines(result.combined).filter((l) => /extra-line-\d+/.test(l));
    expect(shown).toHaveLength(20);
    expect(result.combined).not.toContain("(more differences not shown)");
  });

  it("cuts a long differing line to 200 bytes", () => {
    const result = check([`    image: example.invalid/${"q".repeat(400)}`]);

    expect(result.combined).toContain("q".repeat(150));
    expect(result.combined).not.toContain("q".repeat(201));
  });

  // New for #1607 O-R1.

  it("names SMTP_PASS, DOCUMENT_KEK and AUTH_BEARER and prints none of their values (the finding)", () => {
    const result = check([
      "      SMTP_PASS: fake-smtp-pass-1607",
      "      DOCUMENT_KEK: fake-kek-value-1607",
      "      - AUTH_BEARER=fake-bearer-1607",
    ]);

    expect(composeFindings(result.stdout).length, `no Compose-file finding.\n${result.combined}`).toBeGreaterThan(0);
    for (const value of ["fake-smtp-pass-1607", "fake-kek-value-1607", "fake-bearer-1607"]) {
      expect(result.combined, `${value} was printed`).not.toContain(value);
    }
    expect(result.combined).toContain(`SMTP_PASS: ${HIDDEN}`);
    expect(result.combined).toContain(`DOCUMENT_KEK: ${HIDDEN}`);
    expect(result.combined).toContain(`- AUTH_BEARER= ${HIDDEN}`);
  });

  it("hides bare base64 items, an empty KEY= and a bare item whole, never showing a prefix of them", () => {
    const result = check([
      "      - c2VjcmV0LXZhbHVlLTE2MDc=",
      "      - c2Vj==",
      "      - EMPTY_KEY=",
      "      - bare-item-1607",
    ]);

    expect(composeFindings(result.stdout).length, `no Compose-file finding.\n${result.combined}`).toBeGreaterThan(0);
    for (const fragment of ["bare-item-1607", "c2VjcmV0", "c2Vj", "EMPTY_KEY"]) {
      expect(result.combined, `${fragment} was printed`).not.toContain(fragment);
    }
    expect(listed(result).filter(wholeLineHidden), `want 4 '(line hidden)' lines in:\n${result.combined}`).toHaveLength(4);
  });

  it("hides a comment whole and labels it as a comment", () => {
    const result = check(["    # note fake-comment-secret-1607"]);

    expect(composeFindings(result.stdout).length, `no Compose-file finding.\n${result.combined}`).toBeGreaterThan(0);
    expect(result.combined).not.toContain("fake-comment-secret-1607");
    expect(listed(result).some(commentHidden), `no '# (comment hidden)' line in:\n${result.combined}`).toBe(true);
  });

  it("hides a comment whole even when it looks like an allow-listed key", () => {
    // The comment shape is tested first: `# image: ...` is a comment, not an image line.
    const result = check(["    # image: fake-comment-image-1607"]);

    expect(result.combined).not.toContain("fake-comment-image-1607");
    expect(listed(result).some(commentHidden), `no '# (comment hidden)' line in:\n${result.combined}`).toBe(true);
  });

  it("hides a volume line whole: its host path is not a key", () => {
    const result = check(["      - /srv/fake-1607:/data"]);

    expect(composeFindings(result.stdout).length, `no Compose-file finding.\n${result.combined}`).toBeGreaterThan(0);
    expect(result.combined).not.toContain("fake-1607");
    expect(listed(result).some(wholeLineHidden), `no '(line hidden)' line in:\n${result.combined}`).toBe(true);
  });

  it("hides a quoted port item whole", () => {
    const result = check(['      - "18080:18081"']);

    expect(result.combined).not.toContain("18080");
    expect(listed(result).some(wholeLineHidden), `no '(line hidden)' line in:\n${result.combined}`).toBe(true);
  });

  it("hides a list item URL with user details whole: https: is followed by a slash, not a space", () => {
    const result = check(["      - https://fakeuser-1607:fakepass-1607@fake-host.invalid/path"]);

    expect(result.combined).not.toContain("fakeuser-1607");
    expect(result.combined).not.toContain("fakepass-1607");
    expect(listed(result).some(wholeLineHidden), `no '(line hidden)' line in:\n${result.combined}`).toBe(true);
  });

  it("names a quoted key and hides its value", () => {
    const result = check(['      "QUOTED_KEY_1607": fake-quoted-value-1607']);

    expect(result.combined).not.toContain("fake-quoted-value-1607");
    expect(result.combined).toContain("QUOTED_KEY_1607");
    expect(result.combined).toContain(HIDDEN);
  });

  it("shows a bare block-opening key in full", () => {
    const result = check(["    fake_block_1607:"]);

    expect(listed(result).some((l) => l.includes("    fake_block_1607:") && !l.includes("hidden")), `no full block key in:\n${result.combined}`).toBe(true);
    expect(result.combined).not.toContain(HIDDEN);
    expect(result.combined).not.toContain("(line hidden)");
  });

  it.each([
    "image",
    "restart",
    "mem_limit",
    "container_name",
    "pull_policy",
    "read_only",
    "init",
    "user",
    "cpus",
    "name",
    "profiles",
    "stop_grace_period",
  ])("shows a line on the allow-listed key %s in full", (key) => {
    const line = `    ${key}: fake-allowed-value-1607`;
    const result = check([line]);

    expect(listed(result).some((l) => l.includes(line)), `no full '${line}' line in:\n${result.combined}`).toBe(true);
    expect(result.combined).not.toContain(HIDDEN);
    expect(result.combined).not.toContain("(line hidden)");
  });

  it("hides the value of a key that only starts with an allow-listed name", () => {
    // The allow-list matches the whole key: `imagefake` is not `image`.
    const result = check(["    imagefake: fake-near-miss-1607", "    userx: fake-near-miss-1608"]);

    expect(result.combined).not.toContain("fake-near-miss-1607");
    expect(result.combined).not.toContain("fake-near-miss-1608");
    expect(result.combined).toContain(`imagefake: ${HIDDEN}`);
    expect(result.combined).toContain(`userx: ${HIDDEN}`);
  });

  it("counts hidden lines toward the 20-line cap", () => {
    const extra = Array.from({ length: 30 }, (_, i) => `    # note-${String(i + 1).padStart(2, "0")}`);
    const result = check(extra);

    expect(listed(result).filter(commentHidden)).toHaveLength(20);
    expect(result.combined).not.toMatch(/note-\d+/);
    expect(result.combined).toContain("(more differences not shown)");
  });
});

// #1607 O-R1: the drift listing is deny-by-default. A keyword hide-list misses
// credentials under names it does not list (DOCUMENT_KEK, SMTP_PASS, a bearer
// value), so each differing line shows its key only, and its value only for
// the image reference and a few structural keys. Values here are fake.
describe("repair.sh --check drift report names keys and hides every value but the image's (#1607 O-R1)", () => {
  // The edited file: its own image line (a structural key, shown in full), then
  // credentials inline under names the keyword list does not cover. The
  // worker's environment is a list, the app's a map; both are valid Compose.
  const FAKE_VALUES = ["fake-smtp-pass-1607", "fake-kek-value-1607", "fake-bearer-1607"];
  const composeWithCredentials = () =>
    Buffer.from(
      [
        "name: orbit",
        "services:",
        "  orbit-app:",
        EDIT_MARKER,
        "    restart: unless-stopped",
        "    environment:",
        "      SMTP_PASS: fake-smtp-pass-1607",
        "      DOCUMENT_KEK: fake-kek-value-1607",
        "  orbit-worker:",
        "    environment:",
        "      - AUTH_BEARER=fake-bearer-1607",
        "      - fake-bare-item-1607",
        "",
      ].join("\n"),
      "utf8",
    );

  it("prints none of the three credential values, and still names SMTP_PASS, DOCUMENT_KEK and AUTH_BEARER", () => {
    // Fails today: the hide-list has no rule for these names, so every value is printed.
    const targetDir = makeDeployment({ compose: composeWithCredentials() });
    const result = runRepair(targetDir, ["--check"]);

    expect(composeFindings(result.stdout).length, `no Compose-file finding.\n${result.combined}`).toBeGreaterThan(0);
    for (const value of FAKE_VALUES) expect(result.combined, `${value} was printed`).not.toContain(value);
    for (const key of ["SMTP_PASS", "DOCUMENT_KEK", "AUTH_BEARER"]) expect(result.combined, `${key} is not named`).toContain(key);
  });

  it("hides a differing line that has no key shape whole", () => {
    // Fails today: a bare list item is not on the hide-list and is printed.
    const targetDir = makeDeployment({ compose: composeWithCredentials() });
    const result = runRepair(targetDir, ["--check"]);

    expect(composeFindings(result.stdout).length, `no Compose-file finding.\n${result.combined}`).toBeGreaterThan(0);
    expect(result.combined).not.toContain("fake-bare-item-1607");
  });

  it("still shows the folder's image: line in full, so the operator's own line is in the output", () => {
    // Passes today and must keep passing: the image reference is the one value the listing exists to show.
    const targetDir = makeDeployment({ compose: composeWithCredentials() });
    const result = runRepair(targetDir, ["--check"]);

    expect(composeFindings(result.stdout).length, `no Compose-file finding.\n${result.combined}`).toBeGreaterThan(0);
    expect(lines(result.combined).some((l) => l.startsWith("<") && l.includes(EDIT_MARKER.trim())), `no full image line in:\n${result.combined}`).toBe(true);
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
