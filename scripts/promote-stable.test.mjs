import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

/*
 * scripts/ci/promote-stable.sh runs under bash against stub docker/git/curl
 * on PATH; budget and reasoning: scripts/process-budget.mjs. `node` itself is
 * real -- the script calls the repository's actual scripts/calculate-
 * version.mjs and scripts/stable-promotion-policy.mjs, which is what proves
 * the real version-calculation and merge-base/tree-diff policy logic still
 * agrees with the script's other checks. Both of those only ever shell out to
 * `git`, which is on the stubbed PATH too, so no fixture repository is
 * needed. `PROMOTE_NODE` exists in the script for the same purpose a test
 * override always exists for, but is not used here: stubbing `git` is enough
 * to keep this test hermetic without stubbing `node` itself.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./ci/promote-stable.sh", import.meta.url).pathname;
const workflow = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);

const IMAGE = "ghcr.io/tomlawesome/orbit";
const GOOD_SHA = "a".repeat(40);
const PREVIEW_DIGEST = `sha256:${"1".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"2".repeat(64)}`;
const VERSION = "v1.4.0";
const GHCR_TOKEN = "TEST-GHCR-TOKEN-NOT-REAL";
const GITLAB_TOKEN = "TEST-GITLAB-TOKEN-NOT-REAL";

function sanitize(ref) {
  return ref.replace(/[/:@*]/gu, "_");
}

// A single static `docker` stub (its behaviour is driven entirely by
// STUB_*-prefixed environment variables and a shared "digests" directory, not
// by regenerated script text) so every test exercises the same file. A tag's
// digest is looked up from `<digestsDir>/<sanitized ref>`; `imagetools
// create` writes the digest it was given straight into that same directory,
// so a create followed by an inspect of the tag it just created behaves like
// the real registry would.
const DOCKER_STUB = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'log="$STUB_LOG"',
  'digests_dir="$STUB_DIGESTS_DIR"',
  "sanitize() { printf '%s' \"$1\" | tr '/:@*' '____'; }",
  "",
  'case "$1" in',
  "  buildx)",
  '    case "$3" in',
  "      inspect)",
  '        ref="$4"',
  "        printf 'docker\\x1f%s\\x1e' \"$*\" >> \"$log\"",
  '        case "$ref" in',
  "          *@sha256:*)",
  "            printf 'Digest: %s\\n' \"${ref#*@}\"",
  "            exit 0",
  "            ;;",
  "        esac",
  '        file="$digests_dir/$(sanitize "$ref")"',
  '        if [ -f "$file" ]; then',
  "          printf 'Digest: %s\\n' \"$(cat \"$file\")\"",
  "          exit 0",
  "        fi",
  "        exit 1",
  "        ;;",
  "      create)",
  "        printf 'docker\\x1f%s\\x1e' \"$*\" >> \"$log\"",
  "        shift 3",
  '        src=""',
  "        tags=()",
  '        while [ "$#" -gt 0 ]; do',
  '          case "$1" in',
  '            --tag) tags+=("$2"); shift 2 ;;',
  '            *) src="$1"; shift ;;',
  "          esac",
  "        done",
  '        digest="${src#*@}"',
  '        for tag in "${tags[@]}"; do',
  "          printf '%s' \"$digest\" > \"$digests_dir/$(sanitize \"$tag\")\"",
  "        done",
  "        exit 0",
  "        ;;",
  "    esac",
  "    ;;",
  "  pull)",
  "    printf 'docker\\x1f%s\\x1e' \"$*\" >> \"$log\"",
  "    exit 0",
  "    ;;",
  "  image)",
  "    printf 'docker\\x1f%s\\x1e' \"$*\" >> \"$log\"",
  '    fmt="$4"',
  '    case "$fmt" in',
  "      *revision*) printf '%s' \"${STUB_LABEL_REVISION:-}\" ;;",
  "      *release-stage*) printf '%s' \"${STUB_LABEL_RELEASE_STAGE:-}\" ;;",
  "      *source-branch*) printf '%s' \"${STUB_LABEL_SOURCE_BRANCH:-}\" ;;",
  "      *version*) printf '%s' \"${STUB_LABEL_VERSION:-}\" ;;",
  "    esac",
  "    ;;",
  "  run)",
  "    printf 'docker\\x1f%s\\x1e' \"$*\" >> \"$log\"",
  '    last="${@: -1}"',
  '    case "$last" in',
  "      /opt/orbit/VERSION) printf '%s' \"${STUB_EMBEDDED_VERSION:-}\" ;;",
  "      /opt/orbit/REVISION) printf '%s' \"${STUB_EMBEDDED_REVISION:-}\" ;;",
  "      /opt/orbit/CHANNEL) printf '%s' \"${STUB_EMBEDDED_CHANNEL:-}\" ;;",
  "      --version) printf '%s' \"${STUB_REPORTED_VERSION:-}\" ;;",
  "    esac",
  "    ;;",
  "  login)",
  '    stdin_content="$(cat)"',
  "    printf 'docker\\x1f%s\\x1f<stdin:%s>\\x1e' \"$*\" \"$stdin_content\" >> \"$log\"",
  "    exit 0",
  "    ;;",
  "  *)",
  "    exit 1",
  "    ;;",
  "esac",
  "",
].join("\n");

const GIT_STUB = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'log="$STUB_LOG"',
  'args="$*"',
  "printf 'git\\x1f%s\\x1e' \"$args\" >> \"$log\"",
  'case "$args" in',
  '  "ls-remote --exit-code --tags "*" refs/tags/"*)',
  '    exit "${STUB_TAG_EXISTS_EXIT:-2}"',
  "    ;;",
  '  *"refs/heads/main")',
  "    printf '%s\\trefs/heads/main\\n' \"${STUB_MAIN_HEAD:?}\"",
  "    ;;",
  '  *"refs/heads/preview")',
  "    printf '%s\\trefs/heads/preview\\n' \"${STUB_PREVIEW_HEAD:?}\"",
  "    ;;",
  '  "tag --list v*")',
  "    printf '%s\\n' \"${STUB_TAGS:-}\"",
  "    ;;",
  "  *)",
  "    exit 0",
  "    ;;",
  "esac",
  "",
].join("\n");

// Records argv, inlining the contents of any --header @file the way
// scripts/sidecar-freshness-issue.test.mjs does, so the test can see what was
// sent without the file surviving the script's own cleanup trap.
const CURL_STUB = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  'log="$STUB_LOG"',
  "recorded=()",
  'while [ "$#" -gt 0 ]; do',
  '  arg="$1"',
  '  case "$arg" in',
  "    @*|*'@'/*)",
  '      path="${arg#*@}"',
  '      if [ -f "$path" ]; then',
  '        recorded+=("${arg%%@*}@<$(cat "$path")>")',
  "      else",
  '        recorded+=("$arg")',
  "      fi",
  "      ;;",
  "    *)",
  '      recorded+=("$arg")',
  "      ;;",
  "  esac",
  "  shift",
  "done",
  "printf 'curl\\x1f' >> \"$log\"",
  "printf '%s\\x1f' \"${recorded[@]}\" >> \"$log\"",
  "printf '\\x1e' >> \"$log\"",
  "printf '%s' '{\"name\":\"ok\"}'",
  "exit 0",
  "",
].join("\n");

// Stands in for scripts/ci/gitlab-await-tested-image.sh (#877's evidence
// gate), which promote-stable.sh now runs before promoting. That script's
// own refusals -- missing pipeline/job/artifact, evidence for another
// commit/ref/pipeline/registry, evidence older than seven days -- are
// already driven against the real script with a stub curl in
// scripts/publish-from-gitlab-workflow.test.mjs; this stub is not a second
// copy of that. It exists only to prove two things about the new call site
// in promote-stable.sh: that it is invoked with the right commit, ref,
// registry and token (STUB_EVIDENCE_FAIL unset, happy path -- the default
// every other test in this file relies on to get past the gate), and that a
// refusal from the gate script -- digest mismatch, which is new logic added
// in promote-stable.sh itself, or a refusal propagated unchanged from the
// real script, represented here as STUB_EVIDENCE_FAIL -- stops promotion
// with its message intact rather than being swallowed.
const AWAIT_STUB = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'log="$STUB_LOG"',
  "printf 'await\\x1f%s\\x1f%s\\x1f%s\\x1f%s\\x1f%s\\x1f%s\\x1e' \\",
  '  "$GITLAB_API_URL" "$GITLAB_PROJECT_ID" "$GITLAB_READ_TOKEN" "$GITLAB_REGISTRY" "$ORBIT_COMMIT" "$ORBIT_REF" >> "$log"',
  "",
  'if [ -n "${STUB_EVIDENCE_FAIL:-}" ]; then',
  "  printf 'gitlab-await-tested-image: %s\\n' \"$STUB_EVIDENCE_FAIL\" >&2",
  "  exit 1",
  "fi",
  "",
  'mkdir -p "$ORBIT_EVIDENCE_DIR"',
  'printf \'{"imageDigest":"%s","commit":"%s","ref":"%s"}\' \\',
  '  "${STUB_EVIDENCE_DIGEST:-$PREVIEW_DIGEST}" "$ORBIT_COMMIT" "$ORBIT_REF" \\',
  '  > "$ORBIT_EVIDENCE_DIR/gitlab-tested-image.json"',
  "",
].join("\n");

function makeStubs() {
  const dir = mkdtempSync(join(tmpdir(), "promote-stable-stub-"));
  const digestsDir = join(dir, "digests");
  mkdirSync(digestsDir);
  const logFile = join(dir, "calls.log");
  writeFileSync(logFile, "");

  for (const [name, content] of [
    ["docker", DOCKER_STUB],
    ["git", GIT_STUB],
    ["curl", CURL_STUB],
    ["await", AWAIT_STUB],
  ]) {
    const stubPath = join(dir, name);
    writeFileSync(stubPath, content);
    chmodSync(stubPath, 0o755);
  }

  return {
    dir,
    digestsDir,
    awaitScript: join(dir, "await"),
    seedDigest: (ref, digest) => writeFileSync(join(digestsDir, sanitize(ref)), digest),
    calls: () =>
      readFileSync(logFile, "utf8")
        .split("\x1e")
        .filter(Boolean)
        .map((call) => call.split("\x1f").filter((part) => part.length > 0)),
    logFile,
  };
}

/**
 * Runs the script against a happy-path scenario by default; each option
 * overrides one piece of it so a test can break exactly one check.
 */
