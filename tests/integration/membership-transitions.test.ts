import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, dueEvents, items, memberships, users } from "@/db/schema";
import { householdOwnerLockKey } from "@/lib/auth/authority-locks";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
} from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

const { DELETE: removeMember, GET: listMembers, PATCH: transferOwnership, POST: addMember } =
  await loadRoute("households/[householdId]/members");
const { GET: readWorkspace } = await loadRoute("workspace");
const { POST: requestToJoin } = await loadRoute("households/[householdId]/join-requests");
const { GET: listDocuments } = await loadRoute("households/[householdId]/items/[itemId]/documents");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type IntegrationFixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type IntegrationSession = Awaited<ReturnType<IntegrationFixture["session"]>>;
type JsonBody = {
  error?: { code?: string; message?: string };
  members?: Array<{ id: string; role: "owner" | "member" }>;
  workspace?: unknown;
  [key: string]: unknown;
};

function householdParams(householdId: string) {
  return { householdId };
}

function itemDocumentsParams(householdId: string, itemId: string) {
  return { householdId, itemId };
}

async function body(response: Response): Promise<JsonBody> {
  return await response.json() as JsonBody;
}

async function auditRows(householdId: string, action: string) {
  return getDb().select({ id: auditLog.id, changes: auditLog.changes }).from(auditLog).where(and(
    eq(auditLog.householdId, householdId),
    eq(auditLog.action, action),
  ));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function waitForAdvisoryLockWaiters(minimum: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await getDb().execute(sql<{ waiting: number }>`
      select count(*)::int as waiting
      from pg_locks
      where locktype = 'advisory' and granted = false
    `);
    if (Number(rows[0]?.waiting) >= minimum) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Expected ${minimum} advisory-lock waiter(s)`);
}

/* Distinctive event data planted before the reads below, so "no event crosses"
   is an assertion about something that actually exists to cross. */
const PLANTED_COST_MINOR = 424_242;
const PLANTED_DUE_DATE = "2031-07-19";

/** Gives the household one real, scheduled, priced event to leak. */
async function plantRealEvent(fixture: IntegrationFixture): Promise<string> {
  const [planted] = await getDb().update(items)
    .set({ costMinor: PLANTED_COST_MINOR, renewalDate: PLANTED_DUE_DATE })
    .where(eq(items.id, fixture.item.id))
    .returning({ title: items.title });
  await getDb().insert(dueEvents).values({
    householdId: fixture.household.id,
    itemId: fixture.item.id,
    kind: "renewal",
    dueDate: PLANTED_DUE_DATE,
  });
  return planted.title;
}

/** The whole entry a workspace read carried for one household, or undefined. */
function visibleEntry(payload: JsonBody, householdId: string) {
  const workspace = payload.workspace as { visibleHouseholds?: Array<Record<string, unknown>> } | undefined;
  return (workspace?.visibleHouseholds ?? []).find((row) => row.id === householdId);
}

/**
 * The ruled boundary (#489). A former member is simply a non-member, so §11
 * discoverability applies to them like any signed-in stranger: they see the
 * household's NAME and whether they may ask to join, and that is the whole
 * surface. Real events — item titles, due dates, amounts, document names,
 * member and entry counts — belong to real members, on the dial and in the
 * manifest alike, and never cross to a non-member.
 */
async function expectFormerMemberPrivacy(
  fixture: IntegrationFixture,
  memberSession: IntegrationSession,
) {
  const itemTitle = await plantRealEvent(fixture);

  const membersResponse = await callRouteForSession(listMembers, memberSession, {
    url: "http://127.0.0.1:3000/api/households/members",
    params: householdParams(fixture.household.id),
  });
  expect(membersResponse.status).toBe(404);
  expect(await body(membersResponse)).toEqual({ error: { code: "household_not_found", message: "That household is not available" } });

  const workspaceResponse = await callRouteForSession(readWorkspace, memberSession, { url: "http://127.0.0.1:3000/api/workspace" });
  expect(workspaceResponse.status).toBe(200);
  const workspacePayload = await body(workspaceResponse);
  expect(workspacePayload.workspace).toMatchObject({ householdLanding: "choose", households: [] });

  /* The name is visible, and toEqual (not toMatchObject) is the point: an id,
     a name and a joinability flag are the ENTIRE entry. */
  expect(visibleEntry(workspacePayload, fixture.household.id)).toEqual({
    id: fixture.household.id,
    name: fixture.household.name,
    requested: false,
  });
  /* Nothing beyond the name and joinability — not the planted event, not the
     item that carries it, not a count of what is inside. */
  const serialized = JSON.stringify(workspacePayload);
  for (const withheld of [
    itemTitle,
    fixture.item.id,
    fixture.document.displayName,
    PLANTED_DUE_DATE,
    /* Field names, not values: an amount is digits, and digits collide with
       the hex of every uuid in the payload. The field must be absent. */
    "costMinor",
    "dueDate",
    "memberCount",
    "items",
    "sections",
    "activities",
  ]) {
    expect(serialized).not.toContain(withheld);
  }

  /* Joinability is the other half of the ruling: they may ask back in, and
     the answer carries the request's own identity and nothing of the
     household but the id they already asked about. */
  const joinResponse = await callRouteForSession(requestToJoin, memberSession, {
    url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/join-requests`,
    method: "POST",
    params: householdParams(fixture.household.id),
  });
  expect(joinResponse.status).toBe(200);
  expect((await body(joinResponse)).request).toEqual({
    id: expect.any(String),
    householdId: fixture.household.id,
    status: "pending",
  });
  const afterAsking = await callRouteForSession(readWorkspace, memberSession, { url: "http://127.0.0.1:3000/api/workspace" });
  expect(visibleEntry(await body(afterAsking), fixture.household.id)).toEqual({
    id: fixture.household.id,
    name: fixture.household.name,
    requested: true,
  });

  const documentsResponse = await callRouteForSession(listDocuments, memberSession, {
    url: "http://127.0.0.1:3000/api/households/items/documents",
    params: itemDocumentsParams(fixture.household.id, fixture.item.id),
  });
  expect(documentsResponse.status).toBe(404);
  expect(await body(documentsResponse)).toEqual({ error: { code: "item_not_found", message: "That item is not available" } });
}

