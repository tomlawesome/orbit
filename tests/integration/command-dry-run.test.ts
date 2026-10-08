import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { items } from "@/db/schema";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/* ADR-0034 (#1325): `dryRun: true` beside a command runs the same parse,
   access check and pre-write checks as the real call, and writes nothing;
   the refusals a member reads come back in their words, from the engine. */

const { POST: applyWorkspaceCommand } = await loadRoute("workspace/commands");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const commandUrl = "http://127.0.0.1:3000/api/workspace/commands";
type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;

function send(session: Session, body: Record<string, unknown>) {
  return callRouteForSession(applyWorkspaceCommand, session, {
    url: commandUrl,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function upsert(fixture: Fixture, item: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    type: "item.upsert",
    householdId: fixture.household.id,
    kind: "inspection",
    item: {
      id: fixture.item.id, sectionId: fixture.section.id, title: "MOT", currency: "GBP",
      dueDate: "2026-11-02", recurrenceMonths: 12, version: 2, ...item,
    },
    activity: { id: randomUUID(), itemId: fixture.item.id, kind: "updated", occurredAt: new Date().toISOString() },
    ...extra,
  };
}

async function row(itemId: string) {
  const [found] = await getDb().select().from(items).where(eq(items.id, itemId));
  return found;
}

describe("the command dry run", () => {
  it("answers an empty success and writes nothing", async () => {
    const fixture = await createIntegrationFixture("dry-run-accepts");
    const owner = await fixture.session("owner");
    const before = await row(fixture.item.id);
    const audits = await fixture.auditCount(fixture.item.id);

    const response = await send(owner, { ...upsert(fixture), dryRun: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({});
    expect(await row(fixture.item.id)).toEqual(before);
    expect(await fixture.auditCount(fixture.item.id)).toBe(audits);

    const freshId = randomUUID();
    const fresh = await send(owner, { ...upsert(fixture, { id: freshId, version: undefined }), dryRun: true });
    expect(fresh.status).toBe(200);
    expect(await row(freshId)).toBeUndefined();
  });

  it("refuses in the member's words, as the real call does", async () => {
    const fixture = await createIntegrationFixture("dry-run-refuses");
    const owner = await fixture.session("owner");
    for (const dryRun of [true, false]) {
      const response = await send(owner, { ...upsert(fixture, { title: "  " }), dryRun });
      expect(response.status).toBe(422);
      expect((await response.json()).error).toEqual({ code: "item_name_missing", message: "not yet — give it a name" });
    }
    const cost = await send(owner, { ...upsert(fixture, { cost: "12,50" }), dryRun: true });
    expect((await cost.json()).error).toMatchObject({ code: "cost_format", message: "not yet — use a dot for pence, for example 12.50" });
  });

  it("runs the repository's own checks: a stale version, a section from elsewhere", async () => {
    const fixture = await createIntegrationFixture("dry-run-checks");
    const owner = await fixture.session("owner");
    const stale = await send(owner, { ...upsert(fixture, { version: 7 }), dryRun: true });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toMatchObject({ code: "version_conflict" });
    const elsewhere = await send(owner, { ...upsert(fixture, { sectionId: randomUUID() }), dryRun: true });
    expect(elsewhere.status).toBe(422);
    expect((await elsewhere.json()).error).toMatchObject({ code: "section_not_found" });
  });
});

describe("an item's kind is the engine's to map", () => {
  it("refuses a client-sent schedule kind, subtype or status", async () => {
    const fixture = await createIntegrationFixture("intent-refuses-derived");
    const owner = await fixture.session("owner");
    const response = await send(owner, upsert(fixture, { scheduleKind: "service", subtype: "MOT" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({ code: "invalid_command" });
  });

  it("stores the kind's schedule and subtype, and reads a typed cost", async () => {
    const fixture = await createIntegrationFixture("intent-maps-kind");
    const owner = await fixture.session("owner");
    const response = await send(owner, upsert(fixture, { cost: "£54.85" }));
    expect(response.status).toBe(200);
    expect(await row(fixture.item.id)).toMatchObject({
      subtype: "inspection", serviceDate: "2026-11-02", renewalDate: null, recurrenceMonths: 12, status: "active",
    });
    const body = await response.json() as { workspace: { households: Array<{ items: Array<Record<string, unknown>> }> } };
    const stored = body.workspace.households.flatMap((one) => one.items).find((one) => one.id === fixture.item.id);
    expect(stored).toMatchObject({ costMinor: 5485, scheduleKind: "service", subtype: "inspection" });
  });
});