function run({
  previewDigestInput = PREVIEW_DIGEST,
  mainHead = GOOD_SHA,
  previewHead = GOOD_SHA,
  previewTagDigest = PREVIEW_DIGEST,
  shaTagDigest = PREVIEW_DIGEST,
  versionTagDigest = null,
  tagExistsOnGitLab = false,
  stableTags = "v1.3.0",
  labelRevision = GOOD_SHA,
  labelVersion = VERSION,
  labelReleaseStage = "preview",
  labelSourceBranch = "preview",
  embeddedVersion = VERSION,
  embeddedRevision = GOOD_SHA,
  embeddedChannel = "preview",
  reportedVersion = `Orbit ${VERSION}`,
  evidenceDigest = null,
  evidenceFail = null,
  env = {},
} = {}) {
  const stubs = makeStubs();
  stubs.seedDigest(`${IMAGE}:preview`, previewTagDigest);
  stubs.seedDigest(`${IMAGE}:sha-${mainHead}`, shaTagDigest);
  if (versionTagDigest) stubs.seedDigest(`${IMAGE}:${labelVersion}`, versionTagDigest);

  const result = failOnProcessDeadline(
    spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        PATH: `${stubs.dir}:${process.env.PATH}`,
        PREVIEW_DIGEST: previewDigestInput,
        CI_API_V4_URL: "https://gitlab.tomlawson.io/api/v4",
        CI_PROJECT_ID: "49",
        GHCR_PUBLISH_TOKEN: GHCR_TOKEN,
        GITLAB_RELEASE_TOKEN: GITLAB_TOKEN,
        CI_REGISTRY: "registry.tomlawson.io",
        PROMOTE_AWAIT_SCRIPT: stubs.awaitScript,
        STUB_LOG: stubs.logFile,
        STUB_DIGESTS_DIR: stubs.digestsDir,
        ...(evidenceDigest ? { STUB_EVIDENCE_DIGEST: evidenceDigest } : {}),
        ...(evidenceFail ? { STUB_EVIDENCE_FAIL: evidenceFail } : {}),
        STUB_MAIN_HEAD: mainHead,
        STUB_PREVIEW_HEAD: previewHead,
        STUB_TAG_EXISTS_EXIT: tagExistsOnGitLab ? "0" : "2",
        STUB_TAGS: stableTags,
        STUB_LABEL_REVISION: labelRevision,
        STUB_LABEL_VERSION: labelVersion,
        STUB_LABEL_RELEASE_STAGE: labelReleaseStage,
        STUB_LABEL_SOURCE_BRANCH: labelSourceBranch,
        STUB_EMBEDDED_VERSION: embeddedVersion,
        STUB_EMBEDDED_REVISION: embeddedRevision,
        STUB_EMBEDDED_CHANNEL: embeddedChannel,
        STUB_REPORTED_VERSION: reportedVersion,
        ...env,
      },
      ...processGuard(),
    }),
    { label: "run" },
  );
  return { result, calls: stubs.calls };
}

