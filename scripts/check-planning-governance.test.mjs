import { describe, expect, it } from "vitest";

import {
  hasPlanningAttestation,
  isProtectedPlanningPath,
} from "./check-planning-governance.mjs";

describe("planning governance", () => {
  it("protects architecture, ADR, governance, and roadmap sources", () => {
    expect(isProtectedPlanningPath("AGENTS.md")).toBe(true);
    expect(isProtectedPlanningPath("docs/architecture.md")).toBe(true);
    expect(isProtectedPlanningPath("docs/adr/0001-example.md")).toBe(true);
    expect(isProtectedPlanningPath(".github/ISSUE_TEMPLATE/delivery.yml")).toBe(true);
    expect(isProtectedPlanningPath(".github/workflows/publish-container.yml")).toBe(true);
    expect(isProtectedPlanningPath("docker-compose.yml")).toBe(true);
    expect(isProtectedPlanningPath("src/server/example.ts")).toBe(false);
  });

  it("requires an exact, standalone Sol Extra High attestation", () => {
    expect(hasPlanningAttestation("Planning-Model: Sol Extra High")).toBe(true);
    expect(hasPlanningAttestation("Planning-Model: Luna Extra High")).toBe(false);
    expect(hasPlanningAttestation("Not Planning-Model: Sol Extra High")).toBe(false);
  });
});
