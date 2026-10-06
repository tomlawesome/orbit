/**
 * The last-resort address reset (#970, slice 3 of #966).
 *
 * Three properties, and the last one is the reason this file exists rather
 * than a couple of unit tests:
 *
 *  - it refuses while the encryption key still works, because the likelier
 *    failure is an operator panicking and destroying addresses that were
 *    perfectly recoverable;
 *  - it clears only what cannot be read, leaving accounts standing and leaving
 *    alone any address the instance can still see;
 *  - and nothing network-reachable can invoke it, asserted over the route
 *    table rather than trusted to intention. An API route here would turn a
 *    last resort into a one-request wipe of every account's identity.
 */
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, instanceAuthority, localCredentials, mailInSenderAddresses, metadataKeys, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { resetDocumentConfigForTests } from "@/server/documents/config";
import { clearUnreadableAddresses, encryptionKeyIsUsable } from "@/server/account-addresses-reset";
import { createLocalUser, verifyCredential } from "@/server/local-credentials";
import { requireInstanceMetadataWriter } from "@/server/metadata/fields";
import { resetMetadataKeyCacheForTests } from "@/server/metadata/keys";
import { cleanupIntegrationEnvironment } from "./support/fixtures";

const PASSWORD = "a-correct-local-password";

afterEach(async () => {
  const db = getDb();
  await db.delete(instanceAuthority);
  await db.delete(auditLog);
  await db.delete(mailInSenderAddresses);
  await db.delete(localCredentials);
  await db.delete(users);
  await db.delete(metadataKeys);
  resetMetadataKeyCacheForTests();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/** Takes the key away, exactly as an instance that has lost its key file has. */
function loseTheKey(): () => void {
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

async function seedEncryptedAccount(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID()}@example.invalid`;
  const created = await createLocalUser(
    { email, displayName: `The ${label}`, passwordHash: await hashPassword(PASSWORD) },
    { bootstrap: label === "administrator" },
  );
  const cipher = await requireInstanceMetadataWriter();
  const senderId = randomUUID();
  await getDb().insert(mailInSenderAddresses).values({
    id: senderId,
    userId: created.id,
    address: null,
    addressEnc: cipher.encryptText("mail_in_sender_addresses.address", senderId, email),
    addressIndex: cipher.senderAddressIndex(email),
    source: "manual",
    verifiedAt: new Date(),
  });
  return { id: created.id, email };
}

describe("it refuses while the key still works (#970)", () => {
  it("reports the key as usable, so the command stops before touching anything", async () => {
    await seedEncryptedAccount("administrator");
    expect(await encryptionKeyIsUsable()).toBe(true);
  });

  it("reports the key as unusable once it is gone", async () => {
    await seedEncryptedAccount("administrator");
    const restore = loseTheKey();
    try {
      expect(await encryptionKeyIsUsable()).toBe(false);
    } finally {
      restore();
    }
  });
});

describe("it clears only what cannot be read (#970)", () => {
  it("frees the accounts, removes the unreadable sending addresses, and leaves a readable address alone", async () => {
    const administrator = await seedEncryptedAccount("administrator");

    /* An account the backfill never reached: its address is still readable, so
       it can be signed into perfectly well and must survive untouched. Taking
       it away would destroy the very access this command exists to restore. */
    const plaintextId = randomUUID();
    const plaintextEmail = `not-backfilled-${randomUUID()}@example.invalid`;
    await getDb().insert(users).values({
      id: plaintextId, email: plaintextEmail, emailVerified: true, displayName: "Pre-release person",
    });
    await getDb().insert(localCredentials).values({
      userId: plaintextId, passwordHash: await hashPassword(PASSWORD),
    });

    const restore = loseTheKey();
    let outcome;
    try {
      outcome = await clearUnreadableAddresses();
    } finally {
      restore();
    }

    expect(outcome).toEqual({ users: 1, senderAddresses: 1 });

    // The account survives; only its address went.
    const [cleared] = await getDb()
      .select({ email: users.email, emailEnc: users.emailEnc, emailIndex: users.emailIndex })
      .from(users).where(eq(users.id, administrator.id));
    expect(cleared).toEqual({ email: null, emailEnc: null, emailIndex: null });

    // Its sending address is gone outright: the row was nothing but an address.
    expect(await getDb().select().from(mailInSenderAddresses)
      .where(eq(mailInSenderAddresses.userId, administrator.id))).toEqual([]);

    // And the readable account is untouched, and still signs in.
    const [untouched] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, plaintextId));
    expect(untouched.email).toBe(plaintextEmail);
    expect((await verifyCredential(plaintextEmail, PASSWORD)).outcome).toBe("verified");
  });

  it("records that it ran, with counts and no address in the record", async () => {
    const administrator = await seedEncryptedAccount("administrator");
    const restore = loseTheKey();
    try {
      await clearUnreadableAddresses();
    } finally {
      restore();
    }

    const [record] = await getDb()
      .select({ action: auditLog.action, changes: auditLog.changes, actorUserId: auditLog.actorUserId })
      .from(auditLog).where(eq(auditLog.action, "account_addresses_cleared"));
    expect(record.changes).toEqual({ users: 1, senderAddresses: 1 });
    /* No actor: it runs from the host shell, and the whole situation is that
       nobody can sign in. And no address — they could not be read, so there is
       nothing truthful to write down, and a record of this event is exactly
       where a leftover copy would be most embarrassing. */
    expect(record.actorUserId).toBeNull();
    expect(JSON.stringify(record)).not.toContain(administrator.email);
  });

  it("is idempotent: a second run finds nothing left to clear", async () => {
    await seedEncryptedAccount("administrator");
    const restore = loseTheKey();
    try {
      expect((await clearUnreadableAddresses()).users).toBe(1);
      expect(await clearUnreadableAddresses()).toEqual({ users: 0, senderAddresses: 0 });
    } finally {
      restore();
    }
  });
});

describe("nothing network-reachable can invoke it (#970)", () => {
  it("is named by no route in the whole route table", async () => {
    const routeRoot = fileURLToPath(new URL("../../web/src/routes", import.meta.url));

    async function serverFiles(directory: string): Promise<string[]> {
      const entries = await readdir(directory, { withFileTypes: true });
      const found: string[] = [];
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...await serverFiles(path));
        // Everything a request can reach: API handlers and the server halves
        // of pages and layouts alike.
        else if (/^\+(server|page\.server|layout\.server)\.(js|ts)$/u.test(entry.name)) found.push(path);
      }
      return found;
    }

    const files = await serverFiles(routeRoot);
    // A guard that found nothing would pass for the wrong reason.
    expect(files.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (source.includes("account-addresses-reset") || source.includes("clearUnreadableAddresses")) {
        offenders.push(file.slice(routeRoot.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
