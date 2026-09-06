import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, instanceContact } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { requireInstanceAdministrator } from "@/server/authorization";

/**
 * The instance's one public contact address (#860): an address an
 * administrator deliberately sets for the signed-out sign-in door's "could
 * not open safely" state (#788). Never defaulted from any user account's own
 * email — that is the entire point of the setting — and clearing it is a
 * supported state, not an error.
 *
 * Follows `src/server/maintenance.ts`'s singleton shape: the 0033 migration
 * seeds the one row unconditionally, so the guard read below is always a
 * plain primary-key lookup, and `version` gates every administrator write so
 * two people editing the same field cannot silently overwrite each other.
 */

/* Matches the migration's own CHECK bound (drizzle/0033_instance_contact.sql). */
const MAX_ADDRESS_LENGTH = 320;

export interface InstanceContactSettings {
  address: string | null;
  version: number;
  updatedAt: string;
}

type ContactRow = typeof instanceContact.$inferSelect;

function toSettings(row: ContactRow): InstanceContactSettings {
  return { address: row.publicAddress, version: row.version, updatedAt: row.updatedAt.toISOString() };
}

async function readRow(): Promise<ContactRow> {
  const [row] = await getDb().select().from(instanceContact).limit(1);
  if (!row) {
    // The 0033 migration seeds this row unconditionally; its absence means
    // the database predates that migration or was tampered with, not a
    // caller error worth a 4xx.
    throw new AppError("instance_contact_state_missing", "Instance contact state has not been initialized", 500);
  }
  return row;
}

/** Trims and validates a candidate address; never logs or echoes a rejected value. */
function requireAddress(raw: string): string {
  const address = raw.trim().toLowerCase();
  if (address.length < 1 || address.length > MAX_ADDRESS_LENGTH || !z.email().safeParse(address).success) {
    throw new AppError("instance_contact_address_invalid", "That is not a usable address", 422);
  }
  return address;
}

/**
 * The signed-out read (#788, #860): no actor, no session, and nothing else
 * rides along on it — the whole point of this table is that this is the only
 * thing it is allowed to carry to an unauthenticated caller.
 */
export async function readPublicContactAddress(): Promise<string | null> {
  return (await readRow()).publicAddress;
}

/** The administrator's own read, with the version their next write must carry. */
export async function readInstanceContactSettings(actorUserId: string): Promise<InstanceContactSettings> {
  await requireInstanceAdministrator(actorUserId);
  return toSettings(await readRow());
}

/**
 * Sets, changes or clears the address. `address: null` clears it — a
 * supported state — and a non-null value is validated as an address before
 * it is ever written; a rejected value never reaches the database.
 */
export async function setPublicContactAddress(
  actorUserId: string,
  expectedVersion: number,
  address: string | null,
): Promise<InstanceContactSettings> {
  await requireInstanceAdministrator(actorUserId);
  const next = address === null || address.trim() === "" ? null : requireAddress(address);

  await getDb().transaction(async (transaction) => {
    const [row] = await transaction.select().from(instanceContact).for("update").limit(1);
    if (!row) throw new AppError("instance_contact_state_missing", "Instance contact state has not been initialized", 500);
    if (row.version !== expectedVersion) {
      throw new AppError("instance_contact_version_conflict", "The contact address changed; reload and try again", 409);
    }
    const now = new Date();
    const [updated] = await transaction.update(instanceContact)
      .set({ publicAddress: next, version: row.version + 1, updatedAt: now })
      .where(eq(instanceContact.version, row.version))
      .returning({ id: instanceContact.id });
    if (!updated) {
      throw new AppError("instance_contact_version_conflict", "The contact address changed; reload and try again", 409);
    }
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId,
      entityType: "instance_contact",
      entityId: updated.id,
      action: next ? "instance_contact_address_set" : "instance_contact_address_cleared",
      changes: { address: next },
    });
  });

  return readInstanceContactSettings(actorUserId);
}
