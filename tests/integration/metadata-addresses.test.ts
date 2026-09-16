/**
 * Account addresses behind the key (#969, slice 2 of #966, ADR-0024).
 *
 * `users.email` and `mail_in_sender_addresses.address` are the two remaining
 * readable copies of a person's address. They add no key and no cipher — both
 * ride the INSTANCE DEK — so what is worth proving is not the envelope again
 * but the things that could regress silently:
 *
 *  - the plaintext is genuinely gone from the row, and sign-in still finds the
 *    account, which now happens through a blind index rather than `lower()`;
 *  - a KEK rotation covers both new columns (ADR-0017's contract, the #955
 *    failure, checked rather than assumed);
 *  - and the behaviour when the key is missing, which is the whole reason
 *    slice 3 (#970) exists: an operator must be able to tell "this instance
 *    cannot read any address" from "your password is wrong", and an identity
 *    provider's users must still get in, because that path never touched the
 *    address in the first place.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { eq, isNotNull } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, externalIdentities, instanceAuthority, localCredentials, mailInSenderAddresses, metadataKeys, users } from "@/db/schema";
import { AuthError } from "@/lib/auth/errors";
import { provisionIdentity } from "@/lib/auth/provision";
import type { VerifiedIdentity } from "@/lib/auth/oidc";
import { hashPassword } from "@/lib/auth/password";
import { deriveDocumentKeyId, getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { rotationComplete, runKekRotationToCompletion, type RotationKeys } from "@/server/documents/rewrap-worker";
import { createLocalUser, verifyCredential } from "@/server/local-credentials";
import { backfillComplete, runMetadataBackfillBatch } from "@/server/metadata/backfill";
import { isMetadataEnvelope } from "@/server/metadata/crypto";
import { openInstanceMetadataReader } from "@/server/metadata/fields";
import { resetMetadataKeyCacheForTests } from "@/server/metadata/keys";
import { userForVerifiedSender } from "@/server/mail-in/sender-addresses";
import { cleanupIntegrationEnvironment } from "./support/fixtures";

const PASSWORD = "a-correct-local-password";

/* The suite shares one database, so each journey hands the next an empty one. */
/* Order matters: instance_authority.primary_user_id is ON DELETE RESTRICT and
   audit_log.actor_user_id carries no rule at all, so either would block the
   user delete. Several journeys here claim the instance, so the claim has to
   go too, or the next one is told the instance is already claimed. */