describe("scripts/ci/promote-stable.sh", () => {
  it("refuses a missing or malformed PREVIEW_DIGEST, without calling docker or git", () => {
    for (const bad of ["", "not-a-digest", `sha256:${"1".repeat(63)}`, `sha1:${"1".repeat(64)}`]) {
      const { result, calls } = run({ previewDigestInput: bad });
      expect(result.status, bad).not.toBe(0);
      expect(result.stderr, bad).toContain("PREVIEW_DIGEST");
      expect(calls().length, bad).toBe(0);
    }
  });

  it("refuses when main and preview are not the same commit", () => {
    const { result, calls } = run({ mainHead: GOOD_SHA, previewHead: "b".repeat(40) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("are not the same commit");
    expect(calls().some((call) => call[0] === "docker")).toBe(false);
  });

  it("refuses when :preview does not resolve to the accepted digest", () => {
    const { result, calls } = run({ previewTagDigest: OTHER_DIGEST });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${IMAGE}:preview`);
    expect(calls().some((call) => call[0] === "docker" && call[1].startsWith("pull "))).toBe(false);
  });

  it("refuses when :sha-<main HEAD> does not resolve to the accepted digest", () => {
    const { result, calls } = run({ shaTagDigest: OTHER_DIGEST });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${IMAGE}:sha-${GOOD_SHA}`);
    expect(calls().some((call) => call[0] === "docker" && call[1].startsWith("pull "))).toBe(false);
  });

  it("refuses when the embedded version label disagrees with the reported --version", () => {
    const { result, calls } = run({ reportedVersion: "Orbit v9.9.9" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("do not match the image version label");
    expect(
      calls().some((call) => call[0] === "docker" && call[1].startsWith("buildx imagetools create")),
    ).toBe(false);
  });

  it("refuses when the embedded revision disagrees with the revision label", () => {
    const { result } = run({ embeddedRevision: "b".repeat(40) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Embedded revision does not match");
  });

  it("refuses when the embedded channel disagrees with the release-stage label", () => {
    const { result } = run({ embeddedChannel: "hotfix" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Embedded channel does not match");
  });

  it("refuses when the calculated version disagrees with the image's version label", () => {
    // v1.3.0 already stable => the next preview-channel version is v1.4.0,
    // not the v1.9.0 this image claims.
    const { result } = run({ labelVersion: "v1.9.0", embeddedVersion: "v1.9.0", reportedVersion: "Orbit v1.9.0" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match calculated version");
  });

  it("refuses when the GitLab tag already exists, without logging in or tagging", () => {
    const { result, calls } = run({ tagExistsOnGitLab: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("already exists on GitLab");
    expect(calls().some((call) => call[0] === "docker" && call[1].startsWith("login"))).toBe(false);
  });

  it("refuses when the version tag already exists in GHCR, without logging in or tagging", () => {
    const { result, calls } = run({ versionTagDigest: PREVIEW_DIGEST });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("already exists in GHCR");
    expect(calls().some((call) => call[0] === "docker" && call[1].startsWith("login"))).toBe(false);
    expect(
      calls().some((call) => call[0] === "docker" && call[1].startsWith("buildx imagetools create")),
    ).toBe(false);
  });

  it("on the happy path, tags vX.Y.Z and latest in GHCR and creates the GitLab tag", () => {
    const { result, calls } = run();
    expect(result.status, result.stderr).toBe(0);

    const recordedCalls = calls();
    const createCall = recordedCalls.find(
      (call) => call[0] === "docker" && call[1].startsWith("buildx imagetools create"),
    );
    expect(createCall).toBeDefined();
    expect(createCall[1]).toContain(`--tag ${IMAGE}:${VERSION}`);
    expect(createCall[1]).toContain(`--tag ${IMAGE}:latest`);
    expect(createCall[1]).toContain(`${IMAGE}@${PREVIEW_DIGEST}`);
    expect(createCall[1]).not.toContain(":stable");

    const loginCall = recordedCalls.find((call) => call[0] === "docker" && call[1].startsWith("login"));
    expect(loginCall).toBeDefined();
    expect(loginCall[1]).toContain("ghcr.io");
    expect(loginCall[1]).toContain("-u tomlawesome");
    expect(loginCall[2]).toBe(`<stdin:${GHCR_TOKEN}>`);

    const curlCall = recordedCalls.find((call) => call[0] === "curl");
    expect(curlCall).toBeDefined();
    const curlArgs = curlCall.join(" ");
    expect(curlArgs).toContain("projects/49/repository/tags");
    expect(curlArgs).toContain(`tag_name=${VERSION}`);
    expect(curlArgs).toContain(`ref=${GOOD_SHA}`);
    expect(curlArgs).toContain(`message=Orbit ${VERSION}`);
    expect(curlArgs).toContain(`PRIVATE-TOKEN: ${GITLAB_TOKEN}`);

    // Tokens only ever show up inlined from a stubbed file (tagged
    // "name@<...>") or as the piped stdin content recorded above -- never as
    // a bare argv word, which is what proves the real script kept them off
    // the command line. The "await" entries are the exception: gitlab-await-
    // tested-image.sh takes GITLAB_READ_TOKEN as an environment variable, so
    // the stub logs it from the environment (asserted directly by "asks the
    // evidence gate..." above) to prove the right value arrived -- that is a
    // property of this test double, not argv exposure by the real script.
    for (const call of recordedCalls) {
      if (call[0] === "await") continue;
      for (const part of call) {
        if (part.startsWith("<stdin:")) continue;
        if (part.includes("@<")) continue;
        expect(part).not.toBe(GHCR_TOKEN);
        expect(part).not.toBe(GITLAB_TOKEN);
        if (!part.includes("<")) {
          expect(part).not.toContain(GHCR_TOKEN);
          expect(part).not.toContain(GITLAB_TOKEN);
        }
      }
    }
  });

  it("promotes a hotfix/* preview using the hotfix channel", () => {
    const { result, calls } = run({
      labelSourceBranch: "hotfix/1.3.1",
      labelVersion: "v1.3.1",
      embeddedVersion: "v1.3.1",
      reportedVersion: "Orbit v1.3.1",
      stableTags: "v1.3.0",
    });
    expect(result.status, result.stderr).toBe(0);
    const createCall = calls().find(
      (call) => call[0] === "docker" && call[1].startsWith("buildx imagetools create"),
    );
    expect(createCall[1]).toContain(`--tag ${IMAGE}:v1.3.1`);
  });

  it("asks the evidence gate about the exact commit, ref and registry being promoted, reusing GITLAB_RELEASE_TOKEN", () => {
    const { result, calls } = run();
    expect(result.status, result.stderr).toBe(0);
    const awaitCall = calls().find((call) => call[0] === "await");
    expect(awaitCall).toBeDefined();
    const [, apiUrl, projectId, readToken, registry, commit, ref] = awaitCall;
    expect(apiUrl).toBe("https://gitlab.tomlawson.io/api/v4");
    expect(projectId).toBe("49");
    expect(readToken).toBe(GITLAB_TOKEN);
    expect(registry).toBe("registry.tomlawson.io");
    expect(commit).toBe(GOOD_SHA);
    expect(ref).toBe("preview");
  });

  it("refuses when GitLab's evidence recorded a different digest than the one being promoted, without promoting", () => {
    const { result, calls } = run({ evidenceDigest: OTHER_DIGEST });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("recorded digest");
    expect(result.stderr).toContain(OTHER_DIGEST);
    expect(result.stderr).toContain(PREVIEW_DIGEST);
    expect(calls().some((call) => call[0] === "docker" && call[1].startsWith("login"))).toBe(false);
    expect(
      calls().some((call) => call[0] === "docker" && call[1].startsWith("buildx imagetools create")),
    ).toBe(false);
  });

  it("refuses, without promoting, when the evidence gate finds no evidence for the commit", () => {
    const { result, calls } = run({
      evidenceFail: "pipeline 12345 has no successful attest_image job",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("has no successful attest_image job");
    expect(calls().some((call) => call[0] === "docker" && call[1].startsWith("login"))).toBe(false);
    expect(
      calls().some((call) => call[0] === "docker" && call[1].startsWith("buildx imagetools create")),
    ).toBe(false);
  });

  it("refuses, without promoting, when the evidence gate finds evidence older than seven days", () => {
    const { result, calls } = run({
      evidenceFail: "evidence recorded at 2026-08-01T00:00:00Z is older than seven days",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("older than seven days");
    expect(calls().some((call) => call[0] === "docker" && call[1].startsWith("login"))).toBe(false);
    expect(
      calls().some((call) => call[0] === "docker" && call[1].startsWith("buildx imagetools create")),
    ).toBe(false);
  });
});

describe(".gitlab-ci.yml promote_stable job", () => {
  const jobStart = workflow.indexOf("\npromote_stable:\n");
  const jobEnd = workflow.indexOf("\n# --- maintenance", jobStart);
  const job = workflow.slice(jobStart, jobEnd > 0 ? jobEnd : undefined);

  it("exists, extends .dind and runs the script", () => {
    expect(jobStart).toBeGreaterThan(0);
    expect(job).toContain("extends: .dind");
    expect(job).toContain("bash scripts/ci/promote-stable.sh");
  });

  it("is manual and never runs in a scheduled pipeline", () => {
    expect(job).toContain("*not_scheduled");
    expect(job).toContain("when: manual");
    expect(job).toContain("allow_failure: false");
  });

  it("is reachable only from a main pipeline or a web/api pipeline carrying PREVIEW_DIGEST", () => {
    expect(job).toContain('$CI_COMMIT_BRANCH == "main"');
    expect(job).toMatch(/CI_PIPELINE_SOURCE == "web"/);
    expect(job).toMatch(/CI_PIPELINE_SOURCE == "api"/);
    expect(job).toContain("$PREVIEW_DIGEST");
    expect(job).not.toContain("$VERSION");
  });

  it("never authenticates with the job's own CI_JOB_TOKEN", () => {
    expect(job).not.toContain("CI_JOB_TOKEN");
  });

  it("does not use crane", () => {
    expect(job).not.toContain("crane");
  });
});
