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

// The rules: block build_launcher and launcher_install_compat now share
// (ADR-0031 #3) lives in its own anchor immediately above build_launcher,
// not inline in either job's own text, so tests that inspect rule content
// read it from here rather than from launcherCompatJob().
function launcherCompatRules() {
  const start = gitlabCi.indexOf("\n.launcher_compat_rules: &launcher_compat_rules\n");
  const end = gitlabCi.indexOf("\nbuild_launcher:\n", start);
  expect(start, ".launcher_compat_rules anchor not found in .gitlab-ci.yml").toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return gitlabCi.slice(start, end);
}

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

  it("installs build_launcher's own artifact and runs the launcher's live test suite against it (ADR-0031 #2)", () => {
    const job = launcherCompatJob();

    // The candidate binary is build_launcher's artifact now, not a fresh
    // build from a `dev` checkout: no more LAUNCHER_REF, and no `go build`
    // of the launcher command here.
    expect(job).not.toMatch(/LAUNCHER_REF/u);
    expect(job).not.toContain("go build -o");
    expect(job).not.toContain("./cmd/orbit-launcher");
    expect(job).toContain(
      'tar --extract --gunzip \\\n        --file "$CI_PROJECT_DIR/.orbit-launcher-artifacts/orbit-launcher_linux_amd64.tar.gz" \\\n        --directory "$CI_PROJECT_DIR/.orbit-launcher-bin"',
    );
    expect(job).toContain('chmod +x "$CI_PROJECT_DIR/.orbit-launcher-bin/orbit-launcher"');

    // The test *source* still comes from a checkout -- cloned to
    // .orbit-launcher-src, not `launcher`, because launcher/pin.json (ADR-0031
    // #2) already occupies that path in this checkout -- but at the pin's own
    // tag, read from launcher/pin.json, rather than an overridable ref.
    expect(job).toContain(
      'launcher_tag="$(sed -n \'s/.*"tag"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p\' launcher/pin.json | head -1)"',
    );
    expect(job).toContain(
      "git clone --quiet https://github.com/tomlawesome/orbit-launcher.git .orbit-launcher-src",
    );
    expect(job).toContain('git -C .orbit-launcher-src checkout --quiet "$launcher_tag"');
    expect(job).toContain("(cd .orbit-launcher-src && go test -tags live -count=1 -v -timeout 30m ./test/live/...)");
  });

  it("needs build_launcher's artifact, spelled out rather than through *needs_gated_image (ADR-0031 #2)", () => {
    const job = launcherCompatJob();

    expect(job).toMatch(/needs:\s*\n\s*- job: classify\s*\n\s*artifacts: true/u);
    expect(job).toMatch(/- job: build_launcher\s*\n\s*artifacts: true/u);
    expect(job).not.toContain("needs: *needs_gated_image");
  });

  it("points the launcher at this commit's own install.sh, served without a token", () => {
    const job = launcherCompatJob();

    // The checkout's file over loopback: no repository-files URL, because
    // that would carry a job token the launcher's raw log could echo.
    expect(job).toContain('installer_base="http://127.0.0.1:');
    expect(job).toContain('ORBIT_LAUNCHER_INSTALL_SCRIPT_URL="$installer_base/scripts/install.sh"');
    expect(job).not.toContain("job_token");
    expect(job).not.toContain("CI_JOB_TOKEN");
    // The job must outlive the suite's own 30-minute limit.
    expect(job).toMatch(/timeout: 35m/u);
    expect(job).toContain("-timeout 30m");
  });

  it("serves the whole configuration tree the launcher stages, at the paths it derives (#957)", () => {
    const job = launcherCompatJob();

    // orbit-launcher's in-console configuration stages its own tree before
    // install.sh runs, fetching these from bases it derives from the
    // install-script URL (scriptSourceURLs in internal/deploy/configure.go).
    // Serving install.sh alone made every one a 404, so the launcher fell
    // back to the terminal hand-off: silently before strict mode existed
    // (#926), as a hard stop after it (#957). Pinned here rather than left to
    // the compat job, which takes twenty minutes to say so.
    for (const served of [
      "scripts/install.sh",
      "scripts/configure.sh",
      "scripts/configuration.sh",
      "scripts/installer-ui.sh",
    ]) {
      expect(job).toContain(`["/${served}", "${served}"]`);
    }
    // The root file, one level up from the scripts directory — which is what
    // the /scripts prefix on the install-script URL above exists to produce.
    expect(job).toContain('["/.env-orbit.example", ".env-orbit.example"]');

    // Checked before the suite starts, so a file that stops being served
    // fails in seconds naming the file rather than after a full run naming
    // the hand-off.
    expect(job).toContain("did not serve $served_file byte for byte");
  });

  it("always runs on a merge request into main and on every delivery branch, unconditionally (#944)", () => {
    const rules = launcherCompatRules();

    // #944: ORBIT_LAUNCHER_COMPAT was a dotenv variable from `classify`, and
    // `rules:` runs before any job -- including `classify` -- so it could
    // never read it. The promotion gate and the delivery branches are now
    // unconditional `rules:` entries, neither carrying a `changes:` clause,
    // rather than a branch the job's own script took at runtime.
    expect(rules).toMatch(
      /- if: \$CI_COMMIT_BRANCH == "dev" \|\| \$CI_COMMIT_BRANCH == "preview" \|\| \$CI_COMMIT_BRANCH == "main" \|\| \$CI_COMMIT_BRANCH =~ \/\^hotfix\\\/\/\n {2}- if: \$CI_MERGE_REQUEST_TARGET_BRANCH_NAME == "main"\n {2}- if: \$CI_PIPELINE_SOURCE == "merge_request_event"\n/u,
    );
  });

  it("gates an ordinary merge request on rules: changes:, off the classifier's own launcher-compat patterns (#944)", async () => {
    const { touchesLauncherInstallCompat } = await import("./classify-changed-paths.mjs");
    const job = launcherCompatJob();
    const rules = launcherCompatRules();

    // The decision used to live in a script-level dotenv read; `rules:`
    // cannot make that read, so the script should no longer reach for either
    // classifier output as a shell variable (comments above the job still
    // name them, to explain why this axis exists separately from
    // ORBIT_SYSTEM).
    expect(job).not.toContain("${ORBIT_LAUNCHER_COMPAT");
    expect(job).not.toContain("${ORBIT_SYSTEM");

    const changesStart = rules.indexOf("    changes:\n");
    const changesEnd = rules.indexOf("\n  - when: manual", changesStart);
    expect(changesStart, "no changes: block on the merge-request rule").toBeGreaterThan(-1);
    expect(changesEnd).toBeGreaterThan(changesStart);
    const listed = [...rules.slice(changesStart, changesEnd).matchAll(/^ {8}- (\S+)$/gmu)].map((match) => match[1]);

    // touchesLauncherInstallCompat has no catch-all default (unlike
    // ORBIT_SYSTEM's classifyCiRisk), so this list can and should be an
    // exact translation of launcherCompatPatterns rather than a widened one.
    // launcher/pin.json and scripts/ci/build-launcher.sh joined it with
    // ADR-0031: build_launcher now builds and installs the pinned launcher
    // instead of always checking out `dev`, so a pin bump or a change to how
    // it is built is part of what this job proves too.
    const concretePaths = [
      "scripts/install.sh",
      ".gitlab-ci.yml",
      "Dockerfile",
      ".dockerignore",
      "docker-compose.yml",
      "docker-compose.mail.yml",
      ".env-orbit.example",
      "config/tika-config.json",
      "scripts/configure.sh",
      "scripts/installer-ui.sh",
      "scripts/configuration.sh",
      "scripts/backup.sh",
      "scripts/restore.sh",
      "scripts/repair.sh",
      "scripts/engine-check.sh",
      "launcher/pin.json",
      "scripts/ci/build-launcher.sh",
    ];
    for (const path of concretePaths) {
      expect(touchesLauncherInstallCompat([path]), path).toBe(true);
    }
    expect(listed.sort()).toEqual(concretePaths.sort());

    // A change outside that scope leaves both agreeing there is nothing to
    // prove: the classifier's verdict and the rules: list have to match, or
    // the job could run when the classifier says it need not, or -- worse --
    // stay unrun when the classifier says it should.
    expect(touchesLauncherInstallCompat(["README.md"])).toBe(false);
    expect(listed).not.toContain("README.md");
  });

  it("never runs in a scheduled pipeline and is a required check", () => {
    const job = launcherCompatJob();

    expect(launcherCompatRules()).toContain("*not_scheduled");
    expect(job).toContain("allow_failure: false");
  });

  it("build_launcher shares the exact same rules: as launcher_install_compat (ADR-0031 #3)", () => {
    const job = launcherCompatJob();
    const buildLauncherJob = jobBlock("build_launcher", "\nlauncher_install_compat:");

    expect(job).toContain("rules: *launcher_compat_rules");
    expect(buildLauncherJob).toContain("rules: *launcher_compat_rules");
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
    expect(job).toMatch(/artifacts:\s*\n\s*name: orbit-launcher-compat-live-raw-log\s*\n\s*paths:\s*\n\s*- \.orbit-launcher-live-raw\.log\*\s*\n\s*- \.orbit-launcher-diagnostics\/\s*\n(?:\s*- \S+\s*\n)*\s*expire_in: 7 days\s*\n\s*when: always/u);
  });

  it("classifies scripts/install.sh and its own job definition as launcher-compat scope", async () => {
    const { touchesLauncherInstallCompat } = await import("./classify-changed-paths.mjs");

    expect(touchesLauncherInstallCompat(["scripts/install.sh"])).toBe(true);
    expect(touchesLauncherInstallCompat([".gitlab-ci.yml"])).toBe(true);
    expect(touchesLauncherInstallCompat(["README.md"])).toBe(false);
  });
});
