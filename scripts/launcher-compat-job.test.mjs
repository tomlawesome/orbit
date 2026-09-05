import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// #819: GitHub stopped receiving pull requests after the mirror flip (#801),
// so .github/workflows/launcher-install-compat.yml never ran again. The check
// it performed — that scripts/install.sh still honours its contract with a
// real orbit-launcher build — now lives as the `launcher_install_compat` job
// in .gitlab-ci.yml. This test pins that job's shape instead of the retired
// workflow's.
const gitlabCi = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");

function jobBlock(job, endMarker) {
  const start = gitlabCi.indexOf(`\n${job}:\n`);
  const end = gitlabCi.indexOf(endMarker, start);
  expect(start, `job "${job}" not found in .gitlab-ci.yml`).toBeGreaterThanOrEqual(0);
  expect(end, `"${endMarker}" not found after "${job}" in .gitlab-ci.yml`).toBeGreaterThan(start);
  return gitlabCi.slice(start, end);
}

const launcherCompatJob = () => jobBlock("launcher_install_compat", "\n# --- publish");

describe("launcher install compatibility gate", () => {
  it("no longer exists as a GitHub workflow", () => {
    // Deleted, not merely disarmed: a pull-request-only trigger left in place
    // is exactly the failure mode #819 fixes, since GitHub receives no pull
    // requests to fire it.
    expect(existsSync(new URL("../.github/workflows/launcher-install-compat.yml", import.meta.url))).toBe(false);
  });

  it("runs on the privileged Docker runner, not the shared one", () => {
    const job = launcherCompatJob();

    // The live suite drives a real Docker daemon, which the shared
    // (non-orbit-build) runner cannot grant.
    expect(job).toContain("extends: .privileged_runner");
    expect(job).toContain("*docker_in_job");
    // Not the dind *service*: like smoke and repair_journeys, this job talks
    // to a deployment on a published loopback port, which a dind service
    // would put out of reach in its own network namespace.
    expect(job).not.toContain("extends: .dind");
  });

  it("builds orbit-launcher and runs its live test suite", () => {
    const job = launcherCompatJob();

    expect(job).toContain("git clone --quiet https://github.com/tomlawesome/orbit-launcher.git launcher");
    expect(job).toContain('go build -o "$CI_PROJECT_DIR/.orbit-launcher-bin/orbit-launcher" ./cmd/orbit-launcher');
    expect(job).toContain("go test -tags live -count=1 -v -timeout 30m ./test/live/...");
    // Overridable orbit-launcher ref, defaulting to its own dev branch —
    // the workflow_dispatch input's equivalent.
    expect(job).toMatch(/LAUNCHER_REF:\s*dev/u);
  });

  it("points the launcher at this commit's own install.sh, served without a token", () => {
    const job = launcherCompatJob();

    // The checkout's file over loopback: no repository-files URL, because
    // that would carry a job token the launcher's raw log could echo.
    expect(job).toContain('ORBIT_LAUNCHER_INSTALL_SCRIPT_URL="http://127.0.0.1:');
    expect(job).toContain('"$CI_PROJECT_DIR/scripts/install.sh"');
    expect(job).not.toContain("job_token");
    expect(job).not.toContain("CI_JOB_TOKEN");
    // The job must outlive the suite's own 30-minute limit.
    expect(job).toMatch(/timeout: 35m/u);
    expect(job).toContain("-timeout 30m");
  });

  it("always runs on a merge request into main, the promotion gate", () => {
    const job = launcherCompatJob();

    expect(job).toContain('CI_MERGE_REQUEST_TARGET_BRANCH_NAME:-}" = "main"');
    // Every other merge-request or delivery-branch pipeline reaches the job,
    // but the job itself narrows further by classified scope, not by rules:.
    expect(job).toContain('CI_PIPELINE_SOURCE == "merge_request_event"');
    expect(job).toContain('CI_COMMIT_BRANCH == "dev" || $CI_COMMIT_BRANCH == "preview" || $CI_COMMIT_BRANCH =~ /^hotfix\\//');
  });

  it("narrows to installer or job-definition changes off the classifier, not general system risk", () => {
    const job = launcherCompatJob();

    expect(job).toContain("ORBIT_LAUNCHER_COMPAT");
    expect(job).not.toContain("ORBIT_SYSTEM");
  });

  it("never runs in a scheduled pipeline and is a required check", () => {
    const job = launcherCompatJob();

    expect(job).toContain("*not_scheduled");
    expect(job).toContain("allow_failure: false");
  });

  it("collects Docker and installer diagnostics as an artifact regardless of outcome (#819 follow-up)", () => {
    const job = launcherCompatJob();

    // The live suite tears its own compose stack down on the way out, so the
    // after_script must gather evidence without depending on the job's own
    // exit code.
    expect(job).toContain("mkdir -p .orbit-launcher-diagnostics");
    expect(job).toContain("docker info > .orbit-launcher-diagnostics/docker-info.txt");
    expect(job).toContain("docker compose -p \"$project\" logs --no-color --timestamps");
    expect(job).toContain("docker logs --timestamps \"$container\"");
    expect(job).toContain("df -h > .orbit-launcher-diagnostics/df-h.txt");
    expect(job).toContain("cp /tmp/dockerd.log .orbit-launcher-diagnostics/dockerd.log");
    expect(job).toContain(".orbit-launcher-diagnostics/");
    // The whole artifacts: block this after_script output belongs to must be
    // collected win or lose, the same way the raw log already is.
    expect(job).toMatch(/artifacts:\s*\n\s*name: orbit-launcher-compat-live-raw-log\s*\n\s*paths:\s*\n\s*- \.orbit-launcher-live-raw\.log\*\s*\n\s*- \.orbit-launcher-diagnostics\/\s*\n\s*expire_in: 7 days\s*\n\s*when: always/u);
  });

  it("classifies scripts/install.sh and its own job definition as launcher-compat scope", async () => {
    const { touchesLauncherInstallCompat } = await import("./classify-changed-paths.mjs");

    expect(touchesLauncherInstallCompat(["scripts/install.sh"])).toBe(true);
    expect(touchesLauncherInstallCompat([".gitlab-ci.yml"])).toBe(true);
    expect(touchesLauncherInstallCompat(["README.md"])).toBe(false);
  });
});