afterEach(async () => {
  const db = getDb();
  await db.delete(instanceAuthority);
  await db.delete(auditLog);
  await db.delete(mailInSenderAddresses);
  await db.delete(localCredentials);
  await db.delete(externalIdentities);
  await db.delete(users);
  resetMetadataKeyCacheForTests();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/** Takes the key away, exactly as an instance that has lost its KEK file has. */
function lockTheInstance(): () => void {
  const original = process.env.DOCUMENT_KEK;
  delete process.env.DOCUMENT_KEK;
  resetDocumentConfigForTests();
  resetMetadataKeyCacheForTests();
  return () => {
    if (original === undefined) delete process.env.DOCUMENT_KEK;
    else process.env.DOCUMENT_KEK = original;
    resetDocumentConfigForTests();
    resetMetadataKeyCacheForTests();
  };
}

async function storedUser(id: string) {
  const [row] = await getDb()
    .select({ email: users.email, emailEnc: users.emailEnc, emailIndex: users.emailIndex })
    .from(users).where(eq(users.id, id));
  return row;
}

function identityFor(email: string): VerifiedIdentity {
  return {
    issuer: "https://oidc.invalid.example",
    subject: `subject-${randomUUID()}`,
    email,
    emailVerified: true,
    displayName: "Provisioned person",
    avatarUrl: null,
  };
}

describe("an account address is written and read encrypted (#969)", () => {
  it("leaves no readable address in the row, and still signs the account in by address", async () => {
    const address = "encrypted-local@example.invalid";
    const created = await createLocalUser(
      { email: address, displayName: "Local person", passwordHash: await hashPassword(PASSWORD) },
      { bootstrap: true },
    );

    const stored = await storedUser(created.id);
    expect(stored.email).toBeNull();
    expect(isMetadataEnvelope(stored.emailEnc!)).toBe(true);
    expect(stored.emailEnc).not.toContain(address);
    expect(stored.emailIndex).not.toBeNull();
    // The index is a keyed digest, not the address in another coat.
    expect(stored.emailIndex).not.toContain("encrypted-local");

    // The lookup that used to be `lower(email) = lower($1)`.
    const verdict = await verifyCredential(address, PASSWORD);
    expect(verdict).toEqual({ outcome: "verified", userId: created.id });

    // Case still does not matter, which is what the old unique index promised.
    expect((await verifyCredential("ENCRYPTED-LOCAL@Example.Invalid", PASSWORD)).outcome).toBe("verified");

    const reader = await openInstanceMetadataReader();
    expect(reader.text("users.email", created.id, { encrypted: stored.emailEnc, plaintext: stored.email }).value)
      .toBe(address);
  });

  it("refuses a second account on the same address, through the blind index", async () => {
    const address = "taken@example.invalid";
    await createLocalUser(
      { email: address, displayName: "First", passwordHash: await hashPassword(PASSWORD) },
      { bootstrap: true },
    );
    await expect(createLocalUser({ email: address, displayName: "Second" }, { createdByUserId: undefined }))
      .rejects.toMatchObject({ code: "link_required" });
  });

  it("encrypts the address an identity provider supplies", async () => {
    const address = "encrypted-oidc@example.invalid";
    const provisioned = await provisionIdentity(identityFor(address), { bootstrap: true });
    expect(provisioned.email).toBe(address);

    const stored = await storedUser(provisioned.id);
    expect(stored.email).toBeNull();
    expect(isMetadataEnvelope(stored.emailEnc!)).toBe(true);
  });
});

describe("the backfill converts addresses written before the release (#969)", () => {
  it("encrypts a plaintext account and sender address, clears both, and keeps sign-in working", async () => {
    const address = "pre-release@example.invalid";
    const senderAddress = "pre-release-sender@example.invalid";

    /* The state migration 0044 leaves behind: plaintext present, ciphertext
       absent. Written straight to the table, because no application path
       produces it any more. */
    const userId = randomUUID();
    await getDb().insert(users).values({
      id: userId, email: address, emailVerified: true, displayName: "Pre-release person",
    });
    await getDb().insert(mailInSenderAddresses).values({
      userId, address: senderAddress, source: "manual", verifiedAt: new Date(),
    });
    await getDb().insert(localCredentials).values({ userId, passwordHash: await hashPassword(PASSWORD) });

    expect((await verifyCredential(address, PASSWORD)).outcome).toBe("verified");
    expect(await userForVerifiedSender(senderAddress)).toBe(userId);

    const batch = await runMetadataBackfillBatch();
    expect(batch.users).toBe(1);
    expect(batch.senderAddresses).toBe(1);

    const stored = await storedUser(userId);
    expect(stored.email).toBeNull();
    expect(isMetadataEnvelope(stored.emailEnc!)).toBe(true);
    const [sender] = await getDb()
      .select({ address: mailInSenderAddresses.address, addressEnc: mailInSenderAddresses.addressEnc })
      .from(mailInSenderAddresses).where(eq(mailInSenderAddresses.userId, userId));
    expect(sender.address).toBeNull();
    expect(isMetadataEnvelope(sender.addressEnc!)).toBe(true);

    // The point of the whole slice: the same two lookups still answer.
    expect((await verifyCredential(address, PASSWORD)).outcome).toBe("verified");
    expect(await userForVerifiedSender(senderAddress)).toBe(userId);
  });
});

describe("no readable address survives anywhere (#969, the #966 failure)", () => {
  it("finds no plaintext address in any address-bearing column after the backfill drains", async () => {
    const address = "sweep@example.invalid";
    const created = await createLocalUser(
      { email: address, displayName: "Swept", passwordHash: await hashPassword(PASSWORD) },
      { bootstrap: true },
    );
    await getDb().insert(mailInSenderAddresses).values({
      userId: created.id, address: "sweep-sender@example.invalid", source: "manual",
    });
    while (!backfillComplete(await runMetadataBackfillBatch())) { /* drain */ }

    /* Asserted over the stored shapes rather than by inspection: any row still
       holding a readable address fails this, including one a future column
       introduces and forgets to encrypt. */
    const leftovers = await getDb().select({ id: users.id }).from(users).where(isNotNull(users.email));
    expect(leftovers).toEqual([]);
    const senderLeftovers = await getDb().select({ id: mailInSenderAddresses.id })
      .from(mailInSenderAddresses).where(isNotNull(mailInSenderAddresses.address));
    expect(senderLeftovers).toEqual([]);
  });
});

describe("an instance with no usable key (#969, and why #970 exists)", () => {
  it("refuses local sign-in as locked, never as a wrong password", async () => {
    const address = "locked-out@example.invalid";
    await createLocalUser(
      { email: address, displayName: "Locked out", passwordHash: await hashPassword(PASSWORD) },
      { bootstrap: true },
    );

    const restore = lockTheInstance();
    try {
      const verdict = await verifyCredential(address, PASSWORD);
      /* The distinction the operator's whole recovery depends on: not
         `rejected`, which is what a wrong password gets. */
      expect(verdict.outcome).toBe("locked");
      expect((await verifyCredential(address, "the-wrong-password")).outcome).toBe("locked");
    } finally {
      restore();
    }
  });

  it("still signs an identity the provider already knows in, because that never touched the address", async () => {
    const identity = identityFor("oidc-survivor@example.invalid");
    const provisioned = await provisionIdentity(identity, { bootstrap: true });

    const restore = lockTheInstance();
    try {
      /* The regression #969 names explicitly. `external_identities` matches on
         issuer and subject, so a missing key must not shut these people out. */
      const again = await provisionIdentity(identity);
      expect(again.id).toBe(provisioned.id);
      // The address cannot be read, and is reported as unreadable rather than blank.
      expect(again.email).toBeNull();

      // And the stored ciphertext was not touched by a sign-in that could not read it.
      const stored = await storedUser(provisioned.id);
      expect(stored.emailEnc).not.toBeNull();
      expect(stored.email).toBeNull();
    } finally {
      restore();
    }
  });

  it("refuses to create an account, in its own words", async () => {
    const restore = lockTheInstance();
    try {
      const attempt = createLocalUser(
        { email: "never-created@example.invalid", displayName: "Never", passwordHash: await hashPassword(PASSWORD) },
        { bootstrap: true },
      );
      await expect(attempt).rejects.toBeInstanceOf(AuthError);
      await expect(attempt).rejects.toMatchObject({ code: "instance_locked" });
    } finally {
      restore();
    }
  });
});

describe("a KEK rotation covers the address rows (#969, ADR-0017's contract)", () => {
  it("re-reads both addresses after a full rotation, with no value rewritten", async () => {
    const address = "rotated@example.invalid";
    const senderAddress = "rotated-sender@example.invalid";
    const created = await createLocalUser(
      { email: address, displayName: "Rotated", passwordHash: await hashPassword(PASSWORD) },
      { bootstrap: true },
    );
    const writer = await openInstanceMetadataReader();
    const senderId = randomUUID();
    await getDb().insert(mailInSenderAddresses).values({
      id: senderId,
      userId: created.id,
      address: null,
      addressEnc: writer.encryptText("mail_in_sender_addresses.address", senderId, senderAddress),
      addressIndex: writer.senderAddressIndex(senderAddress),
      source: "manual",
      verifiedAt: new Date(),
    });

    const before = await storedUser(created.id);
    const [beforeKey] = await getDb().select().from(metadataKeys).where(eq(metadataKeys.scope, "instance"));

    const current = getDocumentConfig();
    const originalKek = process.env.DOCUMENT_KEK;
    const nextKek = randomBytes(32);
    const nextHex = nextKek.toString("hex");
    const keys: RotationKeys = {
      currentKek: current.keyEncryptionKey,
      currentKeyId: current.keyId,
      nextKek,
      nextKeyId: deriveDocumentKeyId(nextKek),
    };

    try {
      process.env.DOCUMENT_KEK_NEXT = nextHex;
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();
      expect(rotationComplete(await runKekRotationToCompletion(keys))).toBe(true);

      // The old KEK is gone: the moment a rotation that skipped these rows shows it.
      process.env.DOCUMENT_KEK = nextHex;
      delete process.env.DOCUMENT_KEK_NEXT;
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();
      expect(getDocumentConfig().keyId).toBe(keys.nextKeyId);

      expect((await verifyCredential(address, PASSWORD)).outcome).toBe("verified");
      expect(await userForVerifiedSender(senderAddress)).toBe(created.id);

      // Only the wrapping moved: no value rewritten, no index rebuilt
      // (ADR-0024 decision 4), which is what keeps rotation O(keys).
      expect(await storedUser(created.id)).toEqual(before);
      const [afterKey] = await getDb().select().from(metadataKeys).where(eq(metadataKeys.scope, "instance"));
      expect(afterKey.keyId).toBe(keys.nextKeyId);
      expect(afterKey.wrappedDek).not.toBe(beforeKey.wrappedDek);
    } finally {
      if (originalKek === undefined) delete process.env.DOCUMENT_KEK;
      else process.env.DOCUMENT_KEK = originalKek;
      delete process.env.DOCUMENT_KEK_NEXT;
      /* The instance key is the whole instance's, and this suite shares one
         database — so a rotated key row left behind is wrapped under a key
         nothing has any more, and every later file's first account write meets
         an instance it cannot unlock. Household keys do not have this problem
         because their households are deleted with them. Dropped rather than
         restored: the next writer mints a fresh one under the real key. */
      await getDb().delete(metadataKeys);
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();
    }
  }, 120_000);
});
