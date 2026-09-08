import { describe, expect, it } from "vitest";
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
      ".github/supply-chain-policy.json",
      "supply-chain/licence-policy.yml",
      "scripts/supply-chain-policy.mjs",
      "scripts/supply-chain-policy.test.mjs",
      "scripts/stable-promotion-policy.mjs",
      "scripts/stable-promotion-policy.test.mjs",
      "scripts/exact-image-workflow.test.mjs",
      "scripts/esbuild-override-policy.test.mjs",
    ]) {
      expect(pathRisk(path)).toBe(CI_RISK.FAST);
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
      ".github/workflows/publish-container.yml",
      "Dockerfile",
      "docker-compose.yml",
      "config/tika-config.json",
      "package.json",
      "playwright.config.ts",
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
      "scripts/configuration.sh",
      "scripts/backup.sh",
      "scripts/restore.sh",
      "scripts/repair.sh",
      "scripts/engine-check.sh",
    ]) {
      expect(touchesLauncherInstallCompat([path])).toBe(true);
      expect(ciRequirements([path]).launcherCompat).toBe(true);
    }
    // Not bundled, so still outside this job's reach: the acceptance-only
    // compose overlays and the container's own entrypoint.
    expect(touchesLauncherInstallCompat(["docker-compose.acceptance.yml"])).toBe(false);
    expect(touchesLauncherInstallCompat(["scripts/container-entrypoint.sh"])).toBe(false);
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

  it("retains the executable compatibility predicate", () => {
    expect(requiresExecutableValidation(["docs/a.md", "README.md", ".gitignore"])).toBe(false);
    expect(requiresExecutableValidation(["docs/a.md", "src/server/a.ts"])).toBe(true);
    expect(requiresExecutableValidation([])).toBe(true);
  });
});
