import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// scripts/ci/promote-stable.sh runs under bash against stub git/crane/curl;
// budget and reasoning: scripts/process-budget.mjs. Same pattern as
// scripts/sidecar-freshness-issue.test.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./ci/promote-stable.sh", import.meta.url).pathname;
const workflow = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);

const GOOD_SHA = "a".repeat(40);
const PREVIEW_DIGEST = `sha256:${"1".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"2".repeat(64)}`;
const GHCR_TOKEN = "TEST-GHCR-TOKEN-NOT-REAL";
const GITLAB_TOKEN = "TEST-GITLAB-TOKEN-NOT-REAL";

/**
 * Stub `git`, `crane` and `curl` on PATH, each logging its own argv (and, for
 * crane's `auth login`, what it read from stdin) to one shared log file so a
 * test can assert both what ran and in what order. Records are separated by
 * \x1e and fields within a record by \x1f, the same scheme
 * scripts/sidecar-freshness-issue.test.mjs uses, for the same reason: a
 * curl argument here can itself contain a multi-line value.
 */
function makeStubs({
  tagExists = false,
  mainHead = GOOD_SHA,
  previewHead = GOOD_SHA,
  previewDigest = PREVIEW_DIGEST,
  shaDigest = PREVIEW_DIGEST,
  versionTagExists = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "promote-stable-stub-"));
  const logFile = join(dir, "calls.log");
  writeFileSync(logFile, "");

  const gitScript = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `log=${JSON.stringify(logFile)}`,
    'printf \'git\\x1f%s\\x1e\' "$*" >> "$log"',
    'args="$*"',
    'case "$args" in',
    "  *'ls-remote --exit-code --tags'*'refs/tags/'*)",
    `    exit ${tagExists ? 0 : 2}`,
    "    ;;",
    "  *'refs/heads/main'*)",
    `    printf '%s\\trefs/heads/main\\n' ${JSON.stringify(mainHead)}`,
    "    ;;",
    "  *'refs/heads/preview'*)",
    `    printf '%s\\trefs/heads/preview\\n' ${JSON.stringify(previewHead)}`,
    "    ;;",
    "  *)",
    "    echo \"stub git: unexpected invocation: $args\" >&2",
    "    exit 1",
    "    ;;",
    "esac",
    "",
  ].join("\n");

  const craneScript = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `log=${JSON.stringify(logFile)}`,
    'args="$*"',
    'case "$args" in',
    "  auth\\ login*)",
    "    stdin_content=\"$(cat)\"",
    '    printf \'crane\\x1f%s\\x1f<stdin:%s>\\x1e\' "$args" "$stdin_content" >> "$log"',
    "    exit 0",
    "    ;;",
    "  *digest*:preview)",
    '    printf \'crane\\x1f%s\\x1e\' "$args" >> "$log"',
    `    printf '%s\\n' ${JSON.stringify(previewDigest)}`,
    "    ;;",
    "  *digest*:sha-*)",
    '    printf \'crane\\x1f%s\\x1e\' "$args" >> "$log"',
    `    printf '%s\\n' ${JSON.stringify(shaDigest)}`,
    "    ;;",
    "  digest\\ *)",
    '    printf \'crane\\x1f%s\\x1e\' "$args" >> "$log"',
    versionTagExists ? `    printf '%s\\n' ${JSON.stringify(previewDigest)}` : "    exit 1",
    "    ;;",
    "  tag\\ *)",
    '    printf \'crane\\x1f%s\\x1e\' "$args" >> "$log"',
    "    exit 0",
    "    ;;",
    "  *)",
    "    echo \"stub crane: unexpected invocation: $args\" >&2",
    "    exit 1",
    "    ;;",
    "esac",
    "",
  ].join("\n");

  // Records argv, inlining the contents of any --header @file or
  // --data-urlencode key@file the way scripts/sidecar-freshness-issue.test.mjs
  // does, so the test can see what was sent without the file surviving the
  // script's own cleanup trap. A plain "key=value" argument (no @) is
  // recorded verbatim.
  const curlScript = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `log=${JSON.stringify(logFile)}`,
    "recorded=()",
    'while [ "$#" -gt 0 ]; do',
    '  arg="$1"',
    "  case \"$arg\" in",
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
    'printf \'curl\\x1f\' >> "$log"',
    'printf \'%s\\x1f\' "${recorded[@]}" >> "$log"',
    'printf \'\\x1e\' >> "$log"',
    "printf '%s' '{\"name\":\"ok\"}'",
    "exit 0",
    "",
  ].join("\n");

  for (const [name, content] of [
    ["git", gitScript],
    ["crane", craneScript],
    ["curl", curlScript],
  ]) {
    const stubPath = join(dir, name);
    writeFileSync(stubPath, content);
    chmodSync(stubPath, 0o755);
  }

  return {
    dir,
    calls: () =>
      readFileSync(logFile, "utf8")
        .split("\x1e")
        .filter(Boolean)
        .map((call) => call.split("\x1f").filter((part) => part.length > 0)),
  };
}

function run({ stubDir, env = {} }) {
  const result = failOnProcessDeadline(
    spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        PATH: `${stubDir}:${process.env.PATH}`,
        CI_COMMIT_SHA: GOOD_SHA,
        CI_API_V4_URL: "https://gitlab.tomlawson.io/api/v4",
        CI_PROJECT_ID: "49",
        GHCR_PUBLISH_TOKEN: GHCR_TOKEN,
        GITLAB_RELEASE_TOKEN: GITLAB_TOKEN,
        VERSION: "1.4.0",
        ...env,
      },
      ...processGuard(),
    }),
    { label: "run" },
  );
  return result;
}

