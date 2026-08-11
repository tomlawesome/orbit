import { describe, expect, it } from "vitest";
import {
  CI_RISK,
  ciRequirements,
  classifyCiRisk,
  isNonExecutablePath,
  pathRisk,
  requiresExecutableValidation,
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
      ".github/dependency-review-config.yml",
      "scripts/supply-chain-policy.mjs",
      "scripts/supply-chain-policy.test.mjs",
      "scripts/stable-promotion-policy.mjs",
      "scripts/stable-promotion-policy.test.mjs",
      "scripts/dependency-review-workflow.test.mjs",
      "scripts/exact-image-workflow.test.mjs",
      "scripts/esbuild-override-policy.test.mjs",
    ]) {
      expect(pathRisk(path)).toBe(CI_RISK.FAST);
    }
  });

  it("runs real PostgreSQL integration for ordinary server and API changes", () => {
    for (const path of [
      "src/server/workspace-repository.ts",
      "src/server/household-repository.ts",
      "src/app/api/workspace/route.ts",
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
      "config/tika-config.xml",
      "package.json",
      "playwright.config.ts",
      "public/favicon.svg",
      "src/app/page.tsx",
      "src/app/globals.css",
      "src/app/api/health/route.ts",
      "src/components/item-editor.tsx",
      "src/instrumentation.ts",
      "src/lib/auth/session.ts",
      "src/lib/preview-workspace.ts",
      "src/server/document-repository.ts",
      "src/server/documents/scanner.ts",
      "src/server/imap-ingestion.ts",
      "src/server/readiness.ts",
      "drizzle/0001_initial.sql",
      "scripts/install.sh",
      "scripts/backup.sh",
      "tests/e2e/authenticated-documents.spec.ts",
      "some/new/directory/file.txt",
    ]) {
      expect(pathRisk(path)).toBe(CI_RISK.SYSTEM);
      expect(isNonExecutablePath(path)).toBe(false);
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
      build: true,
      integration: false,
      system: false,
    });
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

  it("retains the executable compatibility predicate", () => {
    expect(requiresExecutableValidation(["docs/a.md", "README.md", ".gitignore"])).toBe(false);
    expect(requiresExecutableValidation(["docs/a.md", "src/server/a.ts"])).toBe(true);
    expect(requiresExecutableValidation([])).toBe(true);
  });
});
