/**
 * AN ADMINISTRATOR SETS A MEMBER'S ADDRESS (#1869).
 *
 * The way back for an account whose stored address cannot be read (#1604) or
 * was typed wrongly at creation. Standard pattern for changing a registered
 * address (OWASP Authentication Cheat Sheet, ASVS V2): the actor was
 * re-authenticated by the caller, one account per address, tokens tied to the
 * old address are retired, and the old address is told.
 *
 * Everything that must hold together commits in ONE transaction: the new
 * ciphertext and blind index, the retired setup/recovery links, the expired
 * pending sign-in approvals and the audit record. The notice to the old
 * address goes after the commit and can fail without undoing any of it.
 *
 * No setup link is sent: the administrator uses "send a new setup link",
 * which now has a readable address to go to.
 */

import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, credentialSetupTokens, externalIdentities, signInApprovals, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { ACCOUNT_LIFECYCLE_LOCK_KEY, userAddressLockKey } from "@/lib/auth/authority-locks";
import { AuthError } from "@/lib/auth/errors";
import { sendBoundedMail, type InvitationMailer, type InvitationSendError } from "@/server/invitations/send";
import { emailSchema } from "@/server/local-credentials";
import { renderAddressChangedMail } from "@/server/local-credentials/mail";
import { openInstanceMetadataReader, requireInstanceMetadataWriter } from "@/server/metadata/fields";

export interface SetUserAddressOptions {
  /** Supplied by tests; unset means the instance's configured SMTP transport. */
  mailer?: InvitationMailer | null;
  now?: Date;
  /** The address typed again on the armed press; required when the actor changes their own (#1869). */
  confirmEmail?: string;
}

export interface SetUserAddressResult {
  /** Null when no notice was due or it went; otherwise the one bounded word for why not. */
  noticeError: InvitationSendError | null;
}

/** The refusal for an address another account already holds. */
function emailInUse(): AppError {
  return new AppError("email_in_use", "An Orbit account already uses this email address", 409);
}

function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 3; depth += 1) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Replaces `userId`'s registered address. The caller has proved the actor is
 * an administrator and re-challenged them; this is everything after that.
 */
export async function setUserAddress(
  actorUserId: string,
  userId: string,
  address: string,
  options: SetUserAddressOptions = {},
): Promise<SetUserAddressResult> {
  const email = address.trim();
  if (!emailSchema.safeParse(email).success) {
    throw new AuthError("invalid_request", "Enter a valid email address", 400);
  }

  /* Your own address: a mistyped one locks you out once this session ends, so
     the armed press must send the address again. Checked before anything is
     written. A sole administrator is not refused: this is their rescue. */
  const self = actorUserId === userId;
  if (self && options.confirmEmail?.trim().toLowerCase() !== email.toLowerCase()) {
    throw new AppError(
      "address_confirmation_required",
      "Confirm your own address by sending it again; the address was not changed",
      422,
    );
  }

  const committed = await getDb().transaction(async (transaction) => {
    /* The account-lifecycle lock first, as `linkIdentity` and provider
       sign-in take it, so a provider identity cannot be linked between the
       provider check below and the commit. Then the per-user address lock
       (lifecycle before per-user, never the reverse): it orders this change
       against `persistSetupToken` and `startSignInApproval`. Neither of those
       holds it across the mail it sends, so this lock alone does not stop a
       link or approval mailed to the old address; each re-checks the address
       under this lock before writing (a setup link refuses if the stored
       address index changed since it was mailed; an approval reads the address
       under the lock), and anything written before this commits is retired
       below. */
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ACCOUNT_LIFECYCLE_LOCK_KEY}, 0))`);
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userAddressLockKey(userId)}, 0))`);
    const [target] = await transaction
      .select({ id: users.id, displayName: users.displayName, emailEnc: users.emailEnc })
      .from(users)
      .where(eq(users.id, userId))
      .for("update")
      .limit(1);
    if (!target) throw new AppError("user_not_found", "That registered Orbit user is no longer available", 404);

    /* A locked instance refuses (503, nothing written). A damaged ciphertext
       is what this exists to mend and is not a refusal. */
    const cipher = await requireInstanceMetadataWriter(transaction);

    const [provider] = await transaction
      .select({ id: externalIdentities.id })
      .from(externalIdentities)
      .where(eq(externalIdentities.userId, userId))
      .limit(1);
    if (provider) {
      throw new AppError(
        "address_from_provider",
        "This account's address comes from its sign-in provider, so it cannot be set here",
        409,
      );
    }

    const emailIndex = cipher.emailIndex(email);
    const [taken] = emailIndex === null
      ? []
      : await transaction
        .select({ id: users.id })
        .from(users)
        /* Not the target's own row: a damaged row can still carry the right index. */
        .where(and(eq(users.emailIndex, emailIndex), ne(users.id, userId)))
        .limit(1);
    if (taken) throw emailInUse();

    const previous = (await openInstanceMetadataReader(transaction))
      .text("users.email", userId, { encrypted: target.emailEnc }).value;

    const now = new Date();
    try {
      await transaction
        .update(users)
        .set({ emailEnc: cipher.encryptText("users.email", userId, email), emailIndex, updatedAt: now })
        .where(eq(users.id, userId));
    } catch (error) {
      if (isUniqueViolation(error)) throw emailInUse();
      throw error;
    }

    /* Links tied to the old address, retired the way `persistSetupToken`
       supersedes them: expired, never marked consumed. */
    await transaction
      .update(credentialSetupTokens)
      .set({ expiresAt: now })
      .where(and(
        eq(credentialSetupTokens.userId, userId),
        isNull(credentialSetupTokens.consumedAt),
        gt(credentialSetupTokens.expiresAt, now),
      ));
    /* Unspent sign-in approvals, open or approved but not yet collected:
       expired (consumed, no new outcome). Not `denied`, so no backoff count
       and no "wasn't me" notice; the waiting tab sees it lapse, and an
       approval pressed from the old mailbox cannot be collected into a
       session. An approved row keeps the outcome it was given: that press
       happened. */
    await transaction
      .update(signInApprovals)
      .set({ consumedAt: now, expiresAt: now })
      .where(and(
        eq(signInApprovals.userId, userId),
        isNull(signInApprovals.consumedAt),
        gt(signInApprovals.expiresAt, now),
      ));

    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId,
      entityType: "user",
      entityId: userId,
      action: "email_address_set",
      changes: { userId, previous: previous === null ? "unreadable" : "readable", self },
    });

    return { displayName: target.displayName, previous };
  });

  const { previous, displayName } = committed;
  if (previous === null || previous.toLowerCase() === email.toLowerCase()) return { noticeError: null };
  try {
    const outcome = await sendBoundedMail(
      previous,
      { ...renderAddressChangedMail({ displayName, appUrl: process.env.APP_URL }), what: "an address change notice" },
      options.mailer,
      options.now ?? new Date(),
    );
    return { noticeError: outcome.sendError };
  } catch {
    return { noticeError: "unknown" };
  }
}
