import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, memberships, users } from "@/db/schema";
import { DELETE as removeMember, GET as listMembers, PATCH as transferOwnership, POST as addMember } from "@/app/api/households/[householdId]/members/route";
import { GET as readWorkspace } from "@/app/api/workspace/route";
import { GET as listDocuments } from "@/app/api/households/[householdId]/items/[itemId]/documents/route";
import { householdOwnerLockKey } from "@/lib/auth/authority-locks";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  requestForSession,
} from "./support/fixtures";

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

function householdContext(householdId: string) {
  return { params: Promise.resolve({ householdId }) };
}

function itemDocumentsContext(householdId: string, itemId: string) {
  return { params: Promise.resolve({ householdId, itemId }) };
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

async function expectFormerMemberPrivacy(
  fixture: IntegrationFixture,
  memberSession: IntegrationSession,
) {
  const membersResponse = await listMembers(
    requestForSession(memberSession, "http://127.0.0.1:3000/api/households/members"),
    householdContext(fixture.household.id),
  );
  expect(membersResponse.status).toBe(404);
  expect(await body(membersResponse)).toEqual({ error: { code: "household_not_found", message: "That household is not available" } });

  const workspaceResponse = await readWorkspace(requestForSession(memberSession, "http://127.0.0.1:3000/api/workspace"));
  expect(workspaceResponse.status).toBe(200);
  const workspacePayload = await body(workspaceResponse);
  expect(workspacePayload.workspace).toMatchObject({ households: [] });
  expect(JSON.stringify(workspacePayload)).not.toContain(fixture.household.name);

  const documentsResponse = await listDocuments(
    requestForSession(memberSession, "http://127.0.0.1:3000/api/households/items/documents"),
    itemDocumentsContext(fixture.household.id, fixture.item.id),
  );
  expect(documentsResponse.status).toBe(404);
  expect(await body(documentsResponse)).toEqual({ error: { code: "item_not_found", message: "That item is not available" } });
}

describe("membership departure, removal and ownership transfer", () => {
  it("lets a non-owner leave through DELETE without a post-revocation read", async () => {
    const fixture = await createIntegrationFixture("membership-self-leave");
    const member = await fixture.session("member");
    const response = await removeMember(
      requestForSession(member, `http://127.0.0.1:3000/api/households/${fixture.household.id}/members`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: fixture.users.member.id }),
      }),
      householdContext(fixture.household.id),
    );

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
    const response = await removeMember(
      requestForSession(owner, `http://127.0.0.1:3000/api/households/${fixture.household.id}/members`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: fixture.users.member.id }),
      }),
      householdContext(fixture.household.id),
    );

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
    const response = await removeMember(
      requestForSession(admin, `http://127.0.0.1:3000/api/households/${fixture.household.id}/members`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: fixture.users.member.id }),
      }),
      householdContext(fixture.household.id),
    );

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
    const context = householdContext(fixture.household.id);
    const beforeAudit = await fixture.auditCount(fixture.household.id);

    const memberTargetsOwner = await removeMember(requestForSession(member, "http://127.0.0.1:3000/api/households/members", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.owner.id }),
    }), context);
    expect(memberTargetsOwner.status).toBe(409);
    expect((await body(memberTargetsOwner)).error?.code).toBe("owner_protected");

    const memberTargetsOutsider = await removeMember(requestForSession(member, "http://127.0.0.1:3000/api/households/members", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.outsider.id }),
    }), context);
    expect(memberTargetsOutsider.status).toBe(404);
    expect((await body(memberTargetsOutsider)).error?.code).toBe("member_not_found");

    const outsiderTargetsMember = await removeMember(requestForSession(outsider, "http://127.0.0.1:3000/api/households/members", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.member.id }),
    }), context);
    expect(outsiderTargetsMember.status).toBe(404);
    expect((await body(outsiderTargetsMember)).error?.code).toBe("household_not_found");

    const adminTargetsOwner = await removeMember(requestForSession(admin, "http://127.0.0.1:3000/api/households/members", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.owner.id }),
    }), context);
    expect(adminTargetsOwner.status).toBe(409);
    expect((await body(adminTargetsOwner)).error?.code).toBe("owner_protected");
    expect(await fixture.auditCount(fixture.household.id)).toBe(beforeAudit);

    const removed = await removeMember(requestForSession(owner, "http://127.0.0.1:3000/api/households/members", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.member.id }),
    }), context);
    expect(removed.status).toBe(200);
    const repeated = await removeMember(requestForSession(owner, "http://127.0.0.1:3000/api/households/members", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.member.id }),
    }), context);
    expect(repeated.status).toBe(404);
    expect((await body(repeated)).error?.code).toBe("member_not_found");
    expect(await auditRows(fixture.household.id, "member_removed")).toHaveLength(1);
  });

  it("serializes concurrent leave and removal without duplicate success audits", async () => {
    const fixture = await createIntegrationFixture("membership-race");
    const owner = await fixture.session("owner");
    const member = await fixture.session("member");
    const context = householdContext(fixture.household.id);
    const [ownerRemoval, memberLeave] = await Promise.all([
      removeMember(requestForSession(owner, "http://127.0.0.1:3000/api/households/members", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: fixture.users.member.id }),
      }), context),
      removeMember(requestForSession(member, "http://127.0.0.1:3000/api/households/members", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: fixture.users.member.id }),
      }), context),
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
    const context = householdContext(fixture.household.id);
    const held = deferred<void>();
    let removal!: Promise<Response>;
    let transfer!: Promise<Response>;
    const holdingTransaction = getDb().transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${householdOwnerLockKey(fixture.household.id)}, 0))`);
      held.resolve();
      removal = removeMember(requestForSession(owner, "http://127.0.0.1:3000/api/households/members", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: fixture.users.member.id }),
      }), context);
      await waitForAdvisoryLockWaiters(1);
      transfer = transferOwnership(requestForSession(owner, "http://127.0.0.1:3000/api/households/members", {
        method: "PATCH",
        body: JSON.stringify({ userId: fixture.users.member.id }),
      }), context);
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
    const context = householdContext(fixture.household.id);
    const response = await transferOwnership(requestForSession(owner, "http://127.0.0.1:3000/api/households/members", {
      method: "PATCH",
      body: JSON.stringify({ userId: fixture.users.member.id }),
    }), context);

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

    const oldOwnerAdd = await addMember(requestForSession(owner, "http://127.0.0.1:3000/api/households/members", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.outsider.id }),
    }), context);
    expect(oldOwnerAdd.status).toBe(403);
    expect((await body(oldOwnerAdd)).error?.code).toBe("owner_required");

    const newOwnerAdd = await addMember(requestForSession(member, "http://127.0.0.1:3000/api/households/members", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.outsider.id }),
    }), context);
    expect(newOwnerAdd.status).toBe(200);
    expect(await getDb().select({ userId: memberships.userId }).from(memberships).where(and(
      eq(memberships.householdId, fixture.household.id),
      eq(memberships.userId, fixture.users.outsider.id),
    ))).toHaveLength(1);
  });
});
