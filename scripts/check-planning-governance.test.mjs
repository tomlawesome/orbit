import { describe, expect, it } from "vitest";

import {
  hasPlanningAttestation,
  isProtectedPlanningPath,
  matchedPlanningAttestation,
} from "./check-planning-governance.mjs";

describe("planning governance", () => {
  it("protects architecture, ADR, governance, and roadmap sources", () => {
    expect(isProtectedPlanningPath("AGENTS.md")).toBe(true);
    expect(isProtectedPlanningPath("docs/architecture.md")).toBe(true);
    expect(isProtectedPlanningPath("docs/orchestration-runbook.md")).toBe(true);
    expect(isProtectedPlanningPath("docs/orchestration-controls.json")).toBe(true);
    expect(isProtectedPlanningPath("docs/examples/orchestration-state.example.json")).toBe(true);
    expect(isProtectedPlanningPath("docs/adr/0001-example.md")).toBe(true);
    expect(isProtectedPlanningPath(".github/orchestration-governance.json")).toBe(true);
    expect(isProtectedPlanningPath(".github/ISSUE_TEMPLATE/delivery.yml")).toBe(true);
    expect(isProtectedPlanningPath(".github/workflows/publish-container.yml")).toBe(true);
    expect(isProtectedPlanningPath("docker-compose.yml")).toBe(true);
    expect(isProtectedPlanningPath("docker-compose.mail.yml")).toBe(true);
    expect(
      isProtectedPlanningPath("docker-compose.mail-alias-rotation.yml"),
    ).toBe(true);
    expect(isProtectedPlanningPath("scripts/check-orchestration-governance.mjs")).toBe(true);
    expect(isProtectedPlanningPath("scripts/stable-promotion-policy.mjs")).toBe(true);
    expect(isProtectedPlanningPath("src/server/example.ts")).toBe(false);
  });

  it("accepts exactly one standalone attestation from Sol or a human owner", () => {
    expect(hasPlanningAttestation("Planning-Model: Sol Extra High")).toBe(true);
    expect(hasPlanningAttestation("Planning-Model: Human")).toBe(true);
  });

  it("rejects Claude, implementation-tier, unknown, and non-standalone attestations", () => {
    expect(hasPlanningAttestation("Planning-Model: Claude Opus Extra High")).toBe(false);
    expect(hasPlanningAttestation("Planning-Model: Luna Extra High")).toBe(false);
    expect(hasPlanningAttestation("Planning-Model: Claude Sonnet Extra High")).toBe(false);
    expect(hasPlanningAttestation("Planning-Model: Not applicable")).toBe(false);
    expect(hasPlanningAttestation("Not Planning-Model: Sol Extra High")).toBe(false);
    expect(hasPlanningAttestation("")).toBe(false);
    expect(hasPlanningAttestation(null)).toBe(false);
  });

  it("rejects duplicate and conflicting accepted attestations", () => {
    expect(
      hasPlanningAttestation(
        "Planning-Model: Sol Extra High\nPlanning-Model: Sol Extra High",
      ),
    ).toBe(false);
    expect(
      hasPlanningAttestation(
        "Planning-Model: Sol Extra High\nPlanning-Model: Human",
      ),
    ).toBe(false);
    expect(
      matchedPlanningAttestation(
        "Planning-Model: Human\nPlanning-Model: Human",
      ),
    ).toBe(null);
    expect(
      hasPlanningAttestation(
        "Planning-Model: Sol Extra High\nPlanning-Model: Not applicable",
      ),
    ).toBe(false);
  });

  it("reports the sole attestation that satisfied the gate", () => {
    expect(matchedPlanningAttestation("intro\nPlanning-Model: Human\noutro"))
      .toBe("Planning-Model: Human");
    expect(matchedPlanningAttestation("Planning-Model: Terra Medium")).toBe(null);
  });
});
