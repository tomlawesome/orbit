import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

/*
 * scripts/ci/publish-channel.sh is the publication half of the #661 split:
 * it may only consume validation evidence, never produce it. Driven under
 * bash against stub docker and a stub verifier (the promote-stable.test.mjs
 * pattern); the shared verifier's own refusals have crafted-input tests in
 * scripts/verify-validation-evidence.test.mjs, so the stub here only proves
 * the call site -- right inputs in, refusals out with message and exit code
 * intact -- plus this script's own refusals around it. `node` is real: the
 * script runs the repository's actual supply-chain policy validation.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./ci/publish-channel.sh", import.meta.url).pathname;

const IMAGE = "registry.tomlawson.io/ai/orbit";
const DIGEST = `sha256:${"1".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"2".repeat(64)}`;
const COMMIT = "a".repeat(40);
const VERSION = "v1.4.0-preview.1";

const DOCKER_STUB = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'log="$STUB_LOG"',
  'digests_dir="$STUB_DIGESTS_DIR"',
  "sanitize() { printf '%s' \"$1\" | tr '/:@*' '____'; }",
  'case "$1" in',
  "  buildx)",
  '    case "$3" in',
  "      inspect)",
  "        printf 'docker\\x1f%s\\x1e' \"$*\" >> \"$log\"",
  '        file="$digests_dir/$(sanitize "$4")"',
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
  '        digest="${STUB_CREATED_DIGEST:-${src#*@}}"',
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
  "  *)",
  "    printf 'docker\\x1f%s\\x1e' \"$*\" >> \"$log\"",
  "    exit 1",
  "    ;;",
  "esac",
  "",
].join("\n");

// Stands in for scripts/ci/verify-validation-evidence.sh: records the inputs
// the call site hands over, and on demand refuses the way the real verifier
// does, so the test proves a refusal's message and exit code pass through
// publication untouched.
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

function run({
  branch = "preview",
  evidence = { imageDigest: DIGEST },
  noEvidenceFile = false,
  labelRevision = COMMIT,
  labelVersion = VERSION,
  labelReleaseStage = "preview",
  embeddedVersion = VERSION,
  embeddedRevision = COMMIT,
  embeddedChannel = "preview",
  reportedVersion = `Orbit ${VERSION}`,
  env = {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "publish-channel-"));
  const digestsDir = join(dir, "digests");
  mkdirSync(digestsDir);
  const logFile = join(dir, "calls.log");
  writeFileSync(logFile, "");
  for (const [name, content] of [
    ["docker", DOCKER_STUB],
    ["verify", VERIFY_STUB],
  ]) {
    writeFileSync(join(dir, name), content);
    chmodSync(join(dir, name), 0o755);
  }
  const evidenceFile = join(dir, "gitlab-tested-image.json");
  if (!noEvidenceFile) writeFileSync(evidenceFile, JSON.stringify(evidence));

  const result = failOnProcessDeadline(
    spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        CI_REGISTRY_IMAGE: IMAGE,
        CI_COMMIT_SHA: COMMIT,
        CI_COMMIT_BRANCH: branch,
        CI_COMMIT_REF_NAME: branch,
        ORBIT_EVIDENCE_FILE: evidenceFile,
        ORBIT_VERIFY_SCRIPT: join(dir, "verify"),
        STUB_LOG: logFile,
        STUB_DIGESTS_DIR: digestsDir,
        STUB_LABEL_REVISION: labelRevision,
        STUB_LABEL_VERSION: labelVersion,
        STUB_LABEL_RELEASE_STAGE: labelReleaseStage,
        STUB_EMBEDDED_VERSION: embeddedVersion,
        STUB_EMBEDDED_REVISION: embeddedRevision,
        STUB_EMBEDDED_CHANNEL: embeddedChannel,
        STUB_REPORTED_VERSION: reportedVersion,
        ...env,
      },
      ...processGuard(),
    }),
    { label: "publish-channel" },
  );
  const calls = () =>
    readFileSync(logFile, "utf8")
      .split("\x1e")
      .filter(Boolean)
      .map((call) => call.split("\x1f").filter(Boolean));
  return { result, calls };
}

describe("publish-channel.sh", () => {
  it("verifies the evidence for the exact digest, re-runs the cheap checks, then tags -- and never pushes", () => {
    const { result, calls } = run();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`published ${DIGEST} as ${IMAGE}:preview`);

    const recorded = calls();
    const verify = recorded.find((call) => call[0] === "verify");
    expect(verify).toEqual(["verify", IMAGE, DIGEST, COMMIT, "preview"]);

    const create = recorded.find((call) => call[1]?.includes("imagetools create"));
    expect(create[1]).toContain(`--tag ${IMAGE}:preview`);
    expect(create[1]).toContain(`${IMAGE}@${DIGEST}`);
    // The verifier runs before anything touches the image, and publication
    // moves no bytes: a tag is created, nothing is pushed or attested.
    expect(recorded.findIndex((call) => call[0] === "verify")).toBeLessThan(
      recorded.findIndex((call) => call[1]?.includes("pull")),
    );
    expect(recorded.some((call) => call[1]?.startsWith("push"))).toBe(false);
    expect(recorded.some((call) => call[1]?.includes("attest"))).toBe(false);
  });

  it("tags hotfix-<name> for a hotfix branch", () => {
    const { result, calls } = run({
      branch: "hotfix/urgent fix#1",
      labelReleaseStage: "preview",
      embeddedChannel: "preview",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const create = calls().find((call) => call[1]?.includes("imagetools create"));
    expect(create[1]).toContain(`--tag ${IMAGE}:hotfix-urgent-fix-1`);
  });

  it("refuses to publish from a branch that is not preview or hotfix/*", () => {
    const { result } = run({ branch: "dev" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "publish-channel: branch dev is not a publishing branch; only preview and hotfix/* take a channel tag",
    );
  });

  it("refuses when the evidence artifact is absent", () => {
    const { result } = run({ noEvidenceFile: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no evidence file at");
    expect(result.stderr).toContain("publication has nothing to publish without it");
  });

  it("refuses an evidence file that names no digest", () => {
    const { result } = run({ evidence: { imageDigest: "latest" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the evidence file names no immutable manifest digest (got latest)");
  });

  it("passes the verifier's refusal through with its message and exit code intact", () => {
    const { result, calls } = run({
      env: { STUB_VERIFY_FAIL: "(expired): crafted refusal from the verifier", STUB_VERIFY_EXIT: "13" },
    });
    expect(result.status).toBe(13);
    expect(result.stderr).toContain(
      "verify-validation-evidence: refused (expired): crafted refusal from the verifier",
    );
    // Refused before anything was pulled, checked or tagged.
    expect(calls().some((call) => call[0] === "docker")).toBe(false);
  });

  it("refuses an image whose revision label is not the commit being published", () => {
    const { result, calls } = run({ labelRevision: "f".repeat(40), embeddedRevision: "f".repeat(40) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `the image's revision label (${"f".repeat(40)}) is not the commit being published (${COMMIT})`,
    );
    expect(calls().some((call) => call[1]?.includes("imagetools create"))).toBe(false);
  });

  it("refuses when the embedded version disagrees with the labels (belt and braces, #573 ruling 24)", () => {
    const { result } = run({ embeddedVersion: "v0.0.0" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("embedded and reported versions do not match the image version label");
  });

  it("refuses when the created tag does not retain the validated digest", () => {
    const { result } = run({ env: { STUB_CREATED_DIGEST: OTHER_DIGEST } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${IMAGE}:preview did not retain the validated digest`);
    expect(result.stderr).toContain(`resolves to ${OTHER_DIGEST}, expected ${DIGEST}`);
  });
});