describe("membership departure, removal and ownership transfer", () => {
  it("lets a non-owner leave through DELETE without a post-revocation read", async () => {
    const fixture = await createIntegrationFixture("membership-self-leave");
    const member = await fixture.session("member");
    const response = await callRouteForSession(removeMember, member, {
      url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/members`,
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.member.id }),
      params: householdParams(fixture.household.id),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await body(response)).toEqual({ members: [], candidates: [] });
    expect(await getDb().select({ id: memberships.userId }).from(memberships).where(and(
      eq(memberships.householdId, fixture.household.id),
      eq(memberships.userId, fixture.users.member.id),
    ))).toHaveLength(0);
    expect(await getDb().select({ id: users.id }).from(users).where(eq(users.id, fixture.users.member.id))).toHaveLength(1);
    expect(await auditRows(fixture.household.id, "member_left")).toHaveLength(1);
    await expectFormerMemberPrivacy(fixture, member);
  });

  it("allows the owner to remove a member and revokes the member immediately", async () => {
    const fixture = await createIntegrationFixture("membership-owner-removal");
    const owner = await fixture.session("owner");
    const member = await fixture.session("member");
    const response = await callRouteForSession(removeMember, owner, {
      url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/members`,
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.member.id }),
      params: householdParams(fixture.household.id),
    });

    expect(response.status).toBe(200);
    expect((await body(response)).members).toEqual([
      expect.objectContaining({ id: fixture.users.owner.id, role: "owner" }),
    ]);
    expect(await auditRows(fixture.household.id, "member_removed")).toHaveLength(1);
    await expectFormerMemberPrivacy(fixture, member);
  });

  it("allows an active instance administrator to remove a member without joining the household", async () => {
    const fixture = await createIntegrationFixture("membership-admin-removal");
    const admin = await fixture.session("admin");
    const member = await fixture.session("member");
    const response = await callRouteForSession(removeMember, admin, {
      url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/members`,
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.member.id }),
      params: householdParams(fixture.household.id),
    });

    expect(response.status).toBe(200);
    expect((await body(response)).members).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixture.users.owner.id, role: "owner" }),
    ]));
    expect(await auditRows(fixture.household.id, "member_removed")).toHaveLength(1);
    await expectFormerMemberPrivacy(fixture, member);
  });

  it("does not remove owners or disclose membership to unauthorized callers", async () => {
    const fixture = await createIntegrationFixture("membership-denials");
    const owner = await fixture.session("owner");
    const member = await fixture.session("member");
    const outsider = await fixture.session("outsider");
    const admin = await fixture.session("admin");
    const params = householdParams(fixture.household.id);
    const beforeAudit = await fixture.auditCount(fixture.household.id);

    const memberTargetsOwner = await callRouteForSession(removeMember, member, {
      url: "http://127.0.0.1:3000/api/households/members",
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.owner.id }),
      params,
    });
    expect(memberTargetsOwner.status).toBe(409);
    expect((await body(memberTargetsOwner)).error?.code).toBe("owner_protected");

    const memberTargetsOutsider = await callRouteForSession(removeMember, member, {
      url: "http://127.0.0.1:3000/api/households/members",
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.outsider.id }),
      params,
    });
    expect(memberTargetsOutsider.status).toBe(404);
    expect((await body(memberTargetsOutsider)).error?.code).toBe("member_not_found");

    const outsiderTargetsMember = await callRouteForSession(removeMember, outsider, {
      url: "http://127.0.0.1:3000/api/households/members",
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.member.id }),
      params,
    });
    expect(outsiderTargetsMember.status).toBe(404);
    expect((await body(outsiderTargetsMember)).error?.code).toBe("household_not_found");

    const adminTargetsOwner = await callRouteForSession(removeMember, admin, {
      url: "http://127.0.0.1:3000/api/households/members",
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.owner.id }),
      params,
    });
    expect(adminTargetsOwner.status).toBe(409);
    expect((await body(adminTargetsOwner)).error?.code).toBe("owner_protected");
    expect(await fixture.auditCount(fixture.household.id)).toBe(beforeAudit);

    const removed = await callRouteForSession(removeMember, owner, {
      url: "http://127.0.0.1:3000/api/households/members",
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.member.id }),
      params,
    });
    expect(removed.status).toBe(200);
    const repeated = await callRouteForSession(removeMember, owner, {
      url: "http://127.0.0.1:3000/api/households/members",
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.member.id }),
      params,
    });
    expect(repeated.status).toBe(404);
    expect((await body(repeated)).error?.code).toBe("member_not_found");
    expect(await auditRows(fixture.household.id, "member_removed")).toHaveLength(1);
  });

  it("serializes concurrent leave and removal without duplicate success audits", async () => {
    const fixture = await createIntegrationFixture("membership-race");
    const owner = await fixture.session("owner");
    const member = await fixture.session("member");
    const params = householdParams(fixture.household.id);
    const [ownerRemoval, memberLeave] = await Promise.all([
      callRouteForSession(removeMember, owner, {
        url: "http://127.0.0.1:3000/api/households/members",
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: fixture.users.member.id }),
        params,
      }),
      callRouteForSession(removeMember, member, {
        url: "http://127.0.0.1:3000/api/households/members",
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: fixture.users.member.id }),
        params,
      }),
    ]);

    expect([ownerRemoval.status, memberLeave.status].sort()).toEqual([200, 404]);
    expect(await getDb().select({ userId: memberships.userId, role: memberships.role }).from(memberships)
      .where(eq(memberships.householdId, fixture.household.id))).toEqual([
      { userId: fixture.users.owner.id, role: "owner" },
    ]);
    expect((await auditRows(fixture.household.id, "member_left")).length + (await auditRows(fixture.household.id, "member_removed")).length).toBe(1);
  });

  it("serializes transfer against conflicting removal with one bounded loser", async () => {
    const fixture = await createIntegrationFixture("membership-transfer-race");
    const owner = await fixture.session("owner");
    const params = householdParams(fixture.household.id);
    const held = deferred<void>();
    let removal!: Promise<Response>;
    let transfer!: Promise<Response>;
    const holdingTransaction = getDb().transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${householdOwnerLockKey(fixture.household.id)}, 0))`);
      held.resolve();
      removal = callRouteForSession(removeMember, owner, {
        url: "http://127.0.0.1:3000/api/households/members",
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: fixture.users.member.id }),
        params,
      });
      await waitForAdvisoryLockWaiters(1);
      transfer = callRouteForSession(transferOwnership, owner, {
        url: "http://127.0.0.1:3000/api/households/members",
        method: "PATCH",
        body: JSON.stringify({ userId: fixture.users.member.id }),
        params,
      });
      await waitForAdvisoryLockWaiters(2);
    });
    await held.promise;
    await holdingTransaction;
    const [removalResponse, transferResponse] = await Promise.all([removal, transfer]);

    expect([removalResponse.status, transferResponse.status].sort()).toEqual([200, 409]);
    expect(removalResponse.headers.get("cache-control")).toBe("no-store");
    expect(transferResponse.headers.get("cache-control")).toBe("no-store");
    const loser = removalResponse.status === 409 ? removalResponse : transferResponse;
    expect((await body(loser)).error?.code).toMatch(/^(owner_protected|member_not_found)$/u);

    const owners = await getDb().select({ userId: memberships.userId, disabledAt: users.disabledAt })
      .from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(
        eq(memberships.householdId, fixture.household.id),
        eq(memberships.role, "owner"),
      ));
    expect(owners).toHaveLength(1);
    expect(owners[0]?.disabledAt).toBeNull();
    expect([fixture.users.owner.id, fixture.users.member.id]).toContain(owners[0]?.userId);

    const remainingMemberships = await getDb().select({ userId: memberships.userId, role: memberships.role })
      .from(memberships).where(eq(memberships.householdId, fixture.household.id));
    expect(remainingMemberships.every((membership) => [fixture.users.owner.id, fixture.users.member.id].includes(membership.userId))).toBe(true);
    const orderedMemberships = remainingMemberships.toSorted((left, right) => left.userId.localeCompare(right.userId));
    if (removalResponse.status === 200) {
      expect(orderedMemberships).toEqual([{ userId: fixture.users.owner.id, role: "owner" }].toSorted((left, right) => left.userId.localeCompare(right.userId)));
      expect(await auditRows(fixture.household.id, "member_removed")).toHaveLength(1);
      expect(await auditRows(fixture.household.id, "ownership_transferred")).toHaveLength(0);
    } else {
      expect(orderedMemberships).toEqual([
        { userId: fixture.users.member.id, role: "owner" },
        { userId: fixture.users.owner.id, role: "member" },
      ].toSorted((left, right) => left.userId.localeCompare(right.userId)));
      expect(await auditRows(fixture.household.id, "member_removed")).toHaveLength(0);
      expect(await auditRows(fixture.household.id, "ownership_transferred")).toHaveLength(1);
    }
    expect(await auditRows(fixture.household.id, "member_left")).toHaveLength(0);
  });

  it("transfers ownership atomically and applies the resulting authority", async () => {
    const fixture = await createIntegrationFixture("membership-transfer");
    const owner = await fixture.session("owner");
    const member = await fixture.session("member");
    const params = householdParams(fixture.household.id);
    const response = await callRouteForSession(transferOwnership, owner, {
      url: "http://127.0.0.1:3000/api/households/members",
      method: "PATCH",
      body: JSON.stringify({ userId: fixture.users.member.id }),
      params,
    });

    expect(response.status).toBe(200);
    expect((await body(response)).members).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixture.users.owner.id, role: "member" }),
      expect.objectContaining({ id: fixture.users.member.id, role: "owner" }),
    ]));
    expect(await getDb().select({ userId: memberships.userId }).from(memberships).where(and(
      eq(memberships.householdId, fixture.household.id),
      eq(memberships.role, "owner"),
    ))).toEqual([{ userId: fixture.users.member.id }]);
    expect(await getDb().select({ id: users.id }).from(users).where(eq(users.id, fixture.users.owner.id))).toHaveLength(1);
    expect(await getDb().select({ id: users.id }).from(users).where(eq(users.id, fixture.users.member.id))).toHaveLength(1);
    expect(await auditRows(fixture.household.id, "ownership_transferred")).toHaveLength(1);

    const oldOwnerAdd = await callRouteForSession(addMember, owner, {
      url: "http://127.0.0.1:3000/api/households/members",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.outsider.id }),
      params,
    });
    expect(oldOwnerAdd.status).toBe(403);
    expect((await body(oldOwnerAdd)).error?.code).toBe("owner_required");

    const newOwnerAdd = await callRouteForSession(addMember, member, {
      url: "http://127.0.0.1:3000/api/households/members",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.outsider.id }),
      params,
    });
    expect(newOwnerAdd.status).toBe(200);
    expect(await getDb().select({ userId: memberships.userId }).from(memberships).where(and(
      eq(memberships.householdId, fixture.household.id),
      eq(memberships.userId, fixture.users.outsider.id),
    ))).toHaveLength(1);
  });
});
