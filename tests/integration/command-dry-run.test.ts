import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { items } from "@/db/schema";
import { householdToday } from "@/lib/household-date";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/* ADR-0034 (#1325): `dryRun: true` beside a command runs the same parse,
   access check and pre-write checks as the real call, and writes nothing;
   the refusals a member reads come back in their words, from the engine. A
   dry run is a question, so it answers 200 with the verdict in the body
   (`{}` or `{ refusal: { code, message } }`, the amendment of 2026-10-09);
   the real call keeps its 4xx `error` envelope, with the same code and words. */

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
    activity: { id: randomUUID(), itemId: fixture.item.id, occurredAt: new Date().toISOString() },
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

  it("answers the refusal the real call gives, in the member's words, as a 200 verdict", async () => {
    const fixture = await createIntegrationFixture("dry-run-refuses");
    const owner = await fixture.session("owner");
    const refusal = { code: "item_name_missing", message: "not yet — give it a name" };

    const dry = await send(owner, { ...upsert(fixture, { title: "  " }), dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.headers.get("cache-control")).toBe("no-store");
    expect(await dry.json()).toEqual({ refusal });

    const real = await send(owner, upsert(fixture, { title: "  " }));
    expect(real.status).toBe(422);
    expect(await real.json()).toEqual({ error: refusal });

    const cost = await send(owner, { ...upsert(fixture, { cost: "12,50" }), dryRun: true });
    expect(cost.status).toBe(200);
    expect((await cost.json()).refusal).toMatchObject({ code: "cost_format", message: "not yet — use a dot for pence, for example 12.50" });
  });

  it("runs the repository's own checks: a stale version, a section from elsewhere", async () => {
    const fixture = await createIntegrationFixture("dry-run-checks");
    const owner = await fixture.session("owner");
    const stale = await send(owner, { ...upsert(fixture, { version: 7 }), dryRun: true });
    expect(stale.status).toBe(200);
    expect((await stale.json()).refusal).toMatchObject({ code: "version_conflict" });
    const elsewhere = await send(owner, { ...upsert(fixture, { sectionId: randomUUID() }), dryRun: true });
    expect(elsewhere.status).toBe(200);
    expect((await elsewhere.json()).refusal).toMatchObject({ code: "section_not_found" });
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
    // The read carries each household's today, as the snooze floor reckons it (#1325).
    for (const household of body.workspace.households as unknown as Array<{ timezone: string; today?: string }>) {
      expect(household.today).toBe(householdToday(household.timezone));
    }
  });
});

describe("the snooze floor (#1325)", () => {
  it("refuses today or earlier in the member's words, and takes tomorrow", async () => {
    const fixture = await createIntegrationFixture("snooze-floor");
    const owner = await fixture.session("owner");
    expect((await send(owner, upsert(fixture))).status).toBe(200);
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const snooze = (snoozedUntil: string, expectedVersion: number) => ({
      type: "item.snooze", householdId: fixture.household.id, itemId: fixture.item.id, expectedVersion, snoozedUntil,
      activity: { id: randomUUID(), itemId: fixture.item.id, occurredAt: new Date().toISOString() },
    });
    for (const until of [day(-1), day(-2)]) {
      const refused = await send(owner, snooze(until, 2));
      expect(refused.status).toBe(422);
      expect((await refused.json()).error).toEqual({ code: "snooze_not_after_today", message: "not yet — snooze to a day after today" });
    }
    expect((await send(owner, { ...snooze(day(2), 2), dryRun: true })).status).toBe(200);
    expect((await row(fixture.item.id))?.snoozedUntil).toBeNull();
    expect((await send(owner, snooze(day(2), 2))).status).toBe(200);
    expect((await row(fixture.item.id))?.snoozedUntil).toBe(day(2));
  });
});
