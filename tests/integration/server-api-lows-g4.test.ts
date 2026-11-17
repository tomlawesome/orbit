import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { households, memberships, signInApprovals, userPreferences } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { createLocalUser } from "@/server/local-credentials";
import { APPROVAL_RESEND_INTERVAL_MS, APPROVAL_SENDS_PER_HOUR, startSignInApproval, resendSignInApproval } from "@/server/sign-in-approvals";
import { applyWorkspaceCommand } from "@/server/workspace-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/* Audit Lows, group 4 (server and API): the findings whose behaviour needs the
   real database. Each case is named for its audit id; the map is
   .agents/handoffs/lows/lows-g4-tests.md. */

const { POST: workspaceCommand } = await loadRoute("workspace/commands");
const { PUT: putPreferences } = await loadRoute("preferences");
const commandUrl = "http://127.0.0.1:3000/api/workspace/commands";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;

function send(session: Session, body: Record<string, unknown>) {
  return callRouteForSession(workspaceCommand, session, {
    url: commandUrl,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const create = (id: string, name: string) => ({
  type: "household.create",
  household: { id, name, timezone: "Europe/London", currency: "GBP", onboardingComplete: true },
});

describe("P-19: the removed-household name check is scoped to the caller's own households", () => {
  async function removedHousehold(name: string, ownerId?: string) {
    const id = randomUUID();
    const db = getDb();
    await db.insert(households).values({
      id,
      name,
      deletionRequestedAt: new Date(),
      deleteAfter: new Date(Date.now() + 7 * 86_400_000),
    });
    if (ownerId) await db.insert(memberships).values({ householdId: id, userId: ownerId, role: "owner" });
    return id;
  }

  it("lets a user take a name that only somebody else's removed household holds, and tells them nothing about it", async () => {
    const fixture = await createIntegrationFixture("p19-other");
    const stranger = await fixture.session("outsider");
    const name = `Removed elsewhere ${randomUUID().slice(0, 8)}`;
    await removedHousehold(name, fixture.users.secondOwner.id);

    const response = await send(stranger, create(randomUUID(), name));
    expect(response.status, await response.clone().text()).toBe(200);
  });

  it("still refuses a name the caller's own removed household holds, pointing at restore", async () => {
    const fixture = await createIntegrationFixture("p19-own");
    const owner = await fixture.session("outsider");
    const name = `Removed mine ${randomUUID().slice(0, 8)}`;
    await removedHousehold(name, owner.userId);

    const response = await send(owner, create(randomUUID(), name));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("household_name_recoverable");
  });
});

describe("1738 A-F3: an expiry carrying a repeat is refused on reviewed intake too", () => {
  it("refuses a new item whose reviewed basis is an expiry but which asks for a repeat, rather than dropping the repeat", async () => {
    const fixture = await createIntegrationFixture("a-f3-basis");
    const owner = await fixture.session("owner");
    const id = randomUUID();
    await expect(applyWorkspaceCommand(owner.userId, owner.sessionId, {
      type: "item.upsert",
      householdId: fixture.household.id,
      basis: { scheduleKind: "expiry", status: "active" },
      item: {
        id,
        sectionId: fixture.section.id,
        title: "Appliance guarantee",
        currency: "GBP",
        dueDate: "2027-03-01",
        recurrenceMonths: 12,
        reminderDays: [14, 3],
      },
    } as never)).rejects.toMatchObject({ code: "invalid_item" });
  });
});

describe("1738 A-F1: a save from a page older than the importance question is told to reload", () => {
  const stale = (fixture: Fixture, extra: Record<string, unknown>) => ({
    type: "item.upsert",
    householdId: fixture.household.id,
    item: { id: randomUUID(), sectionId: fixture.section.id, title: "Boiler service", currency: "GBP", recurrenceMonths: 0, reminderDays: [14, 3] },
    ...extra,
  });

  it("answers a new item with no importance that also carries the retired kind with words that say to reload the page", async () => {
    const fixture = await createIntegrationFixture("a-f1-reload");
    const owner = await fixture.session("owner");
    const response = await send(owner, stale(fixture, { kind: "renewal" }));
    expect(response.status).toBe(422);
    const { error } = (await response.json()) as { error: { message: string } };
    expect(error.message).toMatch(/reload/i);
  });

  it("keeps the plain importance wording for a current page that simply left importance unset", async () => {
    const fixture = await createIntegrationFixture("a-f1-current");
    const owner = await fixture.session("owner");
    const response = await send(owner, stale(fixture, {}));
    expect(response.status).toBe(422);
    const { error } = (await response.json()) as { error: { message: string } };
    expect(error.message).toMatch(/importance/i);
    expect(error.message).not.toMatch(/reload/i);
  });
});

describe("1738 A-S1 / W-S2: a preferences PUT writes only the fields it carries", () => {
  it("leaves every omitted setting as it was stored, not reset to the schema default", async () => {
    const fixture = await createIntegrationFixture("a-s1-preferences");
    const owner = await fixture.session("owner");
    const kept = {
      textSize: "large", emailNotifications: false, pushNotifications: false, labelDays: 90,
      skyDriver: "warning", planetSize: "importance", importanceOfferDismissed: true,
    };
    await getDb().insert(userPreferences).values({ userId: owner.userId, themeId: "afterdark", ...kept })
      .onConflictDoUpdate({ target: userPreferences.userId, set: { themeId: "afterdark", ...kept } });

    const response = await callRouteForSession(putPreferences, owner, {
      url: "http://127.0.0.1:3000/api/preferences",
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "dawn" }),
    });
    expect(response.status, await response.clone().text()).toBe(200);

    const [stored] = await getDb().select().from(userPreferences).where(eq(userPreferences.userId, owner.userId));
    expect(stored).toMatchObject({ themeId: "dawn", ...kept });
    const { preference } = (await response.json()) as { preference: Record<string, unknown> };
    expect(preference).toMatchObject({ theme: "dawn", ...kept });
  });
});

describe("sign-in approvals", () => {
  const PASSWORD = "a-correct-local-password";
  const facts = { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0", clientAddress: null };
  const posted: string[] = [];
  const mailer = { async sendEmail(notification: { to: string }) { posted.push(notification.to); } };

  async function account(label: string) {
    const user = await createLocalUser({
      email: `${label}-${randomUUID().slice(0, 8)}@approvals.invalid`,
      displayName: `Approvals ${label}`,
      passwordHash: await hashPassword(PASSWORD),
    });
    return user.id;
  }

  it("P-20: a send more than an hour old no longer counts toward the five an hour", async () => {
    const userId = await account("p20");
    const minute = 60_000;
    const t0 = new Date("2030-01-01T09:00:00.000Z");
    const at = (minutes: number) => new Date(t0.getTime() + minutes * minute);

    /* Four sends inside the first four minutes (one sign-in, three resends). */
    const first = await startSignInApproval(userId, facts, { mailer, now: at(0) });
    for (const m of [1, 2, 3]) {
      expect((await resendSignInApproval(first.claim, { mailer, now: at(m) })).state).toBe("sent");
    }
    /* A fifth, an hour on from the first, on a new sign-in: 4 sends are in its hour, so it goes out. */
    const second = await startSignInApproval(userId, facts, { mailer, now: at(59) });
    expect(second.limited).toBe(false);
    expect(posted).toHaveLength(5);

    /* At minute 61 the send at minute 0 is over an hour old: 4 sends are inside the hour, one under the limit. */
    expect(APPROVAL_SENDS_PER_HOUR).toBe(5);
    expect(APPROVAL_RESEND_INTERVAL_MS).toBe(minute);
    const third = await startSignInApproval(userId, facts, { mailer, now: at(61) });
    expect(third.limited, "only four mails went out in the last hour").toBe(false);
    expect(posted).toHaveLength(6);
  });

  it("P-29: a sign-in approval that expired long ago is deleted when the next one is opened; a recent one is not", async () => {
    const userId = await account("p29");
    const db = getDb();
    const longAgo = new Date(Date.now() - 400 * 86_400_000);
    const justNow = new Date(Date.now() - 60_000);
    const row = (expiresAt: Date, over: Record<string, unknown> = {}) => ({
      userId, tokenHash: randomUUID(), claimHash: randomUUID(), expiresAt, ...over,
    });
    const [oldPending, oldConsumed, recent] = await db.insert(signInApprovals).values([
      row(longAgo),
      row(longAgo, { outcome: "approved", decidedAt: longAgo, consumedAt: longAgo }),
      row(justNow),
    ]).returning({ id: signInApprovals.id });

    await startSignInApproval(userId, facts, { mailer });

    const left = await db.select({ id: signInApprovals.id }).from(signInApprovals)
      .where(inArray(signInApprovals.id, [oldPending.id, oldConsumed.id, recent.id]));
    expect(left.map((r) => r.id)).toEqual([recent.id]);
  });
});
