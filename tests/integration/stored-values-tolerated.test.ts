import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { households, items } from "@/db/schema";
import { readWorkspace } from "@/server/workspace-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/*
 * #1333: validate on write, tolerate on read. The desk household screen once
 * offered "America/New York" (with a space), so a household may hold that, and
 * an item may hold a currency the platform's list does not. Reading them must
 * keep working -- a schema that reads stored rows must not start refusing
 * them -- while every write path refuses the value. Migration 0050 repairs the
 * one value known to be a mistake (see migrations.test.ts).
 */

const { POST: applyWorkspaceCommand } = await loadRoute("workspace/commands");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;

function send(session: Session, body: Record<string, unknown>) {
  return callRouteForSession(applyWorkspaceCommand, session, {
    url: "http://127.0.0.1:3000/api/workspace/commands",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("a stored value the write path would refuse still reads (#1333)", () => {
  it("reads a household stored with the time zone \"America/New York\"", async () => {
    const fixture = await createIntegrationFixture("stored-zone-reads");
    await getDb().update(households).set({ timezone: "America/New York" }).where(eq(households.id, fixture.household.id));

    const session = await fixture.session("member");
    const workspace = await readWorkspace(fixture.users.member.id, session.sessionId);
    const household = workspace.households.find((entry) => entry.id === fixture.household.id);
    expect(household?.timezone).toBe("America/New York");
    await fixture.cleanup();
  });

  it("reads an item stored with a currency the platform does not list", async () => {
    const fixture = await createIntegrationFixture("stored-currency-reads");
    await getDb().update(items).set({ currency: "ZZZ" }).where(eq(items.id, fixture.item.id));

    const session = await fixture.session("member");
    const workspace = await readWorkspace(fixture.users.member.id, session.sessionId);
    const item = workspace.households.find((entry) => entry.id === fixture.household.id)?.items.find((entry) => entry.id === fixture.item.id);
    expect(item?.currency).toBe("ZZZ");
    await fixture.cleanup();
  });

  it("still refuses to write that time zone", async () => {
    const fixture = await createIntegrationFixture("stored-zone-write-refused");
    const owner = await fixture.session("owner");
    const response = await send(owner, {
      type: "household.update",
      householdId: fixture.household.id,
      name: "Home",
      timezone: "America/New York",
      currency: "GBP",
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    const [row] = await getDb().select({ timezone: households.timezone }).from(households).where(eq(households.id, fixture.household.id));
    expect(row.timezone).not.toBe("America/New York");
    await fixture.cleanup();
  });

  it("accepts the same write with the zone spelled as the database does", async () => {
    const fixture = await createIntegrationFixture("stored-zone-write-accepted");
    const owner = await fixture.session("owner");
    const response = await send(owner, {
      type: "household.update",
      householdId: fixture.household.id,
      name: "Home",
      timezone: "America/New_York",
      currency: "GBP",
    });
    expect(response.status).toBe(200);
    await fixture.cleanup();
  });
});
