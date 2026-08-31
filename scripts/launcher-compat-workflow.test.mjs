import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../.github/workflows/launcher-install-compat.yml", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

describe("launcher install compatibility gate", () => {
  it("does the real work only when the pull request is in scope", () => {
    // Every step that builds or drives the launcher is conditional, so a
    // pull request touching no installer script costs nothing. That is the
    // design; the point of the summary below is that it stays visible.
    for (const step of [
      "Check out orbit-launcher",
      "Set up Go",
      "Build orbit-launcher from source",
      "Install Orbit through the launcher, against this revision's installer",
    ]) {
      const body = workflow.slice(workflow.indexOf(`- name: ${step}`));
      expect(body).toContain("if: steps.scope.outputs.run == 'true'");
    }
  });

  it("says in the job summary whether it examined anything", () => {
    // A required check that gates the promotion must not report success for
    // work it never did: three of the last four runs before #694 passed
    // without building the launcher at all, and nothing said so. See #694.
    const summary = workflow.slice(
      workflow.indexOf("- name: Record what this run examined"),
    );

    expect(summary).toContain("- name: Record what this run examined");
    expect(summary).toContain("if: always()");
    expect(summary).toContain("GITHUB_STEP_SUMMARY");
    expect(summary).toContain("Not examined");
  });
});
