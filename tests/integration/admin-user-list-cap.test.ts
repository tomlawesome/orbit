import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { instanceAuthority, users } from "@/db/schema";
import { ADMIN_USER_LIST_CAP, listInstanceUsers } from "@/server/admin-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/**
 * #592: listInstanceUsers read `users` ordered by display name with a flat
 * `.limit(1_000)` and no notion of how many rows existed. Past the cap the
 * administration surface silently showed a subset, and because the order is
 * display-name-first, a primary administrator whose name sorts late could
 * vanish from the list entirely — including right after a primary transfer.
 *
 * The owner ruled out pagination (2026-09-02): keep the hard cap, but make
 * the truncation visible to the caller and guarantee the primary
 * administrator is always reachable regardless of sort order.
 */
describe("listInstanceUsers cap (#592)", () => {
  it("flags truncation and keeps the primary administrator reachable past the cap", async () => {
    const fixture = await createIntegrationFixture("admin-user-list-cap");
    const namePrefix = `AAAA cap test user ${randomUUID()}`;
    try {
      // Seat the fixture admin as primary. Their display name is
      // "Integration admin", which sorts after every "AAAA..." seeded name
      // below, so a naive display-name-ordered LIMIT pushes them off the
      // page entirely once there are more than the cap of earlier-sorting
      // users.
      await getDb().insert(instanceAuthority).values({ primaryUserId: fixture.users.admin.id });

      const seeded = Array.from({ length: ADMIN_USER_LIST_CAP + 1 }, (_, index) => ({
        email: `${namePrefix.replace(/\s+/g, "-")}-${index}@example.invalid`,
        displayName: `${namePrefix} ${String(index).padStart(4, "0")}`,
      }));
      await getDb().insert(users).values(seeded);

      const result = await listInstanceUsers(fixture.users.admin.id);

      // The read must say plainly that it is not the whole instance.
      expect(result.truncated).toBe(true);
      expect(result.totalCount).toBeGreaterThan(ADMIN_USER_LIST_CAP);

      // The primary administrator must never be the row that falls off,
      // regardless of how the instance's users sort by display name.
      const primary = result.users.find((user) => user.id === fixture.users.admin.id);
      expect(primary).toBeDefined();
      expect(primary?.isPrimaryAdministrator).toBe(true);
    } finally {
      await getDb().delete(instanceAuthority);
      await getDb().delete(users).where(like(users.displayName, `${namePrefix}%`));
      await fixture.cleanup();
    }
  }, 30_000);
});
