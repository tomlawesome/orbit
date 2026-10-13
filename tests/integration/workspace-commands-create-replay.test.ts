import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { households, memberships, sessions } from "@/db/schema";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/* #1316 (GAP-U1): the first-run create must survive a lost reply. The browser
   sends the household's id with `household.create`, and keeps that id for a
   second press of Create, so the id is an idempotency key: the same user
   sending the same id again gets the first result back (a replay), and nobody
   else can claim an id that is already a household. Today the insert is blind
   and a repeat surfaces as a primary-key violation. */

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

function create(id: string, name: string) {
  return {
    type: "household.create",
    household: { id, name, timezone: "Europe/London", currency: "GBP", onboardingComplete: true },
  };
}

async function activeHouseholdOf(session: Session) {
  const [row] = await getDb().select({ id: sessions.activeHouseholdId }).from(sessions).where(eq(sessions.id, session.sessionId));
  return row?.id ?? null;
}

describe("household.create sent twice with the same id (a retry after a lost reply)", () => {
  it("replays for the same user: one household, one owner membership, the session pointing at it", async () => {
    const fixture = await createIntegrationFixture("create-replay");
    const first = await fixture.session("outsider");
    const id = randomUUID();
    const name = `Replay ${id.slice(0, 8)}`;

    const created = await send(first, create(id, name));
    expect(created.status).toBe(200);
    expect(await activeHouseholdOf(first)).toBe(id);

    /* The person presses Create again: the same user, the same id and name. */
    const replayed = await send(first, create(id, name));
    expect(replayed.status).toBe(200);
    expect(await activeHouseholdOf(first)).toBe(id);

    expect(await getDb().select({ id: households.id }).from(households).where(eq(households.name, name))).toHaveLength(1);
    const owners = await getDb().select({ userId: memberships.userId, role: memberships.role })
      .from(memberships).where(eq(memberships.householdId, id));
    expect(owners).toEqual([{ userId: first.userId, role: "owner" }]);
    expect(await fixture.auditCount(id), "the replay writes no second 'created' audit row").toBe(1);
  });

  it("replays from a fresh session of the same user and points that session at the household", async () => {
    const fixture = await createIntegrationFixture("create-replay-session");
    const first = await fixture.session("outsider");
    const id = randomUUID();
    const name = `Replay session ${id.slice(0, 8)}`;
    expect((await send(first, create(id, name))).status).toBe(200);

    /* The same person signed in again before pressing Create a second time. */
    const second = await fixture.session("outsider");
    expect(await activeHouseholdOf(second)).toBeNull();
    const replayed = await send(second, create(id, name));
    expect(replayed.status).toBe(200);
    expect(await activeHouseholdOf(second)).toBe(id);
    expect(await getDb().select({ id: memberships.userId }).from(memberships).where(eq(memberships.householdId, id))).toHaveLength(1);
  });

  it("refuses with a 409 when another user sends an id that is already a household, and changes nothing", async () => {
    const fixture = await createIntegrationFixture("create-replay-other-user");
    const owner = await fixture.session("outsider");
    const other = await fixture.session("secondOwner");
    const id = randomUUID();
    const name = `Taken ${id.slice(0, 8)}`;
    expect((await send(owner, create(id, name))).status).toBe(200);
    const otherActive = await activeHouseholdOf(other);

    const claimed = await send(other, create(id, `Other ${id.slice(0, 8)}`));
    expect(claimed.status).toBe(409);

    const members = await getDb().select({ userId: memberships.userId, role: memberships.role })
      .from(memberships).where(eq(memberships.householdId, id));
    expect(members).toEqual([{ userId: owner.userId, role: "owner" }]);
    const [stored] = await getDb().select({ name: households.name }).from(households).where(eq(households.id, id));
    expect(stored.name).toBe(name);
    expect(await activeHouseholdOf(other), "the refused user's session is not moved").toBe(otherActive);
  });
});
