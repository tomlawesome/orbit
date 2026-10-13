import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { households, memberships, sessions } from "@/db/schema";
import { checkWorkspaceCommand } from "@/server/workspace-repository";
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

function create(id: string, name: string, details: { timezone?: string; currency?: string } = {}) {
  return {
    type: "household.create",
    household: {
      id, name, timezone: details.timezone ?? "Europe/London", currency: details.currency ?? "GBP", onboardingComplete: true,
    },
  };
}

async function storedHousehold(id: string) {
  const [row] = await getDb().select({ name: households.name, timezone: households.timezone, currency: households.defaultCurrency })
    .from(households).where(eq(households.id, id));
  return row;
}

async function membersOf(id: string) {
  return getDb().select({ userId: memberships.userId, role: memberships.role }).from(memberships).where(eq(memberships.householdId, id));
}

async function errorCode(response: Response) {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code;
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

/* U3 (.agents/reviews/v0.3.0-door/r5/design-U3-lost-reply.md; the numbers in
   the test names are its testable behaviours). Decision 2: the same id from
   the same owner with any of name / time zone / currency different from the
   stored row is refused, 422 `household_create_mismatch`, before the session
   is moved, and the dry run throws the same refusal. Decision 4: two creates
   with the same id that overlap are serialised by the database (insert ... on
   conflict do nothing, then the replay branch), never a 500. Behaviours 11
   and 16 are the first and third tests above. */
describe("household.create with the same id and different details (U3 decision 2)", () => {
  it("(12) refuses a different name with 422 household_create_mismatch, keeps the stored name, and does not move the session", async () => {
    const fixture = await createIntegrationFixture("create-mismatch-name");
    const first = await fixture.session("outsider");
    const id = randomUUID();
    const name = `Mismatch ${id.slice(0, 8)}`;
    expect((await send(first, create(id, name))).status).toBe(200);

    const second = await fixture.session("outsider");
    const edited = await send(second, create(id, `Edited ${id.slice(0, 8)}`));
    expect(edited.status).toBe(422);
    expect(await errorCode(edited)).toBe("household_create_mismatch");

    expect((await storedHousehold(id)).name).toBe(name);
    expect(await activeHouseholdOf(second), "a refusal changes nothing").toBeNull();
    expect(await fixture.auditCount(id)).toBe(1);
  });

  it("(13) refuses the same name with a different time zone with 422, and keeps the stored zone", async () => {
    const fixture = await createIntegrationFixture("create-mismatch-zone");
    const owner = await fixture.session("outsider");
    const id = randomUUID();
    const name = `Zone ${id.slice(0, 8)}`;
    expect((await send(owner, create(id, name))).status).toBe(200);

    const moved = await send(owner, create(id, name, { timezone: "America/New_York" }));
    expect(moved.status).toBe(422);
    expect(await errorCode(moved)).toBe("household_create_mismatch");
    expect((await storedHousehold(id)).timezone).toBe("Europe/London");
  });

  it("(14) refuses the same name with a different currency with 422, and keeps the stored currency", async () => {
    const fixture = await createIntegrationFixture("create-mismatch-currency");
    const owner = await fixture.session("outsider");
    const id = randomUUID();
    const name = `Currency ${id.slice(0, 8)}`;
    expect((await send(owner, create(id, name))).status).toBe(200);

    const changed = await send(owner, create(id, name, { currency: "EUR" }));
    expect(changed.status).toBe(422);
    expect(await errorCode(changed)).toBe("household_create_mismatch");
    expect((await storedHousehold(id)).currency).toBe("GBP");
  });

  it("(15) the dry run of a mismatched create throws the same 422 and writes nothing", async () => {
    const fixture = await createIntegrationFixture("create-mismatch-dry-run");
    const first = await fixture.session("outsider");
    const id = randomUUID();
    const name = `Dry ${id.slice(0, 8)}`;
    expect((await send(first, create(id, name))).status).toBe(200);
    const second = await fixture.session("outsider");
    const mismatched = create(id, `Dry edited ${id.slice(0, 8)}`, { timezone: "America/New_York", currency: "EUR" });

    await expect(checkWorkspaceCommand(second.userId, second.sessionId, mismatched as never))
      .rejects.toMatchObject({ status: 422, code: "household_create_mismatch" });

    const viaRoute = await send(second, { ...mismatched, dryRun: true });
    expect(viaRoute.status).toBe(200);
    expect(await viaRoute.json()).toMatchObject({ refusal: { code: "household_create_mismatch" } });

    expect(await storedHousehold(id)).toEqual({ name, timezone: "Europe/London", currency: "GBP" });
    expect(await activeHouseholdOf(second)).toBeNull();
    expect(await membersOf(id)).toHaveLength(1);
    expect(await fixture.auditCount(id)).toBe(1);
  });
});

describe("two creates with the same id that overlap (U3 decision 4)", () => {
  it("(17) two identical creates started together both answer 200, and make one household, one owner, one audit row", async () => {
    const fixture = await createIntegrationFixture("create-concurrent-same");
    const owner = await fixture.session("outsider");
    const id = randomUUID();
    const name = `Together ${id.slice(0, 8)}`;

    /* The second begins before the first has committed: neither is awaited alone. */
    const answers = await Promise.all([send(owner, create(id, name)), send(owner, create(id, name))]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);

    expect(await getDb().select({ id: households.id }).from(households).where(eq(households.id, id))).toHaveLength(1);
    expect(await membersOf(id)).toEqual([{ userId: owner.userId, role: "owner" }]);
    expect(await fixture.auditCount(id)).toBe(1);
    expect(await activeHouseholdOf(owner)).toBe(id);
  });

  it("(18) two overlapping creates with the same id and different names answer one 200 and one 422, never a 500", async () => {
    const fixture = await createIntegrationFixture("create-concurrent-mismatch");
    const owner = await fixture.session("outsider");
    const id = randomUUID();

    const answers = await Promise.all([
      send(owner, create(id, `First ${id.slice(0, 8)}`)),
      send(owner, create(id, `Second ${id.slice(0, 8)}`)),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 422]);
    const refused = answers.find((answer) => answer.status === 422)!;
    expect(await errorCode(refused)).toBe("household_create_mismatch");

    expect(await getDb().select({ id: households.id }).from(households).where(eq(households.id, id))).toHaveLength(1);
    expect(await membersOf(id)).toEqual([{ userId: owner.userId, role: "owner" }]);
    expect(await fixture.auditCount(id)).toBe(1);
  });

  it("(19) two overlapping creates with the same id from different users answer one 200 and one 409, never a 500", async () => {
    const fixture = await createIntegrationFixture("create-concurrent-users");
    const one = await fixture.session("outsider");
    const other = await fixture.session("secondOwner");
    const id = randomUUID();
    const name = `Contested ${id.slice(0, 8)}`;

    const answers = await Promise.all([send(one, create(id, name)), send(other, create(id, name))]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    const refused = answers.find((answer) => answer.status === 409)!;
    expect(await errorCode(refused)).toBe("household_exists");

    expect(await getDb().select({ id: households.id }).from(households).where(eq(households.id, id))).toHaveLength(1);
    const members = await membersOf(id);
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe("owner");
  });
});
