import { and, eq, sql } from "drizzle-orm";
import { auditLog, externalIdentities, instanceAuthority, userPreferences, users } from "@/db/schema";
import { getDb } from "@/db";
import { ACCOUNT_LIFECYCLE_LOCK_KEY } from "@/lib/auth/authority-locks";
import { AuthError } from "@/lib/auth/errors";
import type { VerifiedIdentity } from "@/lib/auth/oidc";

export interface ProvisionedUser {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  avatarUrl: string | null;
  disabledAt: Date | null;
}

/**
 * Provisions by immutable issuer/subject only. A transaction-scoped advisory
 * lock prevents concurrent first callbacks from creating duplicate users.
 */
export async function provisionIdentity(identity: VerifiedIdentity): Promise<ProvisionedUser> {
  return getDb().transaction(async (transaction) => {
    // JSON preserves the issuer/subject boundary without PostgreSQL-forbidden NUL bytes.
    const lockKey = JSON.stringify([identity.issuer, identity.subject]);
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

    const [existing] = await transaction
      .select({
        id: users.id,
        email: users.email,
        emailVerified: users.emailVerified,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        disabledAt: users.disabledAt,
      })
      .from(externalIdentities)
      .innerJoin(users, eq(users.id, externalIdentities.userId))
      .where(and(
        eq(externalIdentities.issuer, identity.issuer),
        eq(externalIdentities.subject, identity.subject),
      ))
      .limit(1);

    if (existing) {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ACCOUNT_LIFECYCLE_LOCK_KEY}, 0))`);
      const [current] = await transaction
        .select({ disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, existing.id))
        .limit(1);
      if (!current || current.disabledAt) {
        throw new AuthError("account_disabled", "This Orbit account is disabled", 403);
      }
      const [updated] = await transaction
        .update(users)
        .set({
          email: identity.email,
          emailVerified: identity.emailVerified,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl,
          updatedAt: new Date(),
        })
        .where(eq(users.id, existing.id))
        .returning({
          id: users.id,
          email: users.email,
          emailVerified: users.emailVerified,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          disabledAt: users.disabledAt,
        });
      await transaction
        .update(externalIdentities)
        .set({ lastLoginAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(externalIdentities.issuer, identity.issuer),
          eq(externalIdentities.subject, identity.subject),
        ));
      return updated;
    }

    // Serialize first-user creation across different identity providers/subjects.
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended('orbit:first-administrator', 0))`);
    const [registrationState] = await transaction
      .select({ registeredUsers: sql<number>`count(*)::int` })
      .from(users);

    const [created] = await transaction
      .insert(users)
      .values({
        email: identity.email,
        emailVerified: identity.emailVerified,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
        isInstanceAdmin: registrationState.registeredUsers === 0,
      })
      .returning({
        id: users.id,
        email: users.email,
        emailVerified: users.emailVerified,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        disabledAt: users.disabledAt,
      });

    await transaction.insert(externalIdentities).values({
      userId: created.id,
      issuer: identity.issuer,
      subject: identity.subject,
    });
    await transaction.insert(userPreferences).values({ userId: created.id }).onConflictDoNothing();

    /* The first administrator is also the instance's primary administrator
       (#263), assigned atomically under the same first-administrator lock so
       there is never an instance with administrators but no seat of final
       authority. #259's protected bootstrap replaces this entry point without
       changing the invariant. */
    if (registrationState.registeredUsers === 0) {
      await transaction.insert(instanceAuthority).values({ primaryUserId: created.id });
      await transaction.insert(auditLog).values({
        householdId: null,
        actorUserId: created.id,
        entityType: "user",
        entityId: created.id,
        action: "primary_administrator_established",
        changes: { rule: "first_registered_administrator" },
      });
    }
    return created;
  });
}
