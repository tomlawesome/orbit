import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, households, instanceAuthority, memberships, sections, sessions, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { ACCOUNT_LIFECYCLE_LOCK_KEY, ADMINISTRATOR_LOCK_KEY } from "@/lib/auth/authority-locks";
import { requireUuid } from "@/lib/uuid";
import { cloneSections } from "@/lib/workspace";
import { openInstanceMetadataReader, type MetadataCipher, type MetadataFieldState } from "@/server/metadata/fields";
import { requireActiveAdministrator, requireInstanceAdministrator } from "@/server/authorization";
import { sectionSlug } from "@/server/workspace-access";

export interface InstanceUser {
  id: string;
  displayName: string;
  /**
   * Null when there is no readable address (#969): a locked instance, or a
   * damaged stored value. Never an empty string and never an invented one —
   * `metadataStatus.email` is what says why it is missing, exactly as an
   * item's title does (`workspace-repository.ts`, ADR-0024 decision 5).
   */
  email: string | null;
  metadataStatus?: { email?: MetadataFieldState };
  isInstanceAdmin: boolean;
  isPrimaryAdministrator: boolean;
  disabledAt: Date | null;
}

/**
 * The administration user list is a hard-capped, display-name-ordered page
 * rather than paginated (owner ruling, #592: a thousand users is far beyond
 * any expected instance). `listInstanceUsers` reports `totalCount` and
 * `truncated` so a caller never presents a cut result as complete.
 */
export interface InstanceUserList {
  users: InstanceUser[];
  totalCount: number;
  truncated: boolean;
}

/** Hard cap on the administration user list (#592). Not pagination — see InstanceUserList. */
export const ADMIN_USER_LIST_CAP = 1_000;

type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/** The current primary administrator, or null before the first bootstrap. */
async function primaryAdministratorId(transaction: Transaction): Promise<string | null> {
  const [row] = await transaction
    .select({ primaryUserId: instanceAuthority.primaryUserId })
    .from(instanceAuthority)
    .limit(1);
  return row?.primaryUserId ?? null;
}

const instanceUserColumns = {
  id: users.id,
  displayName: users.displayName,
  /* The address is read from `email_enc` only (#1403 Q3). */
  emailEnc: users.emailEnc,
  isInstanceAdmin: users.isInstanceAdmin,
  disabledAt: users.disabledAt,
};

type InstanceUserRow = {
  id: string;
  displayName: string;
  emailEnc: string | null;
  isInstanceAdmin: boolean;
  disabledAt: Date | null;
};

function toInstanceUser(row: InstanceUserRow, cipher: MetadataCipher, primaryUserId: string | null): InstanceUser {
  const email = cipher.text("users.email", row.id, { encrypted: row.emailEnc, plaintext: null });
  return {
    id: row.id,
    displayName: row.displayName,
    email: email.value,
    metadataStatus: email.state ? { email: email.state } : undefined,
    isInstanceAdmin: row.isInstanceAdmin,
    isPrimaryAdministrator: row.id === primaryUserId,
    disabledAt: row.disabledAt,
  };
}

/** Addresses last when they cannot be read, which is where a null sorts. */
function compareEmail(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right);
}

export async function listInstanceUsers(actorUserId: string): Promise<InstanceUserList> {
  await requireInstanceAdministrator(actorUserId);
  return instanceUserList();
}

/**
 * `listInstanceUsers`'s own body, without the admin check (#1151 A1-Q1): a
 * mutation elsewhere in this file already re-reads and verifies the actor
 * as part of its own transaction before it ever gets here, so calling the
 * guarded export afterwards to build its return value re-ran a check that
 * had already passed, a moment earlier, on the same actor. Only
 * `listInstanceUsers` is exported; a caller with no transaction of its own
 * to have already verified from must still go through it.
 */
async function instanceUserList(): Promise<InstanceUserList> {
  const db = getDb();
  const [authority] = await db
    .select({ primaryUserId: instanceAuthority.primaryUserId })
    .from(instanceAuthority)
    .limit(1);
  const primaryUserId = authority?.primaryUserId ?? null;

  const [rows, [countRow]] = await Promise.all([
    db
      .select(instanceUserColumns)
      .from(users)
      /* Display name only (#969): the address is ciphertext, so SQL cannot
         order by it any more. The tiebreak between equal display names moves
         below, after decryption. */
      .orderBy(asc(users.displayName))
      .limit(ADMIN_USER_LIST_CAP),
    db.select({ totalCount: sql<number>`count(*)::int` }).from(users),
  ]);

  // One instance-key unwrap for the whole list (ADR-0024 decision 1), not one
  // per row. Account addresses are instance-scope: no household owns them.
  const cipher = await openInstanceMetadataReader();
  /* The order the query used to produce whole: display name from SQL, address
     as the tiebreak here. The SQL position is what separates two different
     display names, so the database's own collation still decides that half —
     this only reorders rows the database considers equal. */
  const listed = rows
    .map((row, position) => ({ position, user: toInstanceUser(row, cipher, primaryUserId) }))
    .sort((left, right) => (
      left.user.displayName === right.user.displayName
        ? compareEmail(left.user.email, right.user.email)
        : left.position - right.position
    ))
    .map((entry) => entry.user);

  // The cap above is a display-name-ordered page: on its own, a primary
  // administrator whose display name sorts past the cap would silently
  // disappear from the administration surface (#592) — the exact failure
  // that let an operator lose sight of the account holding final authority.
  // Guarantee they are always reachable, independent of sort order.
  if (primaryUserId && !listed.some((user) => user.id === primaryUserId)) {
    const [primaryRow] = await db
      .select(instanceUserColumns)
      .from(users)
      .where(eq(users.id, primaryUserId))
      .limit(1);
    // First, deliberately, and outside the sort: this row is past the cap, so
    // ordering it back into the page is exactly the disappearance #592 forbids.
    if (primaryRow) listed.unshift(toInstanceUser(primaryRow, cipher, primaryUserId));
  }

  return {
    users: listed,
    totalCount: countRow?.totalCount ?? listed.length,
    truncated: (countRow?.totalCount ?? 0) > ADMIN_USER_LIST_CAP,
  };
}

