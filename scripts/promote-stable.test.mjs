import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { calculateReleaseTrainVersion } from "./calculate-version.mjs";
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
const REGISTRY_IMAGE = "registry.tomlawson.io/ai/orbit";
const GOOD_SHA = "a".repeat(40);
const PREVIEW_DIGEST = `sha256:${"1".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"2".repeat(64)}`;
// The stable tags the git stub lists unless a test says otherwise.
const STABLE_TAGS = "v1.3.0";
// The version the script should calculate from those tags, worked out the way
// the script's own scripts/calculate-version.mjs does and from the same real
// release-line and retracted-tags files, so raising the release line is a
// config edit these tests follow rather than one that breaks them.
const VERSION = calculateReleaseTrainVersion({
  tags: STABLE_TAGS.split("\n"),
  fallbackVersion: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
  channel: "preview",
  retractedTags: JSON.parse(readFileSync(new URL("./retracted-tags.json", import.meta.url), "utf8")).tags,
  releaseLine: JSON.parse(readFileSync(new URL("./release-line.json", import.meta.url), "utf8")).line,
});
const GHCR_TOKEN = "TEST-GHCR-TOKEN-NOT-REAL";
const GITLAB_TOKEN = "TEST-GITLAB-TOKEN-NOT-REAL";
const REGISTRY_PASSWORD = "TEST-REGISTRY-PASSWORD-NOT-REAL";

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

// Stands in for scripts/ci/verify-validation-evidence.sh (#877's evidence
// gate), which promote-stable.sh now runs before promoting -- the same
// verifier publish-channel.test.mjs stubs the same way for the same reason.
// The verifier's own crafted-input refusals -- one per ground, with the
// specific message asserted -- are driven against the real script in
// scripts/verify-validation-evidence.test.mjs; this stub is not a second
// copy of that. It exists only to prove two things about the new call site
// in promote-stable.sh: that it is invoked with the right image, digest,
// commit and ref (STUB_VERIFY_FAIL unset, happy path -- the default every
// other test in this file relies on to get past the gate), and that a
// refusal from the verifier -- represented here as STUB_VERIFY_FAIL/
// STUB_VERIFY_EXIT -- stops promotion with its message and exit code intact
// rather than being swallowed.
const VERIFY_STUB = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  "printf 'verify\\x1f%s\\x1f%s\\x1f%s\\x1f%s\\x1e' \\",
  '  "$ORBIT_IMAGE" "$ORBIT_DIGEST" "$ORBIT_COMMIT" "${ORBIT_REF:-}" >> "$STUB_LOG"',
  'if [ -n "${STUB_VERIFY_FAIL:-}" ]; then',
  "  printf 'verify-validation-evidence: refused %s\\n' \"$STUB_VERIFY_FAIL\" >&2",
  '  exit "${STUB_VERIFY_EXIT:-13}"',
  "fi",
  "exit 0",
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
    ["verify", VERIFY_STUB],
  ]) {
    const stubPath = join(dir, name);
    writeFileSync(stubPath, content);
    chmodSync(stubPath, 0o755);
  }

  return {
    dir,
    digestsDir,
    verifyScript: join(dir, "verify"),
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
  latestTagDigest = null,
  tagExistsOnGitLab = false,
  stableTags = STABLE_TAGS,
  labelRevision = GOOD_SHA,
  labelVersion = VERSION,
  labelReleaseStage = "preview",
  labelSourceBranch = "preview",
  embeddedVersion = VERSION,
  embeddedRevision = GOOD_SHA,
  embeddedChannel = "preview",
  reportedVersion = `Orbit ${VERSION}`,
  env = {},
} = {}) {
  const stubs = makeStubs();
  stubs.seedDigest(`${IMAGE}:preview`, previewTagDigest);
  if (shaTagDigest) stubs.seedDigest(`${IMAGE}:sha-${mainHead}`, shaTagDigest);
  if (versionTagDigest) stubs.seedDigest(`${IMAGE}:${labelVersion}`, versionTagDigest);
  if (latestTagDigest) stubs.seedDigest(`${IMAGE}:latest`, latestTagDigest);

  const result = failOnProcessDeadline(
    spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        PATH: `${stubs.dir}:${process.env.PATH}`,
        // null leaves PREVIEW_DIGEST out of the environment altogether.
        PREVIEW_DIGEST: previewDigestInput ?? undefined,
        CI_COMMIT_BRANCH: "main",
        // The pipeline's own commit; by default main's head, as on a fresh pipeline.
        CI_COMMIT_SHA: mainHead,
        CI_API_V4_URL: "https://gitlab.tomlawson.io/api/v4",
        CI_PROJECT_ID: "49",
        GHCR_PUBLISH_TOKEN: GHCR_TOKEN,
        GITLAB_RELEASE_TOKEN: GITLAB_TOKEN,
        CI_REGISTRY: "registry.tomlawson.io",
        CI_REGISTRY_USER: "gitlab-ci-token",
        CI_REGISTRY_PASSWORD: REGISTRY_PASSWORD,
        CI_REGISTRY_IMAGE: REGISTRY_IMAGE,
        PROMOTE_VERIFY_SCRIPT: stubs.verifyScript,
        STUB_LOG: stubs.logFile,
        STUB_DIGESTS_DIR: stubs.digestsDir,
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

describe("promote-stable.test.mjs expected version", () => {
  // T-Q28. Fails on the current code: VERSION is a hard-coded literal, so the
  // first time scripts/release-line.json is raised every happy-path test
  // fails on a correct config edit. Passes once VERSION is derived with
  // calculateReleaseTrainVersion from the real release-line file.
  it("derives VERSION from calculateReleaseTrainVersion rather than a literal", () => {
    const source = readFileSync(new URL(import.meta.url), "utf8");
    expect(source).not.toMatch(/^const VERSION = "v\d+\.\d+\.\d+";/mu);
    expect(source).toMatch(/^import \{[^}]*calculateReleaseTrainVersion[^}]*\} from /mu);
    expect(source).toMatch(/readFileSync\([^)]*release-line\.json/u);
  });
});

