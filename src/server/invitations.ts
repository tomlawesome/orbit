import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, householdInvitations, households, memberships, sessions, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { householdOwnerLockKey } from "@/lib/auth/authority-locks";
import { acquireActiveHouseholdLock, requireHouseholdAccess, requireUuid } from "@/server/workspace-access";
import {
  openMetadataReader,
  requireMetadataWriter,
  type MetadataCipher,
} from "@/server/metadata/fields";
import { sendInvitationMail, invitationLink, type InvitationMailer, type InvitationSendError } from "@/server/invitations/send";
import {
  createInvitationToken,
  invitationEmailDigest,
  invitationExpiry,
  invitationTokenDigest,
  normaliseInvitationEmail,
} from "@/server/invitations/token";

/**
 * EMAIL INVITATIONS (#481) — inviting somebody who has no account yet.
 *
 * A join request is a person who already signed in choosing a household off
 * their own sky. An invitation runs the other way: an owner naming an address,
 * and Orbit sending the only thing that address has ever received from this
 * instance. Everything that makes that safe is here.
 *
 *   · Owners send and withdraw; members see the list and cannot touch it.
 *   · The signed-in identity's address MUST match the invited one (Q43). Without
 *     that, whoever holds the link joins — a forwarded mail would put a
 *     stranger in the household.
 *   · One open invitation per household and address, enforced by a partial
 *     unique index; a resend REPLACES the row, so the earlier link dies with no
 *     second row to reason about.
 *   · The token never appears in a response, a log line or an audit row. Audit
 *     `changes` carries the address's digest, never the address.
 *
 * Nothing here discloses whether an address already has an account. The owner
 * types an address and gets the same answer either way, because the alternative
 * is an account-enumeration oracle wearing a household screen.
 */

export { INVITATION_LIFETIME_DAYS } from "@/server/invitations/token";
export type { InvitationSendError } from "@/server/invitations/send";

/** Past this many open invitations a household is asked to tidy up first. */
export const MAX_OPEN_INVITATIONS = 20;

/** What the household screen is told about one invitation. No token, ever. */
export interface HouseholdInvitation {
  id: string;
  householdId: string;
  email: string;
  createdAt: string;
  sentAt: string | null;
  sendError: InvitationSendError | null;
  expiresAt: string;
}

/** What a link is worth, to somebody holding it and nothing else. */
export type InvitationState = "open" | "used" | "expired" | "withdrawn" | "unknown";

export interface InvitationView {
  state: InvitationState;
  /** "ask Sam for a new one" — a chosen display name, never an address. */
  inviterName: string | null;
}

export type RedemptionState = InvitationState | "joined" | "already_member" | "mismatch";

export interface Redemption {
  state: RedemptionState;
  inviterName: string | null;
  householdId: string | null;
  householdName: string | null;
}

const emailSchema = z.email();

type InvitationRow = {
  id: string;
  /** Plaintext only for a row the backfill has not reached; `emailEnc` otherwise (#963). */
  email: string | null;
  emailEnc: string | null;
  householdId: string;
  createdAt: Date;
  sentAt: Date | null;
  sendError: string | null;
  expiresAt: Date;
};

/**
 * The invited address, decrypted (#963). An address that will not decrypt is
 * reported as the damaged-value marker rather than as an empty address or an
 * invented one, and a marker never matches anybody at redemption.
 */
function invitationEmail(cipher: MetadataCipher, row: { id: string; email: string | null; emailEnc: string | null }): string | null {
  return cipher.text("household_invitations.email", row.id, { encrypted: row.emailEnc, plaintext: row.email }).value;
}

