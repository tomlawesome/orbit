import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { jobBlock as readJob } from "./test-support/gitlab-ci.mjs";

// #819: GitHub stopped receiving pull requests after the mirror flip (#801),
// so .github/workflows/launcher-install-compat.yml never ran again. The check
// it performed — that scripts/install.sh still honours its contract with a
// real orbit-launcher build — now lives as the `launcher_install_compat` job
// in .gitlab-ci.yml. This test pins that job's shape instead of the retired
// workflow's.
const gitlabCi = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");

// The shared reader (#1362) ends a block at the next top-level key. Some of
// these jobs are read up to a marker that sits before that key (a comment), so
// the block is cut again at the marker, or at its own end when the marker is
// the next header.
function jobBlock(job, endMarker) {
  const block = `\n${readJob(job)}`;
  const cut = block.indexOf(endMarker);
  return cut < 0 ? block.replace(/\n$/u, "") : block.slice(0, cut);
}

const launcherCompatJob = () => jobBlock("launcher_install_compat", "\n# --- publish");

// The rules launcher_install_compat runs on (ADR-0031 #3) live in anchors
// above the build jobs, not inline in any job's own text, so tests that
// inspect rule content read them from here rather than from
// launcherCompatJob(). Since #1608 they are two lists -- the release
// branches' (build_launcher) and every other ref's (build_launcher_branch) --
// and .launcher_compat_rules joins them, so this returns the text from the
// first list through the joined one.
function launcherCompatRules() {
  const start = gitlabCi.indexOf("\n.launcher_release_rules: &launcher_release_rules\n");
  const end = gitlabCi.indexOf("\n.build_launcher:\n", start);
  expect(start, ".launcher_release_rules anchor not found in .gitlab-ci.yml").toBeGreaterThanOrEqual(0);
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
    // #2) already occupies that path in this checkout -- at the pin's own tag,
    // which scripts/ci/checkout-launcher-source.sh refuses unless it resolves
    // to the pinned commit, the same refusal build-launcher.sh makes.
    expect(job).toContain("bash scripts/ci/checkout-launcher-source.sh .orbit-launcher-src");
    expect(job).not.toContain("git clone --quiet https://github.com/tomlawesome/orbit-launcher.git");
    expect(job).not.toContain('checkout --quiet "$launcher_tag"');
    // #1560: as the unprivileged orbit-ci, because launcher v0.4.3 refuses root.
    expect(job).toContain("useradd --create-home --shell /bin/bash --groups docker orbit-ci");
    expect(job).toContain(
      "(cd .orbit-launcher-src && setpriv --reuid=orbit-ci --regid=orbit-ci --init-groups -- env -u CI_JOB_TOKEN -u CI_BUILD_TOKEN -u CI_REGISTRY_PASSWORD -u CI_DEPENDENCY_PROXY_PASSWORD -u CI_REPOSITORY_URL -u CI_DEPLOY_PASSWORD -u GITLAB_RELEASE_TOKEN -u GHCR_PUBLISH_TOKEN -u BASE_REPIN_TOKEN -u DOOR_IMPORT_TOKEN -u RENOVATE_TOKEN -u GITHUB_COM_TOKEN -u SIDECAR_ISSUE_TOKEN -u ORBIT_REGISTRY_TOKEN -u ORBIT_READ_TOKEN HOME=/home/orbit-ci go test -tags live -count=1 -v -timeout 30m ./test/live/...)",
    );
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
    // Named only where the unprivileged run drops it (#1560), never used.
    expect(job.replaceAll("-u CI_JOB_TOKEN ", "")).not.toContain("CI_JOB_TOKEN");
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
    // #1210 deleted configuration.sh; serving a file that no longer exists
    // would stop the job before it starts.
    expect(job).not.toContain("scripts/configuration.sh");
  });

  it("always runs on a merge request into main and on every delivery branch, unconditionally (#944)", () => {
    const rules = launcherCompatRules();

    // #944: ORBIT_LAUNCHER_COMPAT was a dotenv variable from `classify`, and
    // `rules:` runs before any job -- including `classify` -- so it could
    // never read it. The promotion gate and the delivery branches are now
    // unconditional `rules:` entries, neither carrying a `changes:` clause,
    // rather than a branch the job's own script took at runtime.
    // Since #1608 the release branches sit in their own list (build_launcher)
    // and dev and main in the other (build_launcher_branch); together they
    // still name every delivery branch with no `changes:` clause.
    expect(rules).toMatch(
      /\.launcher_release_rules: &launcher_release_rules\n {2}- !reference \[\.backmerge-skip, job_rule\]\n {2}- \*not_on_main_push\n {2}- \*not_scheduled\n {2}- if: \$CI_COMMIT_BRANCH == "preview" \|\| \$CI_COMMIT_BRANCH =~ \/\^hotfix\\\/\/\n/u,
    );
    expect(rules).toMatch(
      /- if: \$CI_COMMIT_BRANCH == "dev" \|\| \$CI_COMMIT_BRANCH == "main"\n {2}- if: \$CI_MERGE_REQUEST_TARGET_BRANCH_NAME == "main"\n {2}- if: \$CI_PIPELINE_SOURCE == "merge_request_event"\n/u,
    );
    expect(rules).toMatch(/\.launcher_compat_rules: &launcher_compat_rules\n {2}- !reference \[\.backmerge-skip, job_rule\]\n {2}- \*launcher_release_rules\n {2}- \*launcher_branch_rules\n/u);
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
      "docker-compose.kek-rotation.yml",
      "docker-compose.no-document-key.yml",
      ".env-orbit.example",
      "config/tika-config.json",
      "scripts/configure.sh",
      "scripts/installer-ui.sh",
      "scripts/backup.sh",
      "scripts/restore.sh",
      "scripts/repair.sh",
      "scripts/export-recovery-bundle.sh",
      "scripts/import-recovery-bundle.sh",
      "scripts/end-maintenance.sh",
      "launcher/pin.json",
      "scripts/ci/build-launcher.sh",
      "scripts/ci/checkout-launcher-source.sh",
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

  it("the two launcher builds together run on exactly launcher_install_compat's rules (ADR-0031 #3, #1608)", () => {
    const job = launcherCompatJob();
    const buildLauncherJob = jobBlock("build_launcher", "\nbuild_launcher_branch:");
    const branchJob = jobBlock("build_launcher_branch", "\nlauncher_install_compat:");

    expect(job).toContain("rules: *launcher_compat_rules");
    expect(buildLauncherJob).toContain("rules: *launcher_release_rules");
    expect(branchJob).toContain("rules: *launcher_branch_rules");
    // The branch list opens by refusing the release branches, so the two
    // builds never both run, and compat (release list, then branch list)
    // runs wherever one of them does.
    expect(launcherCompatRules()).toMatch(
      /\.launcher_branch_rules: &launcher_branch_rules\n {2}- !reference \[\.backmerge-skip, job_rule\]\n {2}- \*not_on_main_push\n {2}- \*not_scheduled\n {2}- if: \$CI_COMMIT_BRANCH == "preview" \|\| \$CI_COMMIT_BRANCH =~ \/\^hotfix\\\/\/\n {4}when: never\n/u,
    );
    // compat takes whichever build ran.
    expect(job).toMatch(/- job: build_launcher\n\s*artifacts: true\n\s*optional: true/u);
    expect(job).toMatch(/- job: build_launcher_branch\n\s*artifacts: true\n\s*optional: true/u);
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
    expect(job).toMatch(/artifacts:\s*\n\s*name: orbit-launcher-compat-live-raw-log\s*\n\s*paths:\s*\n\s*(?:#[^\n]*\n\s*)?- \.orbit-launcher-live\/\s*\n\s*- \.orbit-launcher-diagnostics\/\s*\n(?:\s*- \S+\s*\n)*\s*expire_in: 7 days\s*\n\s*when: always/u);
  });

  it("classifies scripts/install.sh and its own job definition as launcher-compat scope", async () => {
    const { touchesLauncherInstallCompat } = await import("./classify-changed-paths.mjs");

    expect(touchesLauncherInstallCompat(["scripts/install.sh"])).toBe(true);
    expect(touchesLauncherInstallCompat([".gitlab-ci.yml"])).toBe(true);
    expect(touchesLauncherInstallCompat(["README.md"])).toBe(false);
  });
});

// #1666: the upgrade_cell_launcher job runs scripts/ci/upgrade-cell-launcher.sh
// as orbit-ci, the way launcher_install_compat runs the launcher's live suite
// (the launcher refuses root, ai/orbit-launcher#331).
describe("upgrade_cell_launcher job (#1666)", () => {
  const cellJob = () => jobBlock("upgrade_cell_launcher", "\n# Live evidence");
  const code = (text) =>
    text
      .split("\n")
      .filter((line) => !/^\s*#/u.test(line))
      .join("\n");

  it("no longer carries the blocked-on-#331 stub", () => {
    const job = cellJob();
    expect(job).not.toMatch(/blocked on ai\/orbit-launcher#331/u);
    expect(code(job)).not.toMatch(/launcher cell blocked/u);
  });

  it("runs scripts/ci/upgrade-cell-launcher.sh as orbit-ci, after useradd and chown", () => {
    const job = code(cellJob());
    const useradd = job.indexOf("useradd --create-home --shell /bin/bash --groups docker orbit-ci");
    const chown = job.indexOf("chown -R orbit-ci:orbit-ci");
    const setpriv = job.indexOf("setpriv --reuid=orbit-ci --regid=orbit-ci --init-groups");
    const script = job.indexOf("scripts/ci/upgrade-cell-launcher.sh");
    expect(useradd, "useradd").toBeGreaterThan(-1);
    expect(chown, "chown").toBeGreaterThan(useradd);
    expect(setpriv, "setpriv").toBeGreaterThan(chown);
    expect(script, "script").toBeGreaterThan(setpriv);
    // One command: setpriv runs the script, not some other step.
    expect(job).toMatch(/setpriv --reuid=orbit-ci --regid=orbit-ci --init-groups -- [^\n]*scripts\/ci\/upgrade-cell-launcher\.sh/u);
    expect(job).toMatch(/HOME=\S*orbit-ci/u);
  });

  it("checks the launcher source out from launcher/pin.json and hands it to orbit-ci", () => {
    const job = code(cellJob());
    expect(job).toContain("bash scripts/ci/checkout-launcher-source.sh .orbit-launcher-src");
    expect(job.indexOf("checkout-launcher-source.sh")).toBeLessThan(job.indexOf("chown -R orbit-ci:orbit-ci"));
    expect(job).toMatch(/chown -R orbit-ci:orbit-ci[^\n]*\.orbit-launcher-src/u);
    expect(job).toMatch(/UPGRADE_CELL_LAUNCHER_SRC[:=]\s*"?\$?\{?CI_PROJECT_DIR\}?\/\.orbit-launcher-src/u);
  });

  it("takes the launcher binary from build_launcher's artifact", () => {
    const job = cellJob();
    expect(job).toMatch(/- job: build_launcher\n\s*artifacts: true\n/u);
    expect(job).toMatch(/- job: classify\n\s*artifacts: true\n/u);
    expect(job).toMatch(/- job: build_image\n\s*artifacts: true\n/u);
    expect(code(job)).toContain(".orbit-launcher-artifacts/orbit-launcher_linux_amd64.tar.gz");
    expect(code(job)).toMatch(/ORBIT_LAUNCHER_LIVE_BINARY[:=]\s*"?\$?\{?CI_PROJECT_DIR\}?\/\.orbit-launcher-bin\/orbit-launcher/u);
  });

  it("sets every input upgrade-cell-launcher.sh and upgrade-cell.sh read from the job", () => {
    const job = code(cellJob());
    expect(job).toContain("IMAGE_NAME: tomlawesome/orbit");
    expect(job).toMatch(/RUNNER_TEMP: \$CI_BUILDS_DIR\/orbit-runner-temp/u);
    expect(job).toContain("ORBIT_RUN_ID: $CI_PIPELINE_ID");
    expect(job).toContain("ORBIT_RUN_ATTEMPT: $CI_JOB_ID");
    expect(job).toContain("ORBIT_LAUNCHER_LIVE_BINARY");
    expect(job).toContain("UPGRADE_CELL_LAUNCHER_SRC");
    // go runs inside the cell, so the job installs the toolchain the pin's go.mod asks for.
    expect(job).toContain("/usr/local/go/bin");
    // RUNNER_TEMP must be writable by orbit-ci, which owns the install target.
    // Tightened: a chown of RUNNER_TEMP itself, after it is created.
    expect(job).toMatch(/chown[^\n]*orbit-ci:orbit-ci[^\n]*"\$RUNNER_TEMP"/u);
    expect(job.indexOf('mkdir -p "$RUNNER_TEMP"')).toBeGreaterThan(-1);
    expect(job.indexOf('mkdir -p "$RUNNER_TEMP"')).toBeLessThan(job.search(/chown[^\n]*"\$RUNNER_TEMP"/u));
  });

  it("starts the in-job daemon, and the lane gate and SKIP stay", () => {
    const job = cellJob();
    expect(job).toContain("- *docker_in_job");
    expect(job).toMatch(/after_script:\n\s*- \*docker_in_job_teardown/u);
    expect(job).toContain("orbit_lane_admits upgrade_cell_launcher || exit 0");
    expect(job).toContain('"${ORBIT_UPGRADE_LAUNCHER:-true}" = "false"');
    expect(job).toMatch(/upgrade-cell SKIP[^\n]*ORBIT_UPGRADE_SINCE/u);
  });

  // Rules: the promotion merge request and hotfix pushes (59a), pinned in
  // gitlab-ci-lanes.test.mjs ("the verdict on each of the seven pipeline kinds").
  it("keeps the 25m timeout (#1666 note 52634)", () => {
    expect(cellJob()).toMatch(/^ {2}timeout: 25m$/mu);
  });

  it("collects upgrade_cell's artifacts and junit", () => {
    const job = cellJob();
    expect(code(job)).toMatch(/artifacts:\n\s+paths:\n\s+- upgrade-cells\/\n\s+reports:\n\s+junit: upgrade-cells\/\*\.xml\n\s+expire_in: 14 days\n\s+when: always/u);
  });

  // Review findings on 687f13f9 (#1666).
  // The script lines before the final setpriv step, comments removed.
  const preSetpriv = () => {
    const job = code(cellJob());
    const end = job.lastIndexOf("setpriv --reuid=orbit-ci --regid=orbit-ci --init-groups -- env HOME=/home/orbit-ci bash scripts/ci/upgrade-cell-launcher.sh");
    expect(end, "final setpriv step").toBeGreaterThan(-1);
    return job.slice(0, end);
  };
  // The first literal block after the lane gate: the early SKIP gate.
  const earlyGate = () => {
    const job = cellJob();
    const start = job.indexOf("orbit_lane_admits upgrade_cell_launcher || exit 0\n    - |\n");
    expect(start, "early gate block").toBeGreaterThan(-1);
    const rest = job.slice(job.indexOf("- |\n", start) + 5);
    const end = rest.search(/\n {4}- /u);
    return rest
      .slice(0, end)
      .split("\n")
      .map((l) => l.replace(/^ {6}/u, ""))
      .join("\n");
  };
  const runGate = (env) => {
    const r = spawnSync("bash", ["-c", earlyGate()], {
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8",
    });
    return { status: r.status, out: r.stdout + r.stderr };
  };

  it("fills .orbit-upgrade-old from the latest-1 tag as root before setpriv (finding 1)", () => {
    const pre = preSetpriv();
    // Which version: upgrade-cell.sh reads ORBIT_UPGRADE_SLOT_LATEST_1 for slot latest-1.
    const fetch = pre.search(/git fetch[^\n]*(?:tag|refs\/tags)[^\n]*ORBIT_UPGRADE_SLOT_LATEST_1/u);
    const archive = pre.search(/git archive[^\n]*ORBIT_UPGRADE_SLOT_LATEST_1[^\n]*scripts \.env-orbit\.example[^\n]*\.orbit-upgrade-old/u);
    expect(fetch, "git fetch of the latest-1 tag").toBeGreaterThan(-1);
    expect(archive, "git archive of scripts and .env-orbit.example into .orbit-upgrade-old").toBeGreaterThan(fetch);
    // The chown of the old tree comes after it is filled.
    const chownOld = [...pre.matchAll(/chown[^\n]*orbit-ci:orbit-ci[^\n]*\.orbit-upgrade-old/gu)].map((m) => m.index);
    expect(chownOld.some((i) => i > archive), "chown to orbit-ci after the archive").toBe(true);
    // The same path the script is told to read.
    expect(code(cellJob())).toContain('UPGRADE_CELL_OLD_TREE="$CI_PROJECT_DIR/.orbit-upgrade-old"');
  });

  it("makes the installer-registry manifest writable by orbit-ci before setpriv (finding 2)", () => {
    // write-test-manifest.sh writes with `cat > "$output"`, a direct write into
    // the root-owned project dir, so the file must exist and be orbit-ci's.
    const pre = preSetpriv();
    const create = pre.search(/(?:touch|install -[^\n]*|: *>|>)[^\n]*\.orbit-installer-registry-manifest\.json/u);
    expect(create, "pre-create the manifest file").toBeGreaterThan(-1);
    const chown = pre.search(/chown[^\n]*orbit-ci[^\n]*\.orbit-installer-registry-manifest\.json/u);
    expect(chown, "chown the manifest file to orbit-ci").toBeGreaterThan(create);
  });

  it("the early gate skips for ORBIT_UPGRADE_MATRIX=false (finding 3)", () => {
    const r = runGate({ ORBIT_UPGRADE_MATRIX: "false", ORBIT_UPGRADE_SLOT_LATEST_1: "v1.2.3" });
    expect(r.out).toMatch(/upgrade-cell SKIP/u);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/ORBIT_UPGRADE_MATRIX/u);
  });

  it("the early gate skips for an empty latest-1 slot (finding 3)", () => {
    for (const env of [{}, { ORBIT_UPGRADE_SLOT_LATEST_1: "" }]) {
      const r = runGate(env);
      expect(r.out).toMatch(/upgrade-cell SKIP/u);
      expect(r.status).toBe(0);
      expect(r.out).toMatch(/latest-1/u);
    }
  });

  it("the early gate lets a full set of inputs through (finding 3)", () => {
    const r = runGate({ ORBIT_UPGRADE_SLOT_LATEST_1: "v1.2.3" });
    expect(r.out).not.toMatch(/SKIP/u);
  });

  it("every early SKIP uses shape=launcher and names its flag (finding 4)", () => {
    const off = runGate({ ORBIT_UPGRADE_LAUNCHER: "false", ORBIT_UPGRADE_SLOT_LATEST_1: "v1.2.3" });
    expect(off.out).toMatch(/upgrade-cell SKIP version=\S+ shape=launcher reason="[^"]*ORBIT_UPGRADE_LAUNCHER=false/u);
    const matrix = runGate({ ORBIT_UPGRADE_MATRIX: "false", ORBIT_UPGRADE_SLOT_LATEST_1: "v1.2.3" });
    expect(matrix.out).toMatch(/shape=launcher/u);
    for (const r of [off, matrix]) {
      expect(r.out).not.toContain("shape=plain");
      expect(r.out).not.toContain("nothing install-relevant changed");
    }
  });

  it("the job timeout outlasts the inner go test -timeout 15m (finding 5)", () => {
    const minutes = Number(/^ {2}timeout: (\d+)m$/mu.exec(cellJob())?.[1]);
    expect(minutes).toBeGreaterThan(15);
  });

  it("checks the launcher binary is executable by orbit-ci before the cell runs (finding 6)", () => {
    const pre = preSetpriv();
    expect(pre).toMatch(
      /setpriv --reuid=orbit-ci --regid=orbit-ci --init-groups -- test -x "\$CI_PROJECT_DIR\/\.orbit-launcher-bin\/orbit-launcher"/u,
    );
  });

  // The old-tree step as written in the job: from its git fetch to the line
  // before the manifest pre-create, comments removed and dedented.
  const oldTreeStep = () => {
    const job = preSetpriv();
    const start = job.indexOf("      git fetch");
    const end = job.indexOf('      : > "$CI_PROJECT_DIR/.orbit-installer-registry-manifest.json"');
    expect(start, "git fetch line").toBeGreaterThan(-1);
    expect(end, "manifest pre-create line").toBeGreaterThan(start);
    return job
      .slice(start, end)
      .split("\n")
      .map((l) => l.replace(/^ {6}/u, ""))
      .join("\n");
  };
  // Runs the step with a stub git that prints a fake remote URL and then fails
  // at `failAt` (fetch or archive).
  const runOldTree = (failAt) => {
    const dir = mkdtempSync(join(tmpdir(), "oldtree-"));
    try {
      mkdirSync(join(dir, "bin"));
      mkdirSync(join(dir, "proj", ".orbit-upgrade-old"), { recursive: true });
      mkdirSync(join(dir, "tmp"));
      const stub = [
        "#!/bin/bash",
        'if [ "$1" = "' + failAt + '" ]; then',
        '  echo "From https://user:tok@fake.invalid/org/repo.git"',
        '  echo "fatal: remote hung up unexpectedly"',
        '  echo "From https://user:tok@fake.invalid/org/repo.git" >&2',
        '  echo "fatal: remote hung up unexpectedly" >&2',
        "  echo",
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n");
      writeFileSync(join(dir, "bin", "git"), stub, { mode: 0o755 });
      const r = spawnSync("bash", ["-c", oldTreeStep()], {
        env: {
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          TMPDIR: join(dir, "tmp"),
          RUNNER_TEMP: join(dir, "tmp"),
          CI_PROJECT_DIR: join(dir, "proj"),
          ORBIT_UPGRADE_SLOT_LATEST_1: "v1.2.3",
        },
        cwd: join(dir, "proj"),
        encoding: "utf8",
      });
      return { status: r.status, out: r.stdout + r.stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  for (const failAt of ["fetch", "archive"]) {
    it(`a failing git ${failAt} of the old tree keeps its output out of the job log (#1666)`, () => {
      const r = runOldTree(failAt);
      expect(r.status).not.toBe(0);
      expect(r.out).not.toContain("fake.invalid");
      expect(r.out).not.toContain("tok@");
      const lines = r.out.split("\n").filter((l) => l.startsWith("old-tree-fetched:"));
      expect(lines, "one old-tree-fetched: line").toHaveLength(1);
      if (failAt === "fetch") {
        expect(lines[0]).toContain("fatal: remote hung up unexpectedly");
      }
    });
  }
});
