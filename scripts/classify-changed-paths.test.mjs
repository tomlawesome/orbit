import { describe, expect, it } from "vitest";
import { isNonExecutablePath, requiresExecutableValidation } from "./classify-changed-paths.mjs";

describe("changed-path classification", () => {
  it("treats documentation and repository metadata as non-executable", () => {
    expect(isNonExecutablePath("docs/feature-register.md")).toBe(true);
    expect(isNonExecutablePath("docs/adr/0007-dual-pipeline-agent-governance.md")).toBe(true);
    expect(isNonExecutablePath("README.md")).toBe(true);
    expect(isNonExecutablePath(".gitignore")).toBe(true);
    expect(isNonExecutablePath(".github/ISSUE_TEMPLATE/delivery.yml")).toBe(true);
  });

  it("treats anything that can alter runtime behaviour as executable", () => {
    expect(isNonExecutablePath("src/server/document-repository.ts")).toBe(false);
    expect(isNonExecutablePath("scripts/install.sh")).toBe(false);
    expect(isNonExecutablePath("tests/e2e/authenticated-documents.spec.ts")).toBe(false);
    expect(isNonExecutablePath("docker-compose.yml")).toBe(false);
    expect(isNonExecutablePath("Dockerfile")).toBe(false);
    expect(isNonExecutablePath("package.json")).toBe(false);
    expect(isNonExecutablePath("pnpm-lock.yaml")).toBe(false);
    expect(isNonExecutablePath("config/tika-config.xml")).toBe(false);
  });

  it("requires a workflow change to validate itself", () => {
    // A CI change that skipped its own validation could never be proven.
    expect(isNonExecutablePath(".github/workflows/publish-container.yml")).toBe(false);
  });

  it("treats an unrecognised path as executable", () => {
    expect(isNonExecutablePath("some/new/directory/file.txt")).toBe(false);
    expect(isNonExecutablePath("docs.md.ts")).toBe(false);
  });

  it("normalises separators so a Windows-style path is classified alike", () => {
    expect(isNonExecutablePath("docs\\adr\\0001-example.md")).toBe(true);
    expect(isNonExecutablePath("src\\server\\example.ts")).toBe(false);
  });

  it("skips validation only when every changed path is non-executable", () => {
    expect(requiresExecutableValidation(["docs/a.md", "README.md", ".gitignore"])).toBe(false);
    expect(requiresExecutableValidation(["docs/a.md", "src/server/a.ts"])).toBe(true);
  });

  it("falls back to full validation when the comparison yields nothing usable", () => {
    // An empty or unreadable diff is not evidence that a change is inert.
    expect(requiresExecutableValidation([])).toBe(true);
    expect(requiresExecutableValidation(undefined)).toBe(true);
    expect(requiresExecutableValidation(null)).toBe(true);
  });
});
