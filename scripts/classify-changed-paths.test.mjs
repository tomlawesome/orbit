import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEPLOYMENT_ASSETS, deploymentAssetSource } from "../src/lib/deployment-assets.ts";
import {
  CI_LANE,
  CI_RISK,
  ciRequirements,
  classifyCiLane,
  classifyCiRisk,
  isNonExecutablePath,
  pathRisk,
  requiresExecutableValidation,
  touchesLauncherInstallCompat,
  touchesLicencePolicy,
  touchesBrowserSuite,
  touchesWeb,
} from "./classify-changed-paths.mjs";

describe("changed-path CI risk classification", () => {
  it("keeps documentation and inert repository metadata in the fast lane", () => {
    for (const path of [
      "docs/feature-register.md",
      "docs/adr/0007-dual-pipeline-agent-governance.md",
      "README.md",
      "AGENTS.md",
      ".gitignore",
      ".github/ISSUE_TEMPLATE/delivery.yml",
    ]) {
      expect(pathRisk(path)).toBe(CI_RISK.FAST);
      expect(isNonExecutablePath(path)).toBe(true);
    }
  });

  it("keeps deterministic governance and policy controls in the fast lane", () => {
    for (const path of [
      "supply-chain/licence-policy.yml",
      "scripts/supply-chain-policy.test.mjs",
      "scripts/stable-promotion-policy.mjs",
      "scripts/stable-promotion-policy.test.mjs",
      "scripts/esbuild-override-policy.test.mjs",
    ]) {
      expect(pathRisk(path)).toBe(CI_RISK.FAST);
    }
  });

  // D1-F2 (#1151): a change confined to the vulnerability policy or its
  // evaluator must build and scan an image against it, not skip straight to
  // the fast lane.
  it("runs exact-image system validation for the vulnerability policy and its evaluator", () => {
    for (const path of [".github/supply-chain-policy.json", "scripts/supply-chain-policy.mjs"]) {
      expect(pathRisk(path)).toBe(CI_RISK.SYSTEM);
      expect(isNonExecutablePath(path)).toBe(false);
    }
  });

  it("runs real PostgreSQL integration for ordinary server changes", () => {
    for (const path of [
      "src/server/workspace-repository.ts",
      "src/server/household-repository.ts",
      "src/lib/workspace.ts",
      "tests/integration/workspace.test.ts",
      "scripts/test-integration.mjs",
    ]) {
      expect(pathRisk(path)).toBe(CI_RISK.INTEGRATION);
    }
  });

  it("runs exact-image system validation for cross-boundary and unknown changes", () => {
    for (const path of [
      ".github/workflows/publish-from-gitlab.yml",
      "Dockerfile",
      "docker-compose.yml",
      // The test/CI-only overlays moved under compose/ in #442 and must keep
      // the same lane they had at the root.
      "compose/docker-compose.acceptance.yml",
      "compose/docker-compose.ci-cap.yml",
      "config/tika-config.json",
      "package.json",
      // The root e2e harness moved under the suite it drives in #442; it
      // reaches this lane through tests/e2e/ now rather than a root pattern.
      "tests/e2e/playwright.config.ts",
      "public/favicon.svg",
      "src/app/page.tsx",
      "src/app/globals.css",
      "src/app/api/health/route.ts",
      "src/components/item-editor.tsx",
      "src/instrumentation.ts",
      "src/lib/auth/session.ts",
      "src/server/document-repository.ts",
      "src/server/documents/scanner.ts",
      "src/server/imap-ingestion.ts",
      "src/server/readiness.ts",
      "drizzle/0001_initial.sql",
      "scripts/install.sh",
      // Both run inside the image build and decide what it ships (#735).
      "scripts/web-deploy.sh",
      "scripts/web-pdfjs-runtime-check.mjs",
      "scripts/backup.sh",
      "tests/e2e/authenticated-documents.spec.ts",
      "some/new/directory/file.txt",
    ]) {
      expect(pathRisk(path)).toBe(CI_RISK.SYSTEM);
      expect(isNonExecutablePath(path)).toBe(false);
    }
  });

  /*
   * The fidelity gate's own trigger (#620). Narrower than system risk on
   * purpose: it is the only automatic check the v19 presentation layer has, so
   * it must run whenever that layer moves, and should not be charged to every
   * unrelated system-risk change.
   */
  it("runs the fidelity gate for the v19 front end and its dependency snapshots", () => {
    expect(touchesWeb(["web/src/routes/home/+page.svelte"])).toBe(true);
    expect(touchesWeb(["web/tests/fidelity/baselines/home.png"])).toBe(true);
    expect(touchesWeb(["pnpm-lock.yaml"])).toBe(true);
    expect(touchesWeb(["pnpm-workspace.yaml"])).toBe(true);
    expect(touchesWeb(["docs/architecture.md", "web/package.json"])).toBe(true);
  });

  it("does not run the fidelity gate for changes that cannot reach the v19 build", () => {
    expect(touchesWeb(["docs/architecture.md"])).toBe(false);
    expect(touchesWeb(["src/server/documents/scanner.ts"])).toBe(false);
    expect(touchesWeb(["Dockerfile"])).toBe(false);
    expect(touchesWeb(["scripts/repair.sh", "README.md"])).toBe(false);
  });

  it("fails safe to running the fidelity gate without a usable comparison", () => {
    expect(touchesWeb([])).toBe(true);
    expect(touchesWeb(undefined)).toBe(true);
    expect(touchesWeb(null)).toBe(true);
  });

  it("exposes the fidelity trigger alongside the other lane requirements", () => {
    expect(ciRequirements(["web/src/lib/Chrome.svelte"]).web).toBe(true);
    expect(ciRequirements(["docs/architecture.md"]).web).toBe(false);
  });

  /*
   * The browser suite's own trigger (#1181): everything that moves the front
   * end, plus the suite itself. A merge request that only adds or changes a
   * spec under tests/e2e/ used to skip the suite, so the new spec first ran
   * after merge. Wider than `web` on purpose, and kept apart from it: a spec
   * change cannot move what `fidelity` photographs.
   */
  it("runs the browser suite when only the suite itself changed (#1181)", () => {
    expect(touchesBrowserSuite(["tests/e2e/v19-axe-sweep.spec.ts"])).toBe(true);
    expect(touchesBrowserSuite(["tests/e2e/support/fixtures.ts"])).toBe(true);
    expect(touchesBrowserSuite(["tests/e2e/playwright.config.ts"])).toBe(true);
    expect(touchesBrowserSuite(["scripts/test-frontend.sh"])).toBe(true);
    expect(ciRequirements(["tests/e2e/v19-create.spec.ts"]).e2e).toBe(true);
    // ...without charging the fidelity gate for it.
    expect(ciRequirements(["tests/e2e/v19-create.spec.ts"]).web).toBe(false);
  });

  /*
   * The quarantine list and its check decide which browser tests the gates
   * exclude, so a merge request touching only them must still run the suite.
   */
  it("runs the browser suite when only the quarantine list or its check changed", () => {
    for (const path of ["tests/quarantine.txt", "scripts/check-quarantine.mjs"]) {
      expect(touchesBrowserSuite([path]), path).toBe(true);
      expect(ciRequirements([path]).e2e, path).toBe(true);
      // ...without charging the fidelity gate for it.
      expect(ciRequirements([path]).web, path).toBe(false);
    }
  });

  it("runs the browser suite whenever the fidelity gate's front end moves", () => {
    for (const path of ["web/src/routes/home/+page.svelte", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
      expect(touchesBrowserSuite([path])).toBe(true);
    }
  });

  it("does not run the browser suite for changes that reach neither the front end nor the suite", () => {
    expect(touchesBrowserSuite(["docs/architecture.md"])).toBe(false);
    expect(touchesBrowserSuite(["src/server/documents/scanner.ts"])).toBe(false);
    expect(touchesBrowserSuite(["tests/integration/items.test.ts"])).toBe(false);
    expect(ciRequirements(["docs/architecture.md"]).e2e).toBe(false);
  });

  it("fails safe to running the browser suite without a usable comparison", () => {
    expect(touchesBrowserSuite([])).toBe(true);
    expect(touchesBrowserSuite(undefined)).toBe(true);
    expect(touchesBrowserSuite(null)).toBe(true);
  });

  /*
   * The `licence_policy` gate's own trigger (#815): a change that can add or
   * move a dependency reaches it, one that cannot does not.
   */
  it("runs the licence gate for dependency-graph and policy-file changes", () => {
    expect(touchesLicencePolicy(["pnpm-lock.yaml"])).toBe(true);
    expect(touchesLicencePolicy(["package.json"])).toBe(true);
    expect(touchesLicencePolicy(["web/package.json"])).toBe(true);
    expect(touchesLicencePolicy(["pnpm-workspace.yaml"])).toBe(true);
    expect(touchesLicencePolicy(["supply-chain/licence-policy.yml"])).toBe(true);
  });

  it("does not run the licence gate for changes that cannot add or move a dependency", () => {
    expect(touchesLicencePolicy(["docs/architecture.md"])).toBe(false);
    expect(touchesLicencePolicy(["src/server/documents/scanner.ts"])).toBe(false);
  });

  it("fails safe to running the licence gate without a usable comparison", () => {
    expect(touchesLicencePolicy([])).toBe(true);
    expect(touchesLicencePolicy(undefined)).toBe(true);
    expect(touchesLicencePolicy(null)).toBe(true);
  });

  it("exposes the licence trigger alongside the other lane requirements", () => {
    expect(ciRequirements(["pnpm-lock.yaml"]).licence).toBe(true);
    expect(ciRequirements(["docs/architecture.md"]).licence).toBe(false);
  });

  it("puts the v19 front end in the system lane by rule, not by fallback", () => {
    /*
     * These already reached CI_RISK.SYSTEM through the catch-all default for
     * unmatched paths, so this pins the intent rather than changing behaviour:
     * web/ ships and the e2e suite drives it, so if the default is ever
     * softened, web/ must not soften with it (#620).
     */
    for (const path of [
      "web/src/routes/home/+page.svelte",
      "web/src/lib/flight/engine.js",
      "web/package.json",
      "web/playwright.config.js",
      "web/tests/fidelity/baselines/home.png",
    ]) {
      expect(pathRisk(path)).toBe(CI_RISK.SYSTEM);
    }
  });

  it("treats unit-only test changes as fast and integration fixtures as integration", () => {
    expect(pathRisk("src/server/workspace-repository.test.ts")).toBe(CI_RISK.FAST);
    expect(pathRisk("src/lib/workspace.test.ts")).toBe(CI_RISK.FAST);
    expect(pathRisk("tests/integration/document-lifecycle.test.ts")).toBe(CI_RISK.INTEGRATION);
  });

  it("uses the production graph result for lockfile and workspace-only changes", () => {
    expect(pathRisk("pnpm-lock.yaml", { productionDependencyGraphChanged: false })).toBe(CI_RISK.FAST);
    expect(pathRisk("pnpm-workspace.yaml", { productionDependencyGraphChanged: false })).toBe(CI_RISK.FAST);
    expect(pathRisk("pnpm-lock.yaml", { productionDependencyGraphChanged: true })).toBe(CI_RISK.SYSTEM);
    expect(pathRisk("pnpm-workspace.yaml", { productionDependencyGraphChanged: true })).toBe(CI_RISK.SYSTEM);
    expect(pathRisk("pnpm-lock.yaml")).toBe(CI_RISK.SYSTEM);
    expect(ciRequirements(["pnpm-lock.yaml"], {
      productionDependencyGraphChanged: false,
    })).toEqual({
      risk: CI_RISK.FAST,
      // A lockfile is in neither narrow lane, so the whole pipeline is on
      // offer and the axes below decide which of it runs (#889).
      lane: CI_LANE.FULL,
      build: true,
      integration: false,
      system: false,
      // A lockfile change can move what the v19 build resolves, so the
      // fidelity gate runs even when the lane stays fast.
      web: true,
      e2e: true,
      // A lockfile change is exactly what the licence gate exists to catch.
      licence: true,
      launcherCompat: false,
    });
  });

  it("narrows launcher_install_compat to the installer contract and its own job definition (#819)", () => {
    expect(touchesLauncherInstallCompat(["scripts/install.sh"])).toBe(true);
    expect(touchesLauncherInstallCompat([".gitlab-ci.yml"])).toBe(true);
    expect(touchesLauncherInstallCompat(["docs/architecture.md", "scripts/install.sh"])).toBe(true);
    expect(touchesLauncherInstallCompat(["src/server/documents/scanner.ts"])).toBe(false);
    expect(touchesLauncherInstallCompat(["README.md"])).toBe(false);
    expect(touchesLauncherInstallCompat([])).toBe(true);
    expect(touchesLauncherInstallCompat(undefined)).toBe(true);
    expect(ciRequirements(["scripts/install.sh"]).launcherCompat).toBe(true);
    expect(ciRequirements(["README.md"]).launcherCompat).toBe(false);
  });

  /*
   * Since !895 (ADR-0019) the image carries the deployment assets, so
   * install.sh takes its helpers from the digest under test rather than from a
   * source revision, and every bundled asset is now inside what this job
   * proves. The list is the Dockerfile's own: the two compose files, the
   * example environment file, the Tika configuration and the seven helper
   * scripts it copies to ./deploy/scripts/, plus the Dockerfile and
   * .dockerignore that decide what reaches the build at all.
   */
  it("arms launcher_install_compat for every asset the image now bundles (ADR-0019)", () => {
    for (const path of [
      "Dockerfile",
      ".dockerignore",
      "docker-compose.yml",
      "docker-compose.mail.yml",
      ".env-orbit.example",
      "config/tika-config.json",
      "scripts/configure.sh",
      "scripts/installer-ui.sh",
      "scripts/backup.sh",
      "scripts/restore.sh",
      "scripts/repair.sh",
    ]) {
      expect(touchesLauncherInstallCompat([path])).toBe(true);
      expect(ciRequirements([path]).launcherCompat).toBe(true);
    }
    // Not bundled, so still outside this job's reach: the acceptance-only
    // compose overlays and the container's own entrypoint.
    expect(touchesLauncherInstallCompat(["compose/docker-compose.acceptance.yml"])).toBe(false);
    expect(touchesLauncherInstallCompat(["scripts/container-entrypoint.sh"])).toBe(false);
  });

  it("arms launcher_install_compat for every deployment asset the image bundles", () => {
    for (const path of DEPLOYMENT_ASSETS.map(deploymentAssetSource)) {
      expect(touchesLauncherInstallCompat([path]), path).toBe(true);
      expect(ciRequirements([path]).launcherCompat, path).toBe(true);
    }
  });

  it("does not arm launcher_install_compat for scripts the image does not bundle", () => {
    for (const path of ["scripts/configuration.sh", "scripts/engine-check.sh"]) {
      expect(DEPLOYMENT_ASSETS).not.toContain(path);
      expect(touchesLauncherInstallCompat([path]), path).toBe(false);
      expect(ciRequirements([path]).launcherCompat, path).toBe(false);
    }
  });

  it("keeps the .gitlab-ci.yml launcher_install_compat path list in step with the bundled assets", () => {
    const lines = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8").split("\n");
    const anchor = lines.findIndex((line) => line.trim() === "- config/tika-config.json");
    expect(anchor).toBeGreaterThan(0);
    const indent = lines[anchor].match(/^\s*/)[0];
    const listed = [];
    for (let i = anchor; i >= 0 && lines[i].startsWith(`${indent}- `); i -= 1) listed.push(lines[i].trim().slice(2));
    for (let i = anchor + 1; i < lines.length && lines[i].startsWith(`${indent}- `); i += 1) listed.push(lines[i].trim().slice(2));
    for (const path of DEPLOYMENT_ASSETS.map(deploymentAssetSource)) expect(listed, path).toContain(path);
    expect(listed).not.toContain("scripts/configuration.sh");
    expect(listed).not.toContain("scripts/engine-check.sh");
  });

  // ADR-0031 #2/#3: build_launcher now builds and installs the pinned
  // launcher for this job to test, instead of always checking out `dev`, so
  // a pin bump or a change to how it is built is part of what this job
  // proves too.
  it("arms launcher_install_compat for the launcher pin and its build script (ADR-0031)", () => {
    expect(touchesLauncherInstallCompat(["launcher/pin.json"])).toBe(true);
    expect(touchesLauncherInstallCompat(["scripts/ci/build-launcher.sh"])).toBe(true);
    expect(touchesLauncherInstallCompat(["scripts/ci/checkout-launcher-source.sh"])).toBe(true);
    expect(ciRequirements(["launcher/pin.json"]).launcherCompat).toBe(true);
    // A different launcher/ file, or a different scripts/ci/ script, is
    // outside this job's reach.
    expect(touchesLauncherInstallCompat(["launcher/README.md"])).toBe(false);
    expect(touchesLauncherInstallCompat(["scripts/ci/write-release-manifest.sh"])).toBe(false);
  });

  it("builds executable and dependency-snapshot changes but not inert fast changes", () => {
    expect(ciRequirements(["README.md"]).build).toBe(false);
    expect(ciRequirements(["src/server/workspace-repository.test.ts"]).build).toBe(false);
    expect(ciRequirements(["src/server/workspace-repository.ts"]).build).toBe(true);
    expect(ciRequirements(["Dockerfile"]).build).toBe(true);
  });

  it("escalates mixed changes to the highest required lane", () => {
    expect(classifyCiRisk(["README.md", "src/server/workspace-repository.ts"])).toBe(CI_RISK.INTEGRATION);
    expect(classifyCiRisk(["src/server/workspace-repository.ts", "Dockerfile"])).toBe(CI_RISK.SYSTEM);
    expect(classifyCiRisk(["pnpm-lock.yaml", "scripts/esbuild-override-policy.test.mjs"], {
      productionDependencyGraphChanged: false,
    })).toBe(CI_RISK.FAST);
  });

  it("normalises separators so Windows-style paths classify identically", () => {
    expect(pathRisk("docs\\adr\\0001-example.md")).toBe(CI_RISK.FAST);
    expect(pathRisk("src\\server\\workspace-repository.ts")).toBe(CI_RISK.INTEGRATION);
    expect(pathRisk("src\\components\\item-editor.tsx")).toBe(CI_RISK.SYSTEM);
  });

  it("fails closed to system validation without a usable comparison", () => {
    expect(classifyCiRisk([])).toBe(CI_RISK.SYSTEM);
    expect(classifyCiRisk(undefined)).toBe(CI_RISK.SYSTEM);
    expect(classifyCiRisk(null)).toBe(CI_RISK.SYSTEM);
    expect(pathRisk("")).toBe(CI_RISK.SYSTEM);
  });

  /*
   * The two narrow lanes (#889). A lane is a verdict on the whole change, not
   * on a path: it holds only while every changed path belongs to it, and one
   * file outside puts the change back in the ordinary classified pipeline.
   * Which jobs each lane runs is `orbit_lane_admits` in .gitlab-ci.yml.
   */
  it("puts an ignore-file or licence-policy change in the ignore/policy lane", () => {
    expect(classifyCiLane([".gitleaksignore"])).toBe(CI_LANE.IGNORE_POLICY);
    expect(classifyCiLane(["supply-chain/licence-policy.yml"])).toBe(CI_LANE.IGNORE_POLICY);
    expect(classifyCiLane([".gitleaksignore", "supply-chain/licence-policy.yml"]))
      .toBe(CI_LANE.IGNORE_POLICY);
    expect(ciRequirements([".gitleaksignore"]).lane).toBe(CI_LANE.IGNORE_POLICY);
  });

  it("puts a change to the pipeline's own definition in the CI lane", () => {
    for (const path of [
      ".gitlab-ci.yml",
      "scripts/ci/scan-image.sh",
      "scripts/ci/licence-policy.mjs",
      "scripts/classify-changed-paths.mjs",
      "scripts/classify-changed-paths.test.mjs",
      "scripts/gitlab-ci-lanes.test.mjs",
    ]) {
      expect(classifyCiLane([path])).toBe(CI_LANE.CI);
    }
    expect(classifyCiLane([".gitlab-ci.yml", "scripts/ci/scan-image.sh"])).toBe(CI_LANE.CI);
    expect(ciRequirements([".gitlab-ci.yml"]).lane).toBe(CI_LANE.CI);
  });

  it("sends any change with a file outside a lane down the full pipeline", () => {
    // One file outside is enough, whichever lane the rest of the diff is in.
    expect(classifyCiLane([".gitleaksignore", "scripts/install.sh"])).toBe(CI_LANE.FULL);
    expect(classifyCiLane([".gitlab-ci.yml", "src/server/documents/scanner.ts"])).toBe(CI_LANE.FULL);
    expect(classifyCiLane(["docs/x.md", "scripts/install.sh"])).toBe(CI_LANE.FULL);
    // The two lanes do not combine: a diff spanning both is in neither.
    expect(classifyCiLane([".gitleaksignore", ".gitlab-ci.yml"])).toBe(CI_LANE.FULL);
    // Documentation is its own economy already -- the fast risk lane -- and
    // is not one of these two.
    expect(classifyCiLane(["docs/architecture.md"])).toBe(CI_LANE.FULL);
    expect(classifyCiRisk(["docs/architecture.md"])).toBe(CI_RISK.FAST);
  });

  it("fails safe to the full pipeline without a usable comparison", () => {
    expect(classifyCiLane([])).toBe(CI_LANE.FULL);
    expect(classifyCiLane(undefined)).toBe(CI_LANE.FULL);
    expect(classifyCiLane(null)).toBe(CI_LANE.FULL);
    expect(classifyCiLane([".gitleaksignore", ""])).toBe(CI_LANE.FULL);
    expect(classifyCiLane([".gitleaksignore", "   "])).toBe(CI_LANE.FULL);
  });

  it("normalises separators before deciding a lane", () => {
    expect(classifyCiLane(["scripts\\ci\\scan-image.sh"])).toBe(CI_LANE.CI);
    expect(classifyCiLane(["supply-chain\\licence-policy.yml"])).toBe(CI_LANE.IGNORE_POLICY);
  });

  /*
   * The no_change lane (#1597). A comparison that worked and found nothing is
   * a different fact from one that never ran, but only the script knows which
   * it was (`comparisonProven`); the pure functions keep failing safe.
   */
  it("exports the no_change lane", () => {
    expect(CI_LANE.NO_CHANGE).toBe("no_change");
    expect(Object.isFrozen(CI_LANE)).toBe(true);
  });

  it("still sends an empty or unusable path list to the full pipeline, since the functions carry no proof", () => {
    expect(classifyCiLane([])).toBe(CI_LANE.FULL);
    expect(classifyCiLane(undefined)).toBe(CI_LANE.FULL);
    expect(classifyCiLane(null)).toBe(CI_LANE.FULL);
    expect(ciRequirements([]).lane).toBe(CI_LANE.FULL);
    expect(ciRequirements(undefined).lane).toBe(CI_LANE.FULL);
    expect(ciRequirements([]).risk).toBe(CI_RISK.SYSTEM);
  });

  it("never selects no_change for a non-empty list of paths", () => {
    for (const paths of [["docs/a.md"], [".gitleaksignore"], [".gitlab-ci.yml"], ["src/server/a.ts"], [""]]) {
      expect(classifyCiLane(paths)).not.toBe("no_change");
      expect(ciRequirements(paths).lane).not.toBe("no_change");
    }
  });

  it("retains the executable compatibility predicate", () => {
    expect(requiresExecutableValidation(["docs/a.md", "README.md", ".gitignore"])).toBe(false);
    expect(requiresExecutableValidation(["docs/a.md", "src/server/a.ts"])).toBe(true);
    expect(requiresExecutableValidation([])).toBe(true);
  });
});

/*
 * The classifier run as a script (#1597). The script finds its repository from
 * its own location (`repositoryRoot` is `../` relative to the file), so it
 * cannot be pointed at another repository by an argument or a variable. These
 * tests therefore copy it into a throwaway repository and run it there. The
 * throwaway repository has hooks disabled and a dummy identity set on itself
 * only, so the host's commit hooks never see it.
 */
describe("classify-changed-paths.mjs as a script", () => {
  const script = new URL("./classify-changed-paths.mjs", import.meta.url);
  const zeros = "0".repeat(40);
  const absentCommit = "1".repeat(40);

  function cleanEnvironment() {
    const environment = { ...process.env };
    for (const name of Object.keys(environment)) {
      if (name.startsWith("GIT_")) delete environment[name];
    }
    return environment;
  }

  function makeRepository() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "orbit-classify-script-")));
    const git = (...args) =>
      execFileSync(
        "git",
        [
          "-c", "core.hooksPath=/dev/null",
          "-c", "user.name=Test Author",
          "-c", "user.email=test@example.invalid",
          "-c", "commit.gpgsign=false",
          ...args,
        ],
        { cwd: root, encoding: "utf8", env: cleanEnvironment() },
      ).trim();
    git("init", "--quiet");
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(script, join(root, "scripts", "classify-changed-paths.mjs"));
    return { root, git };
  }

  function commitFile(repository, path, content) {
    const target = join(repository.root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${content}\n`, "utf8");
    repository.git("add", "--", path);
    repository.git("commit", "--quiet", "-m", `write ${path}`);
    return repository.git("rev-parse", "HEAD");
  }

  function emptyCommit(repository) {
    repository.git("commit", "--quiet", "--allow-empty", "-m", "empty");
    return repository.git("rev-parse", "HEAD");
  }

  // The GITHUB_OUTPUT file as an object, plus the process's exit status.
  function runScript(repository, environment) {
    const output = join(repository.root, "github-output.txt");
    let status = 0;
    try {
      execFileSync(process.execPath, [join(repository.root, "scripts", "classify-changed-paths.mjs")], {
        cwd: repository.root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...cleanEnvironment(), GITHUB_OUTPUT: output, ...environment },
      });
    } catch (error) {
      status = error.status;
    }
    let written = "";
    try {
      written = readFileSync(output, "utf8");
    } catch {
      // An absent file means the script wrote nothing; the assertions say so.
    }
    const outputs = Object.fromEntries(
      written
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    return { status, outputs };
  }

  function withRepository(body) {
    const repository = makeRepository();
    try {
      body(repository);
    } finally {
      rmSync(repository.root, { recursive: true, force: true });
    }
  }

  const noChangeOutputs = {
    risk: "fast",
    lane: "no_change",
    build: "false",
    integration: "false",
    system: "false",
    web: "false",
    e2e: "false",
    licence: "false",
    launcher_compat: "false",
  };

  it("outputs lane=no_change and every axis off for two commits with identical trees", () => {
    withRepository((repository) => {
      const base = commitFile(repository, "docs/a.md", "one");
      const head = emptyCommit(repository);
      expect(head).not.toBe(base);
      expect(repository.git("rev-parse", `${base}^{tree}`)).toBe(repository.git("rev-parse", `${head}^{tree}`));

      const { status, outputs } = runScript(repository, { ORBIT_BASE_SHA: base, ORBIT_HEAD_SHA: head });
      expect(status).toBe(0);
      expect(outputs).toEqual(noChangeOutputs);
    });
  });

  it("outputs lane=no_change when a change is made and then undone between the two commits", () => {
    withRepository((repository) => {
      const base = commitFile(repository, "docs/a.md", "one");
      commitFile(repository, "docs/a.md", "two");
      const head = commitFile(repository, "docs/a.md", "one");

      const { outputs } = runScript(repository, { ORBIT_BASE_SHA: base, ORBIT_HEAD_SHA: head });
      expect(outputs).toEqual(noChangeOutputs);
    });
  });

  it("does not select no_change when the two commits differ", () => {
    withRepository((repository) => {
      const base = commitFile(repository, "docs/a.md", "one");
      const head = commitFile(repository, "docs/a.md", "two");

      const { outputs } = runScript(repository, { ORBIT_BASE_SHA: base, ORBIT_HEAD_SHA: head });
      expect(outputs.lane).toBe("full");
      expect(outputs.risk).toBe("fast");
    });
  });

  it("still outputs lane=full and risk=system when the base is not a commit", () => {
    withRepository((repository) => {
      const head = commitFile(repository, "docs/a.md", "one");

      for (const base of [absentCommit, zeros, "not-a-sha"]) {
        const { outputs } = runScript(repository, { ORBIT_BASE_SHA: base, ORBIT_HEAD_SHA: head });
        expect(outputs.lane, base).toBe("full");
        expect(outputs.risk, base).toBe("system");
        expect(outputs.build, base).toBe("true");
        expect(outputs.integration, base).toBe("true");
        expect(outputs.system, base).toBe("true");
      }
    });
  });

  it("still outputs lane=full and risk=system when the head is not a commit", () => {
    withRepository((repository) => {
      const base = commitFile(repository, "docs/a.md", "one");

      const { outputs } = runScript(repository, { ORBIT_BASE_SHA: base, ORBIT_HEAD_SHA: absentCommit });
      expect(outputs.lane).toBe("full");
      expect(outputs.risk).toBe("system");
    });
  });

  it("still outputs lane=full and risk=system when no comparison is given", () => {
    withRepository((repository) => {
      commitFile(repository, "docs/a.md", "one");

      for (const environment of [
        {},
        { ORBIT_BASE_SHA: "", ORBIT_HEAD_SHA: "" },
        { ORBIT_BASE_SHA: absentCommit },
        { ORBIT_HEAD_SHA: absentCommit },
      ]) {
        const { outputs } = runScript(repository, environment);
        expect(outputs.lane, JSON.stringify(environment)).toBe("full");
        expect(outputs.risk, JSON.stringify(environment)).toBe("system");
      }
    });
  });
});
