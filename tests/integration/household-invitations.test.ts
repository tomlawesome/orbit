import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, householdInvitations, memberships, sessions } from "@/db/schema";
import {
  MAX_OPEN_INVITATIONS,
  inspectInvitation,
  listHouseholdInvitations,
  redeemInvitation,
  sendHouseholdInvitation,
  withdrawHouseholdInvitation,
} from "@/server/invitations";
import { invitationTokenDigest } from "@/server/invitations/token";
import type { SmtpNotification } from "@/server/notification-worker";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  type IntegrationFixture,
  type IntegrationSession,
} from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

const { GET: readInvitations, POST: sendInvitation, DELETE: withdrawInvitation } = await loadRoute(
  "households/[householdId]/invitations",
);

/**
 * EMAIL INVITATIONS against PostgreSQL (#481).
 *
 * The unit tests pin the token rules and the mail's words. What only a real
 * database can show is here: that the partial unique index makes a resend a
 * replacement, that a redemption and a withdrawal cannot both win, that the
 * address match is enforced on stored bytes, and — the acceptance criterion
 * that has to be proved rather than asserted — that the token appears in no
 * response and no audit row anywhere in the journey.
 */

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/** Captures the mail instead of sending it, which is also how a test gets the
 *  token: it exists in the mail and in nothing else. */
function captureMailer() {
  const sent: SmtpNotification[] = [];
  return {
    sent,
    mailer: { async sendEmail(notification: SmtpNotification) { sent.push(notification); } },
    /** The one link in the last mail, as the invitee's browser would open it. */
    lastToken(): string {
      const last = sent.at(-1);
      if (!last) throw new Error("No invitation mail was sent");
      const link = /https?:\/\/\S*\/invite\/(\S+)/u.exec(last.text);
      if (!link) throw new Error("The invitation mail carried no link");
      return link[1];
    },
  };
}

const url = (householdId: string) => `http://127.0.0.1:3000/api/households/${householdId}/invitations`;