/** Updates administrator rights while ensuring the instance always retains one administrator. */
export async function setInstanceAdministrator(
  actorUserId: string,
  targetUserId: string,
  administrator: boolean,
): Promise<InstanceUserList> {
  requireUuid(targetUserId, "User");

  await getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ADMINISTRATOR_LOCK_KEY}, 0))`);
    await requireActiveAdministrator(actorUserId, transaction);

    const [target] = await transaction.select({ administrator: users.isInstanceAdmin, disabledAt: users.disabledAt }).from(users)
      .where(eq(users.id, targetUserId)).limit(1);
    if (!target) throw new AppError("user_not_found", "That registered Orbit user is no longer available", 404);
    if (target.disabledAt) {
      throw new AppError("account_disabled", "Enable this Orbit account before granting administrator access", 409);
    }
    if (target.administrator === administrator) return;

    if (!administrator && targetUserId === actorUserId) {
      throw new AppError(
        "self_demotion_not_allowed",
        "Ask another administrator to remove your administrator access",
        409,
      );
    }

    /* The primary administrator cannot be demoted by anyone — authority moves
       first, by explicit transfer (#263). */
    if (!administrator && targetUserId === await primaryAdministratorId(transaction)) {
      throw new AppError(
        "primary_administrator_protected",
        "Transfer primary administrator authority before changing this account",
        409,
      );
    }

    if (!administrator && target.administrator) {
      const [state] = await transaction
        .select({ administrators: sql<number>`count(*)::int` })
        .from(users)
        .where(and(eq(users.isInstanceAdmin, true), isNull(users.disabledAt)));
      if (state.administrators <= 1) {
        throw new AppError("last_administrator", "Orbit must retain at least one administrator", 409);
      }
    }

    await transaction.update(users)
      .set({ isInstanceAdmin: administrator, updatedAt: new Date() })
      .where(eq(users.id, targetUserId));
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId,
      entityType: "user",
      entityId: targetUserId,
      action: administrator ? "administrator_granted" : "administrator_revoked",
      changes: { administrator },
    });
  });

  return instanceUserList();
}

/**
 * Disables an account without deleting its household records or audit history.
 * Existing sessions are deleted inside the same transaction so access ends
 * immediately after the administrator action succeeds.
 */
export async function setInstanceUserDisabled(
  actorUserId: string,
  targetUserId: string,
  disabled: boolean,
): Promise<InstanceUserList> {
  requireUuid(targetUserId, "User");

  await getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ADMINISTRATOR_LOCK_KEY}, 0))`);
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ACCOUNT_LIFECYCLE_LOCK_KEY}, 0))`);
    await requireActiveAdministrator(actorUserId, transaction);

    const [target] = await transaction.select({ administrator: users.isInstanceAdmin, disabledAt: users.disabledAt }).from(users)
      .where(eq(users.id, targetUserId)).limit(1);
    if (!target) throw new AppError("user_not_found", "That registered Orbit user is no longer available", 404);
    if (targetUserId === actorUserId && disabled) {
      throw new AppError("self_disable_not_allowed", "Ask another administrator to disable your account", 409);
    }
    /* The primary administrator cannot be disabled by anyone — authority moves
       first, by explicit transfer (#263). */
    if (disabled && targetUserId === await primaryAdministratorId(transaction)) {
      throw new AppError(
        "primary_administrator_protected",
        "Transfer primary administrator authority before changing this account",
        409,
      );
    }
    const alreadyDisabled = target.disabledAt !== null;
    if (alreadyDisabled === disabled) return;

    if (disabled && target.administrator) {
      const [state] = await transaction
        .select({ administrators: sql<number>`count(*)::int` })
        .from(users)
        .where(and(eq(users.isInstanceAdmin, true), isNull(users.disabledAt)));
      if (state.administrators <= 1) {
        throw new AppError("last_administrator", "Orbit must retain at least one active administrator", 409);
      }
    }

    if (disabled) {
      const ownedHouseholds = await transaction.select({ householdId: memberships.householdId })
        .from(memberships)
        .where(and(eq(memberships.userId, targetUserId), eq(memberships.role, "owner")));
      for (const ownedHousehold of ownedHouseholds) {
        const [state] = await transaction.select({ owners: sql<number>`count(*)::int` })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(and(
            eq(memberships.householdId, ownedHousehold.householdId),
            eq(memberships.role, "owner"),
            isNull(users.disabledAt),
            sql`${memberships.userId} <> ${targetUserId}`,
          ));
        if ((state?.owners ?? 0) <= 0) {
          throw new AppError(
            "owner_protected",
            "Transfer ownership before disabling this account",
            409,
          );
        }
      }
    }

    await transaction.update(users)
      .set({ disabledAt: disabled ? new Date() : null, updatedAt: new Date() })
      .where(eq(users.id, targetUserId));
    if (disabled) await transaction.delete(sessions).where(eq(sessions.userId, targetUserId));
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId,
      entityType: "user",
      entityId: targetUserId,
      action: disabled ? "account_disabled" : "account_enabled",
      changes: { disabled },
    });
  });

  return instanceUserList();
}

/**
 * The name and owner a new system needs, and nothing else (#1052).
 *
 * Length and emptiness are checked here rather than only at the route, so the
 * refusal is the same wherever the call comes from: 60 characters is
 * `householdWorkspaceSchema`'s own limit for a household name, and the
 * arrival's `NAME_LIMIT` is the same number on the browser side.
 */
export const HOUSEHOLD_NAME_LIMIT = 60;

/** What an administrator learns about the system they just made. */
export interface CreatedHousehold {
  id: string;
  name: string;
  ownerId: string;
}

/**
 * An administrator creates a household for somebody else (#1052, Fable's
 * decision of 2026-09-19).
 *
 * Until now a household only came into being at arrival, where the person
 * creating it becomes its owner: `applyWorkspaceCommand`'s `household.create`
 * branch inserts the owner membership for the CALLER and points the caller's
 * session at the new household. Neither is right here — the administrator is
 * not the owner and may not be a member at all, and their own active household
 * must not move because they made a system for someone else. So this writes
 * the same three tables that branch writes, with the named user as owner and
 * no session touched.
 *
 * Everything else is deliberately identical to that branch: the default
 * section set from one place (`cloneSections`), `setupCompleted` true so the
 * owner arrives at a finished system rather than an onboarding shell, the
 * refusal on a name a removed household is still holding, and an audit row
 * written inside the same transaction as the insert, so the trail cannot exist
 * without the household or the household without the trail.
 */
export async function createHouseholdForOwner(
  actorUserId: string,
  input: { name: string; ownerId: string },
): Promise<CreatedHousehold> {
  await requireInstanceAdministrator(actorUserId);

  const name = input.name.trim();
  if (name.length === 0) {
    throw new AppError("invalid_request", "Give the new system a name", 422);
  }
  if (name.length > HOUSEHOLD_NAME_LIMIT) {
    throw new AppError(
      "invalid_request",
      `A system name is at most ${HOUSEHOLD_NAME_LIMIT} characters`,
      422,
    );
  }
  requireUuid(input.ownerId, "User");

  const householdId = randomUUID();
  await getDb().transaction(async (transaction) => {
    const [owner] = await transaction
      .select({ id: users.id, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, input.ownerId))
      .limit(1);
    if (!owner) {
      throw new AppError("user_not_found", "That registered Orbit user is no longer available", 404);
    }
    if (owner.disabledAt) {
      throw new AppError("account_disabled", "Enable this Orbit account before making it an owner", 409);
    }

    const [recoverableName] = await transaction
      .select({ id: households.id })
      .from(households)
      .where(and(
        isNotNull(households.deletionRequestedAt),
        sql`${households.deleteAfter} > now()`,
        sql`lower(${households.name}) = lower(${name})`,
      ))
      .limit(1);
    if (recoverableName) {
      throw new AppError(
        "household_name_recoverable",
        "A removed household already uses this name. Restore it, or permanently delete it first.",
        409,
      );
    }

    await transaction.insert(households).values({ id: householdId, name, setupCompleted: true });
    await transaction.insert(memberships).values({ householdId, userId: input.ownerId, role: "owner" });
    await transaction.insert(sections).values(cloneSections().map((section, position) => {
      const sectionId = randomUUID();
      return {
        id: sectionId,
        householdId,
        slug: sectionSlug(section.name, sectionId),
        name: section.name,
        icon: section.icon,
        accent: section.accent,
        position,
        visible: section.visible,
      };
    }));
    await transaction.insert(auditLog).values({
      householdId,
      actorUserId,
      entityType: "household",
      entityId: householdId,
      action: "household_created",
      changes: { name, ownerUserId: input.ownerId, createdBy: "administrator" },
    });
  });

  return { id: householdId, name, ownerId: input.ownerId };
}