describe("scripts/ci/promote-stable.sh", () => {
  it("refuses a malformed PREVIEW_DIGEST, without calling docker or git", () => {
    // An unset variable is no longer refused (#1482); see the tests below.
    for (const bad of ["not-a-digest", `sha256:${"1".repeat(63)}`, `sha1:${"1".repeat(64)}`]) {
      const { result, calls } = run({ previewDigestInput: bad });
      expect(result.status, bad).not.toBe(0);
      expect(result.stderr, bad).toContain("PREVIEW_DIGEST");
      expect(calls().length, bad).toBe(0);
    }
  });

  // #1482: PREVIEW_DIGEST is optional. Unset, the script takes the digest that
  // :sha-<main's commit> resolves to, and :preview must agree with it.
  describe("with PREVIEW_DIGEST unset (#1482)", () => {
    it("promotes the digest :sha-<commit> resolves to when :preview resolves to the same", () => {
      const { result, calls } = run({ previewDigestInput: null });
      expect(result.status, result.stderr).toBe(0);
      const recordedCalls = calls();
      const createCall = recordedCalls.find(
        (call) => call[0] === "docker" && call[1].startsWith("buildx imagetools create"),
      );
      expect(createCall).toBeDefined();
      expect(createCall[1]).toContain(`--tag ${IMAGE}:${VERSION}`);
      expect(createCall[1]).toContain(`--tag ${IMAGE}:latest`);
      expect(createCall[1]).toContain(`${IMAGE}@${PREVIEW_DIGEST}`);
      // The evidence gate is asked about the digest the script chose.
      const verifyCall = recordedCalls.find((call) => call[0] === "verify");
      expect(verifyCall).toBeDefined();
      expect(verifyCall[2]).toBe(PREVIEW_DIGEST);
      expect(verifyCall[3]).toBe(GOOD_SHA);
      const curlCall = recordedCalls.find((call) => call[0] === "curl");
      expect(curlCall).toBeDefined();
      expect(curlCall.join(" ")).toContain(`Container digest: ${PREVIEW_DIGEST}`);
    });

    it("refuses when :preview resolves to a different digest, without promoting", () => {
      const { result, calls } = run({ previewDigestInput: null, previewTagDigest: OTHER_DIGEST });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${IMAGE}:preview`);
      const recordedCalls = calls();
      expect(recordedCalls.some((call) => call[0] === "docker" && call[1].startsWith("pull "))).toBe(false);
      expect(
        recordedCalls.some((call) => call[0] === "docker" && call[1].startsWith("buildx imagetools create")),
      ).toBe(false);
      expect(recordedCalls.some((call) => call[0] === "curl")).toBe(false);
    });

    it("refuses and names the tag when :sha-<commit> resolves to nothing, without promoting", () => {
      const { result, calls } = run({ previewDigestInput: null, shaTagDigest: null });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${IMAGE}:sha-${GOOD_SHA}`);
      const recordedCalls = calls();
      expect(recordedCalls.some((call) => call[0] === "docker" && call[1].startsWith("pull "))).toBe(false);
      expect(
        recordedCalls.some((call) => call[0] === "docker" && call[1].startsWith("buildx imagetools create")),
      ).toBe(false);
      expect(recordedCalls.some((call) => call[0] === "curl")).toBe(false);
    });

    it("logs that the digest was read from :sha-<commit>, and prints it", () => {
      const { result } = run({ previewDigestInput: null });
      expect(result.status, result.stderr).toBe(0);
      const log = `${result.stdout}\n${result.stderr}`;
      expect(log).toContain(`${IMAGE}:sha-${GOOD_SHA}`);
      expect(log).toContain(PREVIEW_DIGEST);
    });

    // #1482 review: with no digest given, only the pipeline for main's current
    // head may promote; a button on an older main pipeline must not.
    it("refuses when the pipeline's commit is not main's head, naming both, before pulling, tagging or curl", () => {
      const olderSha = "c".repeat(40);
      const { result, calls } = run({ previewDigestInput: null, env: { CI_COMMIT_SHA: olderSha } });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(olderSha);
      expect(result.stderr).toContain(GOOD_SHA);
      const recordedCalls = calls();
      expect(recordedCalls.some((call) => call[0] === "docker" && call[1].startsWith("pull "))).toBe(false);
      expect(
        recordedCalls.some((call) => call[0] === "docker" && call[1].startsWith("buildx imagetools create")),
      ).toBe(false);
      expect(recordedCalls.some((call) => call[0] === "curl")).toBe(false);
    });

    it("treats an empty PREVIEW_DIGEST as unset: takes :sha-<commit> and promotes it", () => {
      const { result, calls } = run({ previewDigestInput: "" });
      expect(result.status, result.stderr).toBe(0);
      const createCall = calls().find(
        (call) => call[0] === "docker" && call[1].startsWith("buildx imagetools create"),
      );
      expect(createCall).toBeDefined();
      expect(createCall[1]).toContain(`${IMAGE}@${PREVIEW_DIGEST}`);
    });
  });

  it("logs that the digest came from PREVIEW_DIGEST when it is set, and prints it (#1482)", () => {
    const { result } = run();
    expect(result.status, result.stderr).toBe(0);
    const log = `${result.stdout}\n${result.stderr}`;
    expect(log).toContain("PREVIEW_DIGEST");
    expect(log).toContain(PREVIEW_DIGEST);
  });

  it("refuses off main, however the pipeline was started, without calling docker or git (#1564)", () => {
    for (const branch of ["dev", "preview", "hotfix/x", "feature/x", ""]) {
      const { result, calls } = run({ env: { CI_COMMIT_BRANCH: branch } });
      expect(result.status, branch).not.toBe(0);
      expect(result.stderr, branch).toContain("only on main");
      expect(calls().length, branch).toBe(0);
    }
    const unset = run({ env: { CI_COMMIT_BRANCH: undefined } });
    expect(unset.result.status).not.toBe(0);
    expect(unset.result.stderr).toContain("only on main");
    expect(unset.calls().length).toBe(0);
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
    // v1.3.0 already stable => the next preview-channel version is VERSION,
    // not the v1.9.0 this image claims.
    const { result } = run({ labelVersion: "v1.9.0", embeddedVersion: "v1.9.0", reportedVersion: "Orbit v1.9.0" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match calculated version");
  });

  it("refuses when the GitLab tag already exists, without logging into GHCR or tagging", () => {
    const { result, calls } = run({ tagExistsOnGitLab: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("already exists on GitLab");
    expect(calls().some((call) => call[0] === "docker" && call[1].startsWith("login ghcr.io"))).toBe(
      false,
    );
  });

  it("refuses when the version tag already exists in GHCR at another digest, without logging into GHCR or tagging", () => {
    const { result, calls } = run({ versionTagDigest: OTHER_DIGEST });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("already exists in GHCR");
    expect(calls().some((call) => call[0] === "docker" && call[1].startsWith("login ghcr.io"))).toBe(
      false,
    );
    expect(
      calls().some((call) => call[0] === "docker" && call[1].startsWith("buildx imagetools create")),
    ).toBe(false);
  });

  it("resumes a half-finished promotion: GHCR tags already on the accepted digest, no GitLab tag, so it only creates the GitLab tag", () => {
    const { result, calls } = run({ versionTagDigest: PREVIEW_DIGEST, latestTagDigest: PREVIEW_DIGEST });
    expect(result.status, result.stderr).toBe(0);
    const recordedCalls = calls();
    expect(
      recordedCalls.some((call) => call[0] === "docker" && call[1].startsWith("buildx imagetools create")),
    ).toBe(false);
    const curlCall = recordedCalls.find((call) => call[0] === "curl");
    expect(curlCall).toBeDefined();
    expect(curlCall.join(" ")).toContain("projects/49/repository/tags");
    expect(curlCall.join(" ")).toContain(`tag_name=${VERSION}`);
  });

  it("still refuses when the version tag in GHCR resolves to a different digest, even if :latest matches", () => {
    const { result, calls } = run({ versionTagDigest: OTHER_DIGEST, latestTagDigest: PREVIEW_DIGEST });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("already exists in GHCR");
    const recordedCalls = calls();
    expect(recordedCalls.some((call) => call[0] === "curl")).toBe(false);
    expect(
      recordedCalls.some((call) => call[0] === "docker" && call[1].startsWith("buildx imagetools create")),
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
    // Copy the tested manifest unchanged: without this flag buildx wraps a
    // single-manifest source in a new, unsigned index with a new digest (#1179).
    expect(createCall[1]).toContain("--prefer-index=false");

    // Two logins: registry.tomlawson.io (so the verifier below can read the
    // attestation) then GHCR (to publish). Both piped on stdin, never argv.
    const registryLoginCall = recordedCalls.find(
      (call) => call[0] === "docker" && call[1].startsWith("login registry.tomlawson.io"),
    );
    expect(registryLoginCall).toBeDefined();
    expect(registryLoginCall[2]).toBe(`<stdin:${REGISTRY_PASSWORD}>`);

    const ghcrLoginCall = recordedCalls.find(
      (call) => call[0] === "docker" && call[1].startsWith("login ghcr.io"),
    );
    expect(ghcrLoginCall).toBeDefined();
    expect(ghcrLoginCall[1]).toContain("-u tomlawesome");
    expect(ghcrLoginCall[2]).toBe(`<stdin:${GHCR_TOKEN}>`);

    // The registry login, and so the verifier, run before GHCR is touched.
    expect(recordedCalls.indexOf(registryLoginCall)).toBeLessThan(recordedCalls.indexOf(ghcrLoginCall));

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
    // the command line.
    for (const call of recordedCalls) {
      for (const part of call) {
        if (part.startsWith("<stdin:")) continue;
        if (part.includes("@<")) continue;
        expect(part).not.toBe(GHCR_TOKEN);
        expect(part).not.toBe(GITLAB_TOKEN);
        expect(part).not.toBe(REGISTRY_PASSWORD);
        if (!part.includes("<")) {
          expect(part).not.toContain(GHCR_TOKEN);
          expect(part).not.toContain(GITLAB_TOKEN);
          expect(part).not.toContain(REGISTRY_PASSWORD);
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

  it("asks the shared verifier about the exact image, digest, commit and ref being promoted", () => {
    const { result, calls } = run();
    expect(result.status, result.stderr).toBe(0);
    const verifyCall = calls().find((call) => call[0] === "verify");
    expect(verifyCall).toBeDefined();
    const [, image, digest, commit, ref] = verifyCall;
    expect(image).toBe(REGISTRY_IMAGE);
    expect(digest).toBe(PREVIEW_DIGEST);
    expect(commit).toBe(GOOD_SHA);
    expect(ref).toBe("preview");
  });

  // The four grounds the shared verifier refuses on (scripts/ci/
  // verify-validation-evidence.sh); each crafted message here stands in for
  // a real refusal, proving promote-stable.sh passes it through with the
  // ground-specific message and exit code intact, without promoting.
  it("refuses on a mismatch (exit 10), the verifier's message intact, without promoting", () => {
    const { result, calls } = run({
      env: {
        STUB_VERIFY_FAIL:
          `(mismatch): evidence names digest ${OTHER_DIGEST}, not the digest being published (${PREVIEW_DIGEST})`,
        STUB_VERIFY_EXIT: "10",
      },
    });
    expect(result.status).toBe(10);
    expect(result.stderr).toContain(
      `evidence names digest ${OTHER_DIGEST}, not the digest being published (${PREVIEW_DIGEST})`,
    );
    expect(calls().some((call) => call[0] === "docker" && call[1].startsWith("login ghcr.io"))).toBe(
      false,
    );
    expect(
      calls().some((call) => call[0] === "docker" && call[1].startsWith("buildx imagetools create")),
    ).toBe(false);
  });

  it("refuses on missing evidence (exit 11), the verifier's message intact, without promoting", () => {
    const { result, calls } = run({
      env: {
        STUB_VERIFY_FAIL: "(missing): no verifiable validation attestation for this digest",
        STUB_VERIFY_EXIT: "11",
      },
    });
    expect(result.status).toBe(11);
    expect(result.stderr).toContain("no verifiable validation attestation for this digest");
    expect(calls().some((call) => call[0] === "docker" && call[1].startsWith("login ghcr.io"))).toBe(
      false,
    );
    expect(
      calls().some((call) => call[0] === "docker" && call[1].startsWith("buildx imagetools create")),
    ).toBe(false);
  });

  it("refuses on ambiguous evidence (exit 12), the verifier's message intact, without promoting", () => {
    const { result, calls } = run({
      env: {
        STUB_VERIFY_FAIL: "(ambiguous): 2 verified attestations make 2 conflicting claims about what was validated",
        STUB_VERIFY_EXIT: "12",
      },
    });
    expect(result.status).toBe(12);
    expect(result.stderr).toContain(
      "2 verified attestations make 2 conflicting claims about what was validated",
    );
    expect(calls().some((call) => call[0] === "docker" && call[1].startsWith("login ghcr.io"))).toBe(
      false,
    );
    expect(
      calls().some((call) => call[0] === "docker" && call[1].startsWith("buildx imagetools create")),
    ).toBe(false);
  });

  it("refuses on expired evidence (exit 13), the verifier's message intact, without promoting", () => {
    const { result, calls } = run({
      env: {
        STUB_VERIFY_FAIL: "(expired): evidence recorded at 2026-08-01T00:00:00Z is older than 7 days",
        STUB_VERIFY_EXIT: "13",
      },
    });
    expect(result.status).toBe(13);
    expect(result.stderr).toContain(
      "evidence recorded at 2026-08-01T00:00:00Z is older than 7 days",
    );
    expect(calls().some((call) => call[0] === "docker" && call[1].startsWith("login ghcr.io"))).toBe(
      false,
    );
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

  // #1564: the job is reachable from a pipeline on `main` and from nowhere
  // else. The old second route (any web/api pipeline carrying PREVIEW_DIGEST,
  // on any branch) let a Developer press it on `dev` or a feature branch,
  // where the role change that stops them pressing it on protected `main`
  // does not apply. The rules are evaluated here the way GitLab does, over
  // the job's own `rules:` block, so a new route cannot hide behind a
  // substring that still matches.
  const rulesBlock = job.slice(job.indexOf("  rules:\n"), job.indexOf("  script:\n"));
  const rules = rulesBlock
    .split("\n")
    .slice(1)
    .join("\n")
    .split(/^ {4}- /mu)
    .filter(Boolean)
    .map((text) => text.trim());

  /** Does this rule's `if:` hold for a pipeline with these variables? */
  function holds(rule, variables) {
    const condition = rule.match(/^if: (.*)$/mu)?.[1];
    if (condition === undefined) return true;
    // Only the two shapes this job may use: `$CI_COMMIT_BRANCH == "main"` and
    // a bare variable test. Anything else fails loudly, not silently true.
    const equals = condition.match(/^\$(\w+) == "([^"]*)"$/u);
    if (equals) return variables[equals[1]] === equals[2];
    throw new Error(`promote_stable has a rule this test cannot evaluate: ${condition}`);
  }

  /** The `when:` GitLab would give the job in this pipeline, or "never". */
  function whenFor(variables) {
    for (const rule of rules) {
      if (rule.startsWith("*")) continue; // the *not_scheduled alias
      if (holds(rule, variables)) return rule.match(/^ *when: (\w+)$/mu)?.[1] ?? "on_success";
    }
    return "never";
  }

  it("is reachable only from a main pipeline (#1564)", () => {
    expect(job).toContain('$CI_COMMIT_BRANCH == "main"');
    // The one rule that can start it is the `main` rule, and it is manual.
    expect(rules.filter((rule) => !rule.startsWith("*"))).toHaveLength(1);
    expect(whenFor({ CI_COMMIT_BRANCH: "main", CI_PIPELINE_SOURCE: "push" })).toBe("manual");
    // A hand-started pipeline on main is the same rule, not a second route.
    expect(whenFor({ CI_COMMIT_BRANCH: "main", CI_PIPELINE_SOURCE: "web", PREVIEW_DIGEST: "x" })).toBe("manual");
    expect(job).not.toContain("$VERSION");
  });

  it("cannot be reached from a hand-started pipeline off main, digest or not (#1564)", () => {
    for (const branch of ["dev", "preview", "hotfix/x", "feature/x", "primary"]) {
      for (const source of ["web", "api", "push", "pipeline", "trigger"]) {
        for (const digest of [undefined, `sha256:${"1".repeat(64)}`]) {
          const variables = { CI_COMMIT_BRANCH: branch, CI_PIPELINE_SOURCE: source };
          if (digest) variables.PREVIEW_DIGEST = digest;
          expect(whenFor(variables), JSON.stringify(variables)).toBe("never");
        }
      }
    }
    // A merge request pipeline has no branch name at all.
    expect(
      whenFor({ CI_PIPELINE_SOURCE: "merge_request_event", PREVIEW_DIGEST: `sha256:${"1".repeat(64)}` }),
    ).toBe("never");
    expect(job).not.toContain("PREVIEW_DIGEST");
  });

  it("never authenticates with the job's own CI_JOB_TOKEN", () => {
    expect(job).not.toContain("CI_JOB_TOKEN");
  });

  it("does not use crane", () => {
    expect(job).not.toContain("crane");
  });
});