async function call(
  handler: Parameters<typeof callRouteForSession>[0],
  session: IntegrationSession,
  householdId: string,
  init: { method?: string; body?: unknown } = {},
) {
  const response = await callRouteForSession(handler, session, {
    url: url(householdId),
    params: { householdId },
    method: init.method,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** The address a fixture invites. Unique per fixture so runs cannot collide. */
const invitedAddress = (fixture: IntegrationFixture) => `invited-${fixture.household.id.slice(0, 8)}@example.invalid`;

describe("the invitation API", () => {
  it("sends, lists, resends and withdraws — and answers no token on any verb", async () => {
    const fixture = await createIntegrationFixture("invitation-api");
    try {
      const owner = await fixture.session("owner");
      const member = await fixture.session("member");
      const address = invitedAddress(fixture);

      const sent = await call(sendInvitation, owner, fixture.household.id, { method: "POST", body: { email: address } });
      expect(sent.status).toBe(200);
      const invitation = (sent.body.invitation as Record<string, unknown>);
      expect(invitation.email).toBe(address);
      /* No SMTP is configured for the integration run, so the row records the
         bounded class rather than claiming a send that never happened. */
      expect(invitation.sentAt).toBeNull();
      expect(invitation.sendError).toBe("smtp_unconfigured");
      expect(Object.keys(invitation).sort())
        .toEqual(["createdAt", "email", "expiresAt", "householdId", "id", "sendError", "sentAt"]);

      /* Every member reads the list; only owners change it. */
      const seen = await call(readInvitations, member, fixture.household.id);
      expect(seen.status).toBe(200);
      expect((seen.body.invitations as unknown[])).toHaveLength(1);

      /* Sending again to the same address REPLACES, so the list never grows. */
      const again = await call(sendInvitation, owner, fixture.household.id, { method: "POST", body: { email: address } });
      expect(again.status).toBe(200);
      expect((again.body.invitations as unknown[])).toHaveLength(1);
      expect((again.body.invitation as { id: string }).id).toBe(invitation.id);

      const withdrawn = await call(withdrawInvitation, owner, fixture.household.id, {
        method: "DELETE",
        body: { invitationId: invitation.id },
      });
      expect(withdrawn.status).toBe(200);
      expect(withdrawn.body.invitations).toEqual([]);

      /* Withdrawing twice is a 404, not a second withdrawal. */
      const twice = await call(withdrawInvitation, owner, fixture.household.id, {
        method: "DELETE",
        body: { invitationId: invitation.id },
      });
      expect(twice.status).toBe(404);

      const everything = JSON.stringify([sent.body, seen.body, again.body, withdrawn.body]);
      const digests = await getDb().select({ digest: householdInvitations.tokenDigest })
        .from(householdInvitations).where(eq(householdInvitations.householdId, fixture.household.id));
      expect(digests).toHaveLength(1);
      for (const { digest } of digests) expect(everything).not.toContain(digest);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("refuses a member, and a stranger, on every verb that changes anything", async () => {
    const fixture = await createIntegrationFixture("invitation-authority");
    try {
      const owner = await fixture.session("owner");
      const member = await fixture.session("member");
      const outsider = await fixture.session("outsider");
      const address = invitedAddress(fixture);

      expect((await call(sendInvitation, member, fixture.household.id, {
        method: "POST", body: { email: address },
      })).status).toBe(403);

      const created = await call(sendInvitation, owner, fixture.household.id, { method: "POST", body: { email: address } });
      const invitationId = (created.body.invitation as { id: string }).id;
      expect((await call(withdrawInvitation, member, fixture.household.id, {
        method: "DELETE", body: { invitationId },
      })).status).toBe(403);

      /* A household the caller cannot see is a 404, never a 403: an outsider
         must not learn that a household exists by being refused about it. */
      expect((await call(readInvitations, outsider, fixture.household.id)).status).toBe(404);
      expect((await call(sendInvitation, outsider, fixture.household.id, {
        method: "POST", body: { email: address },
      })).status).toBe(404);

      /* Nor may an owner of ANOTHER household reach this one's invitations. */
      const secondOwner = await fixture.session("secondOwner");
      expect((await call(readInvitations, secondOwner, fixture.household.id)).status).toBe(404);
      expect((await call(withdrawInvitation, secondOwner, fixture.household.id, {
        method: "DELETE", body: { invitationId },
      })).status).toBe(404);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("refuses an address that is not one, and caps a household's open invitations", async () => {
    const fixture = await createIntegrationFixture("invitation-limits");
    try {
      const owner = await fixture.session("owner");
      expect((await call(sendInvitation, owner, fixture.household.id, {
        method: "POST", body: { email: "not an address" },
      })).status).toBe(422);

      const suffix = fixture.household.id.slice(0, 8);
      for (let index = 0; index < MAX_OPEN_INVITATIONS; index += 1) {
        const response = await call(sendInvitation, owner, fixture.household.id, {
          method: "POST", body: { email: `capped-${index}-${suffix}@example.invalid` },
        });
        expect(response.status).toBe(200);
      }
      const overflow = await call(sendInvitation, owner, fixture.household.id, {
        method: "POST", body: { email: `capped-over-${suffix}@example.invalid` },
      });
      expect(overflow.status).toBe(409);
      expect((overflow.body.error as { code: string }).code).toBe("invitation_limit");

      /* The cap counts OPEN invitations, so withdrawing one makes room. */
      const open = await listHouseholdInvitations(owner.userId, fixture.household.id);
      await withdrawHouseholdInvitation(owner.userId, fixture.household.id, open[0].id);
      expect((await call(sendInvitation, owner, fixture.household.id, {
        method: "POST", body: { email: `capped-over-${suffix}@example.invalid` },
      })).status).toBe(200);
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);
});

describe("redeeming an invitation", () => {
  it("puts the invited address in the household, on their own session, once", async () => {
    const fixture = await createIntegrationFixture("invitation-redeem");
    try {
      const owner = await fixture.session("owner");
      const capture = captureMailer();
      /* Invited at the address the outsider's own identity carries: the match
         is the ratified rule, and this is what satisfying it looks like. */
      const address = fixture.users.outsider.email;

      await sendHouseholdInvitation(owner.userId, fixture.household.id, address, { mailer: capture.mailer });
      expect(capture.sent).toHaveLength(1);
      expect(capture.sent[0].to).toBe(address);
      expect(capture.sent[0].subject).toContain(fixture.household.name);
      expect(capture.sent[0].html).toBeTruthy();
      const token = capture.lastToken();

      /* Nothing on the way in tells a stranger anything but the state. */
      expect(await inspectInvitation(token)).toMatchObject({ state: "open" });

      const invitee = await fixture.session("outsider");
      const redeemed = await redeemInvitation(token, {
        userId: invitee.userId,
        email: address,
        sessionId: invitee.sessionId,
      });
      expect(redeemed.state).toBe("joined");
      expect(redeemed.householdId).toBe(fixture.household.id);

      const [membership] = await getDb().select({ role: memberships.role }).from(memberships)
        .where(and(
          eq(memberships.householdId, fixture.household.id),
          eq(memberships.userId, invitee.userId),
        ));
      expect(membership.role).toBe("member");

      /* The session's active household is set, which is what makes the
         arrival's household choice never appear for the invitee. */
      const [session] = await getDb().select({ activeHouseholdId: sessions.activeHouseholdId })
        .from(sessions).where(eq(sessions.id, invitee.sessionId));
      expect(session.activeHouseholdId).toBe(fixture.household.id);

      /* The same link a second time. */
      expect((await redeemInvitation(token, {
        userId: invitee.userId, email: address, sessionId: invitee.sessionId,
      })).state).toBe("used");
      expect(await listHouseholdInvitations(owner.userId, fixture.household.id)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("adds nobody when the signed-in address is not the invited one, and leaves the link open", async () => {
    const fixture = await createIntegrationFixture("invitation-mismatch");
    try {
      const owner = await fixture.session("owner");
      const capture = captureMailer();
      const address = invitedAddress(fixture);
      await sendHouseholdInvitation(owner.userId, fixture.household.id, address, { mailer: capture.mailer });
      const token = capture.lastToken();

      const stranger = await fixture.session("outsider");
      const outcome = await redeemInvitation(token, {
        userId: stranger.userId,
        email: fixture.users.outsider.email,
        sessionId: stranger.sessionId,
      });
      expect(outcome.state).toBe("mismatch");
      expect(outcome.householdId).toBeNull();
      expect(outcome.householdName).toBeNull();

      const rows = await getDb().select({ userId: memberships.userId }).from(memberships)
        .where(and(
          eq(memberships.householdId, fixture.household.id),
          eq(memberships.userId, stranger.userId),
        ));
      expect(rows).toEqual([]);
      /* Still open for the person it was written to. */
      expect((await inspectInvitation(token)).state).toBe("open");
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("matches on trimmed, case-folded bytes, whatever casing the provider hands back", async () => {
    const fixture = await createIntegrationFixture("invitation-case");
    try {
      const owner = await fixture.session("owner");
      const capture = captureMailer();
      const address = fixture.users.outsider.email;
      await sendHouseholdInvitation(owner.userId, fixture.household.id, `  ${address.toUpperCase()} `, {
        mailer: capture.mailer,
      });
      const invitee = await fixture.session("outsider");
      const outcome = await redeemInvitation(capture.lastToken(), {
        userId: invitee.userId,
        email: `${address.toUpperCase()}`,
        sessionId: invitee.sessionId,
      });
      expect(outcome.state).toBe("joined");
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("lapses after its fourteen days, and says so without naming the household", async () => {
    const fixture = await createIntegrationFixture("invitation-expiry");
    try {
      const owner = await fixture.session("owner");
      const capture = captureMailer();
      const address = fixture.users.outsider.email;
      await sendHouseholdInvitation(owner.userId, fixture.household.id, address, { mailer: capture.mailer });
      const token = capture.lastToken();

      await getDb().update(householdInvitations)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(householdInvitations.tokenDigest, invitationTokenDigest(token)));

      expect((await inspectInvitation(token)).state).toBe("expired");
      const invitee = await fixture.session("outsider");
      const outcome = await redeemInvitation(token, {
        userId: invitee.userId, email: address, sessionId: invitee.sessionId,
      });
      expect(outcome.state).toBe("expired");
      expect(outcome.householdName).toBeNull();
      /* The inviter's chosen name IS offered — "ask Sam for a new one" is the
         whole of what a spent link has left to say. */
      expect(outcome.inviterName).toBe("Integration owner");
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("kills the earlier link when an owner resends, and when they withdraw", async () => {
    const fixture = await createIntegrationFixture("invitation-replacement");
    try {
      const owner = await fixture.session("owner");
      const capture = captureMailer();
      const address = fixture.users.outsider.email;

      await sendHouseholdInvitation(owner.userId, fixture.household.id, address, { mailer: capture.mailer });
      const first = capture.lastToken();
      await sendHouseholdInvitation(owner.userId, fixture.household.id, address, { mailer: capture.mailer });
      const second = capture.lastToken();
      expect(second).not.toBe(first);

      /* The replaced token is not "withdrawn" or "used" — the row it belonged
         to no longer answers to it at all. */
      expect((await inspectInvitation(first)).state).toBe("unknown");
      expect((await inspectInvitation(second)).state).toBe("open");

      const [open] = await listHouseholdInvitations(owner.userId, fixture.household.id);
      await withdrawHouseholdInvitation(owner.userId, fixture.household.id, open.id);
      expect((await inspectInvitation(second)).state).toBe("withdrawn");

      const invitee = await fixture.session("outsider");
      expect((await redeemInvitation(second, {
        userId: invitee.userId, email: address, sessionId: invitee.sessionId,
      })).state).toBe("withdrawn");
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});

describe("the audit trail", () => {
  it("records each act with the address digested and no token anywhere", async () => {
    const fixture = await createIntegrationFixture("invitation-audit");
    try {
      const owner = await fixture.session("owner");
      const capture = captureMailer();
      const address = fixture.users.outsider.email;

      await sendHouseholdInvitation(owner.userId, fixture.household.id, address, { mailer: capture.mailer });
      await sendHouseholdInvitation(owner.userId, fixture.household.id, address, { mailer: capture.mailer });
      const token = capture.lastToken();
      const invitee = await fixture.session("outsider");
      await redeemInvitation(token, { userId: invitee.userId, email: address, sessionId: invitee.sessionId });

      const rows = await getDb().select({
        entityType: auditLog.entityType,
        action: auditLog.action,
        changes: auditLog.changes,
      }).from(auditLog).where(eq(auditLog.householdId, fixture.household.id));

      expect(rows.map((row) => row.action).sort())
        .toEqual(["invitation_redeemed", "invitation_resent", "invitation_sent", "member_added"]);
      /* Redemption writes the membership trail as well as the invitation's:
         reading a household's audit must show somebody joining, not only a
         link being spent. */
      expect(rows.find((row) => row.action === "member_added")?.entityType).toBe("membership");

      const serialised = JSON.stringify(rows);
      expect(serialised).not.toContain(token);
      expect(serialised).not.toContain(address);
      expect(serialised).not.toContain(invitationTokenDigest(token));
      for (const row of rows.filter((one) => one.action !== "member_added")) {
        expect(row.changes).toMatchObject({ emailSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
      }
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});
