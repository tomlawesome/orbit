import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { households } from "@/db/schema";
import { VISIBLE_HOUSEHOLDS_LIMIT } from "@/lib/workspace";
import { listVisibleHouseholds } from "@/server/join-requests";
import { readWorkspace } from "@/server/workspace-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/**
 * #492: listVisibleHouseholds had no SQL LIMIT while workspaceSchema's
 * visibleHouseholds is capped at VISIBLE_HOUSEHOLDS_LIMIT — so an instance
 * with more live households than that bound failed schema validation on
 * EVERY workspace read for a household-less user (the choose branch's
 * entire audience). Seeding one past the bound proves the bound now holds
 * end to end, not just in the query in isolation.
 */
describe("listVisibleHouseholds bound (#492)", () => {
  it("keeps the workspace read valid once live households exceed the schema's cap", async () => {
    const fixture = await createIntegrationFixture("visible-households-bound");
    const namePrefix = `Bound test household ${randomUUID()}`;
    const seeded = Array.from({ length: VISIBLE_HOUSEHOLDS_LIMIT + 1 }, (_, index) => ({
      name: `${namePrefix} ${String(index).padStart(4, "0")}`,
    }));
    try {
      await getDb().insert(households).values(seeded);

      const visible = await listVisibleHouseholds(fixture.users.outsider.id);
      expect(visible.length).toBeLessThanOrEqual(VISIBLE_HOUSEHOLDS_LIMIT);

      // Before #492's fix, this threw a ZodError out of workspaceSchema.parse
      // (visibleHouseholds.max(VISIBLE_HOUSEHOLDS_LIMIT)) for every
      // household-less user once live households passed the bound.
      const workspace = await readWorkspace(fixture.users.outsider.id, randomUUID());
      expect(workspace.householdLanding).toBe("choose");
      expect(workspace.visibleHouseholds.length).toBeLessThanOrEqual(VISIBLE_HOUSEHOLDS_LIMIT);
    } finally {
      await getDb().delete(households).where(like(households.name, `${namePrefix}%`));
      await fixture.cleanup();
    }
  }, 30_000);
});
