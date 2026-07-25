import { and, eq, sql } from "drizzle-orm";
import { externalIdentities, userPreferences, users } from "@/db/schema";
import { getDb } from "@/db";
import type { VerifiedIdentity } from "@/lib/auth/oidc";

export interface ProvisionedUser {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * Provisions by immutable issuer/subject only. A transaction-scoped advisory
 * lock prevents concurrent first callbacks from creating duplicate users.
 */
export async function provisionIdentity(identity: VerifiedIdentity): Promise<ProvisionedUser> {
  return getDb().transaction(async (transaction) => {
    const lockKey = `${identity.issuer}\u0000${identity.subject}`;
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

    const [existing] = await transaction
      .select({
        id: users.id,
        email: users.email,
        emailVerified: users.emailVerified,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      })
      .from(externalIdentities)
      .innerJoin(users, eq(users.id, externalIdentities.userId))
      .where(and(
        eq(externalIdentities.issuer, identity.issuer),
        eq(externalIdentities.subject, identity.subject),
      ))
      .limit(1);

    if (existing) {
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

    const [created] = await transaction
      .insert(users)
      .values({
        email: identity.email,
        emailVerified: identity.emailVerified,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
      })
      .returning({
        id: users.id,
        email: users.email,
        emailVerified: users.emailVerified,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      });

    await transaction.insert(externalIdentities).values({
      userId: created.id,
      issuer: identity.issuer,
      subject: identity.subject,
    });
    await transaction.insert(userPreferences).values({ userId: created.id }).onConflictDoNothing();
    return created;
  });
}
