import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  hasPlanningAttestation,
  isProtectedPlanningPath,
  matchedPlanningAttestation,
  validateObservabilityDeclaration,
} from "./check-planning-governance.mjs";

const deliveryTemplate = readFileSync(
  new URL("../.github/ISSUE_TEMPLATE/delivery.yml", import.meta.url),
  "utf8",
);
const pullRequestTemplate = readFileSync(
  new URL("../.github/pull_request_template.md", import.meta.url),
  "utf8",
);

describe("planning governance", () => {
  it("protects only architecture, ADR, release-policy, and governance sources", () => {
    expect(isProtectedPlanningPath("AGENTS.md")).toBe(true);
    expect(isProtectedPlanningPath("docs/architecture.md")).toBe(true);
    expect(isProtectedPlanningPath("docs/orchestration-runbook.md")).toBe(true);
    expect(isProtectedPlanningPath("docs/adr/0001-example.md")).toBe(true);
    expect(isProtectedPlanningPath(".github/orchestration-governance.json")).toBe(true);
    expect(isProtectedPlanningPath("scripts/check-orchestration-governance.mjs")).toBe(true);
    expect(isProtectedPlanningPath("scripts/stable-promotion-policy.mjs")).toBe(true);
    expect(isProtectedPlanningPath("docs/releasing.md")).toBe(true);

    expect(isProtectedPlanningPath("docs/implementation-plan.md")).toBe(false);
    expect(isProtectedPlanningPath("docs/feature-register.md")).toBe(false);
    expect(isProtectedPlanningPath("docs/v1-charter.md")).toBe(false);
    expect(isProtectedPlanningPath("docs/orchestration-controls.json")).toBe(false);
    expect(isProtectedPlanningPath("docs/examples/orchestration-state.example.json")).toBe(false);
    expect(isProtectedPlanningPath(".github/ISSUE_TEMPLATE/delivery.yml")).toBe(false);
    expect(isProtectedPlanningPath(".github/workflows/publish-container.yml")).toBe(false);
    expect(isProtectedPlanningPath("docker-compose.yml")).toBe(false);
    expect(isProtectedPlanningPath("docker-compose.mail.yml")).toBe(false);
    expect(isProtectedPlanningPath("docs/document-threat-model.md")).toBe(false);
    expect(isProtectedPlanningPath("src/server/example.ts")).toBe(false);
  });

  it("accepts an exact, standalone attestation from Sol or the human owner", () => {
    expect(hasPlanningAttestation("Planning-Model: Sol Extra High")).toBe(true);
    expect(hasPlanningAttestation("Planning-Model: Human")).toBe(true);
  });

  it("rejects implementation-tier, unknown, and non-standalone attestations", () => {
    expect(hasPlanningAttestation("Planning-Model: Luna Extra High")).toBe(false);
    expect(hasPlanningAttestation("Planning-Model: Claude Opus Extra High")).toBe(false);
    expect(hasPlanningAttestation("Planning-Model: Claude Sonnet Extra High")).toBe(false);
    expect(hasPlanningAttestation("Planning-Model: Not applicable")).toBe(false);
    expect(hasPlanningAttestation("Not Planning-Model: Sol Extra High")).toBe(false);
    expect(hasPlanningAttestation("")).toBe(false);
    expect(hasPlanningAttestation(null)).toBe(false);
  });

  it("reports which attestation satisfied the gate", () => {
    expect(matchedPlanningAttestation("intro\nPlanning-Model: Human\noutro"))
      .toBe("Planning-Model: Human");
    expect(matchedPlanningAttestation("Planning-Model: Terra Medium")).toBe(null);
  });
});

describe("observability governance", () => {
  const changedBody = `
- Operational event/state: auth.callback state=provider_rejected; operator checks provider configuration.
- Failure/recovery: record the bounded rejection category and a successful retry after configuration repair.
- Privacy/redaction: omit claims, tokens, email addresses, provider responses, and request URLs; assert those values are absent.
- Operator-documentation impact: update the authentication troubleshooting table with the category and action.

Observability-Impact: changed
`;

  it("accepts changed evidence with all required bounded entries", () => {
    expect(validateObservabilityDeclaration(changedBody)).toEqual({
      impact: "changed",
      reason: null,
    });
  });

  it("accepts a specific none reason", () => {
    expect(validateObservabilityDeclaration(
      "Observability-Impact: none — documentation-only wording change with no runtime or operator behavior impact",
    )).toEqual({
      impact: "none",
      reason: "documentation-only wording change with no runtime or operator behavior impact",
    });
  });

  it.each([
    ["missing", "No declaration"],
    ["duplicated", "Observability-Impact: changed\nObservability-Impact: changed"],
    ["malformed", "Observability-Impact: none - docs only"],
    ["unexplained", "Observability-Impact: none — <specific reason>"],
    ["generic", "Observability-Impact: none — docs only"],
  ])("rejects %s declarations", (_name, body) => {
    expect(() => validateObservabilityDeclaration(body)).toThrow(/Observability-Impact/u);
  });

  it("rejects changed declarations without every concise evidence entry", () => {
    expect(() => validateObservabilityDeclaration(
      "Operational event/state: startup\nObservability-Impact: changed",
    )).toThrow(/Failure\/recovery.*Privacy\/redaction.*Operator-documentation impact/u);
  });

  it("keeps the issue and PR templates on the explicit observability contract", () => {
    expect(deliveryTemplate).toContain("id: observability");
    expect(deliveryTemplate).toContain("label: Operational observability");
    expect(deliveryTemplate).toContain("required: true");
    expect(pullRequestTemplate).toContain("## Operational observability");
    expect(pullRequestTemplate).toContain("Observability-Impact: changed");
    expect(pullRequestTemplate).toContain("Observability-Impact: none — <specific reason>");
    expect(pullRequestTemplate.match(/^Observability-Impact:/gmu)).toHaveLength(1);
    expect(pullRequestTemplate).toContain("Logs describe transient operational events");
    expect(pullRequestTemplate).toContain("the audit trail records durable security or business actions");
    expect(pullRequestTemplate).toContain("public health is a content-free readiness contract");
    expect(pullRequestTemplate).toContain("authenticated admin UI presents bounded corrective diagnostics");
  });
});
