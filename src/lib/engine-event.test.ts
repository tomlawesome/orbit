import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ACTION_VOCABULARY,
  COMPONENT_VOCABULARY,
  PHASE_VOCABULARY,
  REASON_VOCABULARY,
  STATE_VOCABULARY,
  defaultFailureAction,
  defaultFailureReason,
  formatEngineEventLine,
} from "./engine-event";

// Living-document parity: this test parses the fenced vocabulary blocks
// directly out of docs/engine-events.md and asserts they stay byte-identical
// to this module's hardcoded constants, so a future vocabulary addition
// there (scripts/engine-events.test.mjs already requires the doc update
// itself, per that doc's own "must update this document in the same pull
// request" rule) is caught here too rather than silently drifting.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const docPath = join(repoRoot, "docs", "engine-events.md");

function extractFencedListAfterHeading(heading: string): string[] {
  const content = readFileSync(docPath, "utf8");
  const headingIndex = content.indexOf(`### ${heading}`);
  if (headingIndex < 0) throw new Error(`Could not find heading ### ${heading} in docs/engine-events.md`);
  const fenceStart = content.indexOf("```", headingIndex);
  const fenceEnd = content.indexOf("```", fenceStart + 3);
  return content
    .slice(fenceStart + 3, fenceEnd)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe("vocabulary parity with docs/engine-events.md", () => {
  it("phase", () => expect([...PHASE_VOCABULARY]).toEqual(extractFencedListAfterHeading("phase")));
  it("component", () => expect([...COMPONENT_VOCABULARY]).toEqual(extractFencedListAfterHeading("component")));
  it("state", () => expect([...STATE_VOCABULARY]).toEqual(extractFencedListAfterHeading("state")));
  it("reason", () => expect([...REASON_VOCABULARY]).toEqual(extractFencedListAfterHeading("reason")));
  it("action", () => expect([...ACTION_VOCABULARY]).toEqual(extractFencedListAfterHeading("action")));
});

describe("formatEngineEventLine (docs/engine-events.md line format, guarantee #1)", () => {
  it("formats a fully valid event", () => {
    expect(
      formatEngineEventLine({ phase: "host", component: "host", state: "starting", reason: "host-tools", action: "check" }, 3),
    ).toBe("phase=host component=host state=starting reason=host-tools action=check elapsed=3s");
  });

  it("renders any unrecognised field value as the literal 'unknown', never echoed verbatim", () => {
    const line = formatEngineEventLine(
      { phase: "<script>", component: "host", state: "starting", reason: "host-tools", action: "check" },
      1,
    );
    expect(line).toContain("phase=unknown");
    expect(line).not.toContain("<script>");
  });

  it("renders a malformed elapsed value as 0s (installer-ui.sh guarantee #2)", () => {
    expect(
      formatEngineEventLine({ phase: "host", component: "host", state: "starting", reason: "host-tools", action: "check" }, -1),
    ).toContain("elapsed=0s");
    expect(
      formatEngineEventLine({ phase: "host", component: "host", state: "starting", reason: "host-tools", action: "check" }, 1.5),
    ).toContain("elapsed=0s");
  });
});

describe("defaultFailureReason / defaultFailureAction (install.sh:211-229)", () => {
  it.each([
    ["host", "docker-host", "retry"],
    ["identity", "image-registry", "retry"],
    ["assets", "image-registry", "retry"],
    ["preparation", "image-registry", "retry"],
    ["configuration", "configuration-failure", "retry"],
    ["compose", "configuration-failure", "retry"],
    ["oidc", "provider-unavailable", "retry"],
    ["database", "database-auth-migration", "repair"],
    ["application", "health-timeout", "repair"],
    ["optional", "optional-unavailable", "repair"],
    ["something-else", "failure", "retry"],
  ] as const)("phase=%s -> reason=%s action=%s", (phase, reason, action) => {
    expect(defaultFailureReason(phase)).toBe(reason);
    expect(defaultFailureAction(phase)).toBe(action);
  });
});
