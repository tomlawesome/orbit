import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { items } from "@/db/schema";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/**
 * #1468 review fix: item.upsert's compatibility `kind` (accepted and ignored
 * for one release, ADR-0044) is bounded input. A short value still saves; an
 * over-long one is refused with 400.
 */

const { POST: applyWorkspaceCommand } = await loadRoute("workspace/commands");
const commandUrl = "http://127.0.0.1:3000/api/workspace/commands";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;

function send(session: Session, fixture: Fixture, id: string, kind: string) {
  return callRouteForSession(applyWorkspaceCommand, session, {
    url: commandUrl, method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "item.upsert",
      householdId: fixture.household.id,
      kind,
      item: { id, sectionId: fixture.section.id, title: "Boiler cover", currency: "GBP", importance: "normal", dueDate: "2026-12-20" },
      activity: { id: randomUUID(), itemId: id, occurredAt: new Date().toISOString() },
    }),
  });
}

describe("the compatibility kind on item.upsert is bounded", () => {
  it("refuses a 10,000-character kind with 400 and saves nothing", async () => {
    const fixture = await createIntegrationFixture("kind-bound-long");
    const owner = await fixture.session("owner");
    const id = randomUUID();
    expect((await send(owner, fixture, id, "x".repeat(10_000))).status).toBe(400);
    expect(await getDb().select().from(items).where(eq(items.id, id))).toHaveLength(0);
    await fixture.cleanup();
  });

  it("still saves a short ignored kind", async () => {
    const fixture = await createIntegrationFixture("kind-bound-short");
    const owner = await fixture.session("owner");
    const id = randomUUID();
    expect((await send(owner, fixture, id, "inspection")).status).toBe(200);
    expect(await getDb().select().from(items).where(eq(items.id, id))).toHaveLength(1);
    await fixture.cleanup();
  });
});
