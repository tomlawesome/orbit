/**
 * The last resort when the encryption key and the recovery bundle are both
 * gone (#970, slice 3 of #966, ADR-0022 §5's host-CLI pattern).
 *
 * It recovers nothing. Documents and encrypted metadata are unrecoverable
 * without the key and stay that way; what this stops is the *second* loss that
 * follows from the first. Orbit finds an account by its address, the address
 * is encrypted (#969), and with the key gone nobody can sign in — leaving an
 * instance that is a brick with intact accounts inside it.
 *
 * So this clears the addresses it cannot read, and nothing else. Accounts,
 * households, memberships and every other structural row survive. The primary
 * administrator comes back through `orbit auth recovery-link`, which never
 * touches an address, and re-enters members' addresses by hand.
 *
 * Two guards, and they are the reason this module exists rather than a few
 * lines of SQL in the CLI:
 *
 *  - **It refuses while the key still works.** The likelier failure by far is
 *    panic: an operator sees "instance locked", assumes the worst, and
 *    destroys addresses that were perfectly recoverable because the key was
 *    fine and only the bundle needed restoring. Checked here, so the refusal
 *    cannot be skipped by a caller that forgot.
 *  - **Nothing network-reachable may call it.** An API route would turn this
 *    into a one-request wipe of every account's identity. Nothing here is
 *    exported to a route, and `tests/integration/account-address-reset.test.ts`
 *    asserts that over the route table rather than trusting the intention.
 */
import { randomUUID } from "node:crypto";
import { isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, mailInSenderAddresses, users } from "@/db/schema";
import { loadMetadataKey, MetadataKeyLockedError } from "@/server/metadata/keys";

export interface AddressResetOutcome {
  /** Accounts whose unreadable address was cleared. */
  users: number;
  /** Sending addresses removed, which is all of the encrypted ones. */
  senderAddresses: number;
}

/**
 * Whether the instance can still read its own encrypted metadata.
 *
 * True means there is nothing wrong that this command should touch: either the
 * key is present and unwraps the stored key, or the stored key is fine and the
 * operator's real problem is elsewhere. False means the key is absent, or is
 * the wrong one — the state this command exists for.
 *
 * An instance that has never encrypted anything has no stored key at all. That
 * also reads as "not usable", and is handled by the caller as "nothing to do"
 * rather than as damage: there are no unreadable addresses to clear.
 */
export async function encryptionKeyIsUsable(): Promise<boolean> {
  try {
    return (await loadMetadataKey("instance", null)) !== undefined;
  } catch (error) {
    if (error instanceof MetadataKeyLockedError) return false;
    throw error;
  }
}

/**
 * Clears every address the instance can no longer read, in one transaction.
 *
 * Only encrypted rows are touched. An account whose address is still plaintext
 * — one the backfill never reached — can be signed into perfectly well, so
 * taking its address away would destroy access this command is meant to
 * restore.
 *
 * Accounts keep their row and lose only the address. Sending addresses are
 * removed outright rather than blanked: the row carries nothing but an address
 * and whether it was proven, so a blanked one is not a record of anything — it
 * would show the member an empty address with no explanation, and could never
 * match incoming mail again. The member adds and proves the address afresh,
 * which is the same path they took the first time.
 */
export async function clearUnreadableAddresses(): Promise<AddressResetOutcome> {
  return getDb().transaction(async (transaction) => {
    const clearedUsers = await transaction.update(users)
      .set({ email: null, emailEnc: null, emailIndex: null, updatedAt: new Date() })
      .where(isNotNull(users.emailEnc))
      .returning({ id: users.id });

    const clearedSenders = await transaction.delete(mailInSenderAddresses)
      .where(isNotNull(mailInSenderAddresses.addressEnc))
      .returning({ id: mailInSenderAddresses.id });

    /* Recorded against no actor: this runs from the host shell, where there is
       no signed-in user to name, and the whole point of the situation is that
       nobody can sign in. `entity_id` is NOT NULL and there is no single row
       this happened to, so it carries an id for the episode itself — one reset
       run, identified. The counts are the rest of the record: the addresses
       could not be read, so there is nothing else truthful to write down. */
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId: null,
      entityType: "instance",
      entityId: randomUUID(),
      action: "account_addresses_cleared",
      changes: { users: clearedUsers.length, senderAddresses: clearedSenders.length },
    });

    return { users: clearedUsers.length, senderAddresses: clearedSenders.length };
  });
}