function summarise(row: InvitationRow, cipher: MetadataCipher): HouseholdInvitation {
  return {
    id: row.id,
    householdId: row.householdId,
    email: invitationEmail(cipher, row) ?? "",
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    sendError: (row.sendError as InvitationSendError | null) ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}

const summaryColumns = {
  id: householdInvitations.id,
  householdId: householdInvitations.householdId,
  email: householdInvitations.email,
  emailEnc: householdInvitations.emailEnc,
  createdAt: householdInvitations.createdAt,
  sentAt: householdInvitations.sentAt,
  sendError: householdInvitations.sendError,
  expiresAt: householdInvitations.expiresAt,
};

/** Open means neither redeemed nor withdrawn. Expiry is a date, not a state. */
const stillOpen = and(isNull(householdInvitations.redeemedAt), isNull(householdInvitations.revokedAt));

/**
 * The household's open invitations, for anyone who may see that household.
 *
 * Members get the same list an owner does. They typed none of it and can
 * change none of it, but a household where an owner can quietly add people by
 * mail and nobody else can see it happening is not the household this product
 * describes (§11's "who sees what").
 */
export async function listHouseholdInvitations(actorUserId: string, householdId: string): Promise<HouseholdInvitation[]> {
  await requireHouseholdAccess(actorUserId, householdId);
  const rows = await getDb().select(summaryColumns)
    .from(householdInvitations)
    .where(and(eq(householdInvitations.householdId, householdId), stillOpen))
    .orderBy(asc(householdInvitations.createdAt));
  // One DEK unwrap for the whole list (ADR-0024 decision 1), not one per row.
  const cipher = await openMetadataReader(householdId);
  return rows.map((row) => summarise(row, cipher));
}

/** The owner check, made again inside the lock the write is taken under. */
async function assertOwnerUnderLock(
  transaction: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  actorUserId: string,
  householdId: string,
): Promise<void> {
  const [actor] = await transaction.select({
    role: memberships.role,
    administrator: users.isInstanceAdmin,
    disabledAt: users.disabledAt,
  }).from(users).leftJoin(
    memberships,
    and(eq(memberships.userId, users.id), eq(memberships.householdId, householdId)),
  ).where(eq(users.id, actorUserId)).limit(1);
  if (!actor || actor.disabledAt) {
    throw new AppError("household_not_found", "That household is not available", 404);
  }
  if (!actor.administrator && actor.role !== "owner") {
    throw new AppError("owner_required", "Only a household owner can invite someone", 403);
  }
}

export interface SendInvitationResult {
  invitation: HouseholdInvitation;
  invitations: HouseholdInvitation[];
}

/**
 * Sends — or resends, which is the same act — one invitation.
 *
 * The row is committed BEFORE the mail is attempted, and the outcome of the
 * attempt is written back afterwards. That order is deliberate: a send held
 * inside the transaction would keep the household's advisory lock for as long
 * as a blackholed SMTP host takes to time out, and every ordinary write for
 * that household would queue behind an invitation.
 */
export async function sendHouseholdInvitation(
  actorUserId: string,
  householdId: string,
  rawEmail: string,
  options: { mailer?: InvitationMailer | null; now?: Date } = {},
): Promise<SendInvitationResult> {
  requireUuid(householdId, "Household");
  await requireHouseholdAccess(actorUserId, householdId, true);

  const email = normaliseInvitationEmail(rawEmail);
  if (!emailSchema.safeParse(email).success) {
    throw new AppError("invalid_email", "That does not look like an email address", 422);
  }

  const now = options.now ?? new Date();
  const token = createInvitationToken();
  const expiresAt = invitationExpiry(now);
  /* The row id has to exist before the address is encrypted: the content AAD
     binds the ciphertext to its row, so a value cannot be replayed into
     another invitation (ADR-0024 decision 3). A resend reuses the row it
     replaces, and this id is discarded. */
  const invitationRowId = randomUUID();

  const prepared = await getDb().transaction(async (transaction) => {
    await acquireActiveHouseholdLock(transaction, householdId);
    await assertOwnerUnderLock(transaction, actorUserId, householdId);

    // Tier 2 (#963): the address is ciphertext, so "is there already one for
    // this address" is answered by the per-household blind index rather than
    // by comparing stored bytes. The index is what carries the database's
    // "one open invitation per address" rule across the encryption, and the
    // resend below still REPLACES the row it finds.
    const metadata = await requireMetadataWriter(householdId, transaction);
    const emailIndex = metadata.blindIndex("household_invitations.email", email);
    const open = await transaction.select({ id: householdInvitations.id, email: householdInvitations.email, emailIndex: householdInvitations.emailIndex })
      .from(householdInvitations)
      .where(and(eq(householdInvitations.householdId, householdId), stillOpen));
    const existing = open.find((row) => (
      row.emailIndex !== null ? row.emailIndex === emailIndex : row.email === email
    ));
    if (!existing && open.length >= MAX_OPEN_INVITATIONS) {
      throw new AppError(
        "invitation_limit",
        `This household already has ${MAX_OPEN_INVITATIONS} invitations waiting — withdraw one before sending another`,
        409,
      );
    }

    const values = {
      email: null,
      emailEnc: metadata.encryptText("household_invitations.email", existing?.id ?? invitationRowId, email),
      emailIndex,
      tokenDigest: invitationTokenDigest(token),
      expiresAt,
      invitedByUserId: actorUserId,
      /* Cleared, not carried: this is a new link and its send has not happened
         yet, so a stale success or failure must not be read as this one's. */
      sentAt: null,
      sendError: null,
    };
    const [row] = existing
      ? await transaction.update(householdInvitations).set(values)
        .where(eq(householdInvitations.id, existing.id))
        .returning(summaryColumns)
      : await transaction.insert(householdInvitations)
        .values({ id: invitationRowId, householdId, role: "member", ...values })
        .returning(summaryColumns);
    if (!row) throw new AppError("unexpected_failure", "The invitation could not be recorded", 500);

    await transaction.insert(auditLog).values({
      householdId,
      actorUserId,
      entityType: "household_invitation",
      entityId: row.id,
      action: existing ? "invitation_resent" : "invitation_sent",
      changes: { emailSha256: invitationEmailDigest(email) },
    });

    const [household] = await transaction.select({ name: households.name })
      .from(households).where(eq(households.id, householdId)).limit(1);
    const [inviter] = await transaction.select({ displayName: users.displayName })
      .from(users).where(eq(users.id, actorUserId)).limit(1);
    return {
      row,
      householdName: household?.name ?? "",
      inviterName: inviter?.displayName ?? "",
    };
  });

  const outcome = await sendInvitationMail({
    inviterName: prepared.inviterName,
    householdName: prepared.householdName,
    email,
    link: invitationLink(token),
    expiresAt,
  }, options.mailer, now);

  const [recorded] = await getDb().update(householdInvitations)
    .set({ sentAt: outcome.sentAt, sendError: outcome.sendError })
    .where(eq(householdInvitations.id, prepared.row.id))
    .returning(summaryColumns);

  const cipher = await openMetadataReader(householdId);
  return {
    invitation: summarise(recorded ?? { ...prepared.row, ...outcome }, cipher),
    invitations: await listHouseholdInvitations(actorUserId, householdId),
  };
}

/** Withdraws an open invitation; the link then fails as "withdrawn". */
export async function withdrawHouseholdInvitation(
  actorUserId: string,
  householdId: string,
  invitationId: string,
): Promise<HouseholdInvitation[]> {
  requireUuid(householdId, "Household");
  requireUuid(invitationId, "Invitation");
  await requireHouseholdAccess(actorUserId, householdId, true);

  await getDb().transaction(async (transaction) => {
    await acquireActiveHouseholdLock(transaction, householdId);
    await assertOwnerUnderLock(transaction, actorUserId, householdId);
    const [revoked] = await transaction.update(householdInvitations)
      .set({ revokedAt: new Date(), revokedByUserId: actorUserId })
      .where(and(
        eq(householdInvitations.id, invitationId),
        eq(householdInvitations.householdId, householdId),
        stillOpen,
      ))
      .returning({ id: householdInvitations.id, email: householdInvitations.email, emailEnc: householdInvitations.emailEnc });
    if (!revoked) throw new AppError("invitation_not_found", "That invitation is no longer open", 404);
    /* The audit line records a digest of the address, never the address, and
       that is unchanged (#963). What changed is where the address comes from:
       an unreadable one is recorded as no address rather than as an invented
       digest, because a digest of "" would look exactly like a real record. */
    const withdrawnEmail = invitationEmail(await openMetadataReader(householdId, transaction), revoked);
    await transaction.insert(auditLog).values({
      householdId,
      actorUserId,
      entityType: "household_invitation",
      entityId: revoked.id,
      action: "invitation_withdrawn",
      changes: withdrawnEmail ? { emailSha256: invitationEmailDigest(withdrawnEmail) } : {},
    });
  });

  return listHouseholdInvitations(actorUserId, householdId);
}

const lookupColumns = {
  id: householdInvitations.id,
  householdId: householdInvitations.householdId,
  email: householdInvitations.email,
  emailEnc: householdInvitations.emailEnc,
  expiresAt: householdInvitations.expiresAt,
  redeemedAt: householdInvitations.redeemedAt,
  revokedAt: householdInvitations.revokedAt,
};

/**
 * What a link is worth, without signing anybody in.
 *
 * Deliberately says nothing a stranger could use: no household name unless the
 * invitation is still open, no address, no token detail. The inviter's chosen
 * name is disclosed, because "ask Sam for a new one" is the whole of what a
 * spent link has left to offer, and it is a name they publish to every
 * household they are in.
 */
export async function inspectInvitation(token: string): Promise<InvitationView> {
  const [row] = await getDb().select({
    ...lookupColumns,
    inviterName: users.displayName,
    householdDeletionRequestedAt: households.deletionRequestedAt,
  })
    .from(householdInvitations)
    .innerJoin(households, eq(households.id, householdInvitations.householdId))
    .leftJoin(users, eq(users.id, householdInvitations.invitedByUserId))
    .where(eq(householdInvitations.tokenDigest, invitationTokenDigest(token)))
    .limit(1);
  if (!row || row.householdDeletionRequestedAt) return { state: "unknown", inviterName: null };
  return { state: stateOf(row, new Date()), inviterName: row.inviterName ?? null };
}

function stateOf(
  row: { expiresAt: Date; redeemedAt: Date | null; revokedAt: Date | null },
  now: Date,
): InvitationState {
  if (row.revokedAt) return "withdrawn";
  if (row.redeemedAt) return "used";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "open";
}

export interface RedeemingUser {
  userId: string;
  email: string;
  /** The session whose active household is set on success. */
  sessionId: string;
}

/**
 * Redeems a link for the person now signed in (#481, step 4).
 *
 * One transaction takes the household's own advisory lock, so a redemption and
 * an owner's withdrawal of the same invitation cannot both believe they won.
 * Failure states are RETURNED, not thrown: every one of them has a calm page
 * to draw, and a thrown 404 would send the reader to the error screen instead.
 */
export async function redeemInvitation(token: string, user: RedeemingUser): Promise<Redemption> {
  const digest = invitationTokenDigest(token);
  const nothing: Redemption = { state: "unknown", inviterName: null, householdId: null, householdName: null };

  return getDb().transaction(async (transaction) => {
    const [found] = await transaction.select({
      ...lookupColumns,
      householdName: households.name,
      householdDeletionRequestedAt: households.deletionRequestedAt,
      inviterName: users.displayName,
    })
      .from(householdInvitations)
      .innerJoin(households, eq(households.id, householdInvitations.householdId))
      .leftJoin(users, eq(users.id, householdInvitations.invitedByUserId))
      .where(eq(householdInvitations.tokenDigest, digest))
      .limit(1);
    if (!found || found.householdDeletionRequestedAt) return nothing;

    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${householdOwnerLockKey(found.householdId)}, 0))`,
    );
    /* Read again under the lock: everything decided below is decided on this
       row, not on the one read a moment before the lock was taken. */
    const [row] = await transaction.select(lookupColumns)
      .from(householdInvitations)
      .where(eq(householdInvitations.id, found.id))
      .for("update")
      .limit(1);
    if (!row) return nothing;

    const inviterName = found.inviterName ?? null;
    const now = new Date();
    const state = stateOf(row, now);
    if (state !== "open") return { state, inviterName, householdId: null, householdName: null };

    /* THE MATCH (Q43). A mismatch changes nothing at all: the invitation stays
       open for the person it was addressed to, and the reader is told to sign
       out rather than quietly handed somebody else's household. */
    /* Tier 2 (#963): the stored address decrypts under the household's own key
       before the comparison, which is otherwise exactly the comparison it was.
       An address that will not decrypt is null, and null matches nobody — the
       invitation stays open and the reader is told to sign out, which is the
       right way for this to fail. */
    const invitedAddress = invitationEmail(await openMetadataReader(row.householdId, transaction), row);
    if (!invitedAddress || normaliseInvitationEmail(user.email) !== invitedAddress) {
      return { state: "mismatch", inviterName, householdId: null, householdName: null };
    }

    const [membership] = await transaction.select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.householdId, row.householdId), eq(memberships.userId, user.userId)))
      .limit(1);

    await transaction.update(householdInvitations)
      .set({ redeemedAt: now, redeemedByUserId: user.userId })
      .where(eq(householdInvitations.id, row.id));

    if (!membership) {
      await transaction.insert(memberships)
        .values({ householdId: row.householdId, userId: user.userId, role: "member" })
        .onConflictDoNothing();
      /* The membership trail, alongside the invitation's own: reading the
         household's audit must show somebody joining, not only a link being
         spent. */
      await transaction.insert(auditLog).values({
        householdId: row.householdId,
        actorUserId: user.userId,
        entityType: "membership",
        entityId: user.userId,
        action: "member_added",
        changes: {},
      });
    }

    await transaction.insert(auditLog).values({
      householdId: row.householdId,
      actorUserId: user.userId,
      entityType: "household_invitation",
      entityId: row.id,
      action: "invitation_redeemed",
      /* The address that was just matched, which is the decrypted one (#963);
         a digest is recorded, never the address itself. */
      changes: { emailSha256: invitationEmailDigest(invitedAddress) },
    });

    /* The arrival's household CHOICE never appears because there is nothing
       left to choose (#871: the sky moves to this household instead, once
       the newcomer's own count has had its moment) — but the arrival itself
       still plays, because `/invite/[token]/+page.server.js` redirects to
       `/`, not `/home`, and sets the one-shot cookie that tells this landing
       apart from an ordinary return visit. */
    await transaction.update(sessions)
      .set({ activeHouseholdId: row.householdId })
      .where(eq(sessions.id, user.sessionId));

    return {
      state: membership ? "already_member" : "joined",
      inviterName,
      householdId: row.householdId,
      householdName: found.householdName,
    };
  });
}