describe("scripts/ci/promote-stable.sh", () => {
  it("refuses a malformed VERSION before touching git, crane or curl", () => {
    const { dir, calls } = makeStubs();
    const result = run({ stubDir: dir, env: { VERSION: "not-a-version" } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("VERSION must be vMAJOR.MINOR.PATCH");
    expect(calls().length).toBe(0);
  });

  it("normalises a version with no leading v", () => {
    const { dir, calls } = makeStubs();
    const result = run({ stubDir: dir, env: { VERSION: "1.4.0" } });
    expect(result.status, result.stderr).toBe(0);
    const tagCalls = calls().filter((call) => call[0] === "crane" && call[1].startsWith("tag "));
    expect(tagCalls.some((call) => call[1].endsWith(" v1.4.0"))).toBe(true);
  });

  it("refuses when the GitLab tag already exists, without calling crane or curl", () => {
    const { dir, calls } = makeStubs({ tagExists: true });
    const result = run({ stubDir: dir });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("already exists on GitLab");
    expect(calls().some((call) => call[0] === "crane")).toBe(false);
    expect(calls().some((call) => call[0] === "curl")).toBe(false);
  });

  it("refuses when main and preview are not the same commit", () => {
    const { dir, calls } = makeStubs({ mainHead: GOOD_SHA, previewHead: "b".repeat(40) });
    const result = run({ stubDir: dir });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("are not the same commit");
    expect(calls().some((call) => call[0] === "crane")).toBe(false);
  });

  it("refuses when the preview digest does not match the tested sha- digest", () => {
    const { dir, calls } = makeStubs({ previewDigest: PREVIEW_DIGEST, shaDigest: OTHER_DIGEST });
    const result = run({ stubDir: dir });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match");
    expect(calls().some((call) => call[0] === "crane" && call[1].startsWith("tag "))).toBe(false);
    expect(calls().some((call) => call[0] === "curl")).toBe(false);
  });

  it("refuses when the version tag already exists in GHCR", () => {
    const { dir, calls } = makeStubs({ versionTagExists: true });
    const result = run({ stubDir: dir });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("already exists in GHCR");
    expect(calls().some((call) => call[0] === "crane" && call[1].startsWith("tag "))).toBe(false);
    expect(calls().some((call) => call[0] === "curl")).toBe(false);
  });

  it("on the happy path, tags vX.Y.Z and stable in GHCR and creates the GitLab tag", () => {
    const { dir, calls } = makeStubs();
    const result = run({ stubDir: dir });
    expect(result.status, result.stderr).toBe(0);

    const recordedCalls = calls();
    const craneTagCalls = recordedCalls.filter((call) => call[0] === "crane" && call[1].startsWith("tag "));
    expect(craneTagCalls.some((call) => call[1].endsWith(" v1.4.0"))).toBe(true);
    expect(craneTagCalls.some((call) => call[1].endsWith(" stable"))).toBe(true);

    const authCall = recordedCalls.find((call) => call[0] === "crane" && call[1].startsWith("auth login"));
    expect(authCall).toBeDefined();
    expect(authCall[1]).toContain("ghcr.io");
    expect(authCall[1]).toContain("-u tomlawesome");
    expect(authCall[2]).toBe(`<stdin:${GHCR_TOKEN}>`);

    const curlCall = recordedCalls.find((call) => call[0] === "curl");
    expect(curlCall).toBeDefined();
    const curlArgs = curlCall.join(" ");
    expect(curlArgs).toContain("projects/49/repository/tags");
    expect(curlArgs).toContain("tag_name=v1.4.0");
    expect(curlArgs).toContain(`ref=${GOOD_SHA}`);
    expect(curlArgs).toContain("message=Orbit v1.4.0");
    expect(curlArgs).toContain(`PRIVATE-TOKEN: ${GITLAB_TOKEN}`);

    // The tokens only ever show up inlined from a stubbed file (tagged
    // "name@<...>") or as the piped stdin content recorded above -- never as
    // a bare argv word, which is what proves the real script kept them off
    // the command line.
    for (const call of recordedCalls) {
      for (const part of call) {
        if (part.startsWith("<stdin:")) continue;
        if (part.includes("<") && part.includes("@<")) continue;
        expect(part).not.toBe(GHCR_TOKEN);
        expect(part).not.toBe(GITLAB_TOKEN);
        if (!part.includes("<")) {
          expect(part).not.toContain(GHCR_TOKEN);
          expect(part).not.toContain(GITLAB_TOKEN);
        }
      }
    }
  });
});

describe(".gitlab-ci.yml promote_stable job", () => {
  const jobStart = workflow.indexOf("\npromote_stable:\n");
  const jobEnd = workflow.indexOf("\n# --- maintenance", jobStart);
  const job = workflow.slice(jobStart, jobEnd > 0 ? jobEnd : undefined);

  it("exists and runs the script", () => {
    expect(jobStart).toBeGreaterThan(0);
    expect(job).toContain("bash scripts/ci/promote-stable.sh");
  });

  it("is manual and never runs in a scheduled pipeline", () => {
    expect(job).toContain("*not_scheduled");
    expect(job).toContain("when: manual");
    expect(job).toContain("allow_failure: false");
  });

  it("is reachable only from a main pipeline or a web/api pipeline carrying VERSION", () => {
    expect(job).toContain('$CI_COMMIT_BRANCH == "main"');
    expect(job).toMatch(/CI_PIPELINE_SOURCE == "web"/);
    expect(job).toMatch(/CI_PIPELINE_SOURCE == "api"/);
    expect(job).toContain("$VERSION");
  });

  it("never authenticates with the job's own CI_JOB_TOKEN", () => {
    expect(job).not.toContain("CI_JOB_TOKEN");
  });
});
