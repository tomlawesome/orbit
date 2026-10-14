import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { and, eq } from "drizzle-orm";
import { createSession, csrfTokenForSession, readSession } from "@/lib/auth/session";
import { getAuthConfig, resetAuthConfigForTests } from "@/lib/env";
import { sessionCookieName } from "@/lib/auth/cookies";
import { requireInstanceMetadataWriter, requireMetadataWriter, requireReceiptMetadataWriter } from "@/server/metadata/fields";
import { closeDatabase, getDb } from "@/db";
import {
  auditLog,
  documents,
  externalIdentities,
  households,
  imapIngestionMessages,
  instanceAuthority,
  metadataKeys,
  items,
  memberships,
  portableArchives,
  sections,
  sessions,
  userPreferences,
  users,
} from "@/db/schema";
import { getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";

export type FixtureRole = "owner" | "member" | "outsider" | "admin" | "disabled";

const storageRoot = join(tmpdir(), `orbit-integration-documents-${randomUUID()}`);
const quarantineRoot = join(tmpdir(), `orbit-integration-quarantine-${randomUUID()}`);
process.env.DOCUMENTS_ROOT = storageRoot;
process.env.DOCUMENTS_QUARANTINE_ROOT = quarantineRoot;
process.env.DOCUMENT_KEK = "00".repeat(32);
process.env.DOCUMENT_SCAN_MODE = "disabled";
/* The settings above are read once and cached, and something else in the
   import graph may already have read them — so setting the variables is not
   enough on its own, the cache has to be dropped here too. Nothing noticed
   while the fixture had no use for the key; since #969 it creates accounts
   with encrypted addresses, so a stale "there is no key" made whole files
   fail, and which files depended on import order. */
resetDocumentConfigForTests();

/* #1405: the integration suite calls route handlers directly and never boots
   the server, so the startup key check has not run and its verdict would read
   "unknown", which every gate treats as closed. Every file here is about
   something other than the key unless it says so, so the baseline is a usable
   key; a file that is about the key sets its own verdict. Loaded tolerantly
   because the module did not exist before #1405 was built. */
await import("@/server/key-state")
  .then((module) => module.setKeyStateForTests({ verdict: "usable", heldKeyId: getDocumentConfig().keyId }))
  .catch(() => undefined);

export interface IntegrationSession {
  userId: string;
  sessionId: string;
  token: string;
  csrfToken: string;
  headers: Record<string, string>;
}

interface FixtureUser {
  id: string;
  email: string;
}

export interface IntegrationFixture {
  household: { id: string; name: string };
  secondHousehold: { id: string; name: string };
  section: { id: string };
  item: { id: string };
  document: { id: string; displayName: string };
  secondItem: { id: string };
  secondDocument: { id: string; displayName: string };
  archive: { id: string };
  users: Record<FixtureRole | "secondOwner", FixtureUser>;
  /** `idToken` is the provider's ID token for a session that began at the provider (#1316 decision 26a). */
  session(role: FixtureRole | "secondOwner", options?: { idToken?: string }): Promise<IntegrationSession>;
  expireSession(session: IntegrationSession): Promise<void>;
  removeMember(): Promise<void>;
  disableUser(role: FixtureRole): Promise<void>;
  auditCount(entityId?: string): Promise<number>;
  cleanup(): Promise<void>;
}

export function sessionHeaders(
  session: IntegrationSession,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return { ...session.headers, ...overrides };
}

export async function cleanupIntegrationEnvironment(): Promise<void> {
  resetAuthConfigForTests();
  resetDocumentConfigForTests();
  const db = getDb();
  // Fixture rows must not accumulate across the run (#593): the whole
  // integration suite shares one database with fileParallelism disabled, so
  // every createIntegrationFixture() call was leaving its users, households
  // and everything cascaded from them behind for the life of the run. This
  // must run before closeDatabase() below, and in dependency order:
  //  - instance_authority.primary_user_id is ON DELETE RESTRICT, and
  //    audit_log.actor_user_id and due_events.completed_by_user_id carry no
  //    ON DELETE rule at all, so each would block a user delete outright.
  //  - Deleting households before users clears due_events (and everything
  //    else that cascades from a household) by cascade first, so the later
  //    user delete never meets that block.
  //  - imap_ingestion_messages.user_id/household_id are ON DELETE SET NULL,
  //    so they would not block anything, but would survive as disconnected
  //    rows; delete them explicitly rather than leave that residue.
  await db.delete(instanceAuthority);
  await db.delete(auditLog);
  await db.delete(imapIngestionMessages);
  await db.delete(households);
  // mail_in_relays cascades from users, so deleting users clears it.
  await db.delete(users);
  /* The metadata keys go too (#969). A household's key leaves with its
     household, but the instance's is nobody's child and outlives the file that
     minted it — and a file that rotates or removes the encryption key leaves
     that row wrapped under a key the next file does not have, which then meets
     an instance it cannot unlock on its very first account. Nothing encrypted
     under it survives this function, so dropping it loses nothing and the next
     writer mints a fresh one. */
  await db.delete(metadataKeys);
  await closeDatabase();
  await Promise.all([
    rm(storageRoot, { recursive: true, force: true }),
    rm(quarantineRoot, { recursive: true, force: true }),
  ]);
}

/**
 * The encrypted columns an `items` row carries for the values given, written
 * exactly as the application writes them (ADR-0024, contract release: the
 * plaintext columns are no longer read). Spread into an insert.
 */
export async function encryptedItemColumns(
  householdId: string,
  itemId: string,
  values: { title?: string | null; provider?: string | null; reference?: string | null; notes?: string | null; costMinor?: number | null },
) {
  const cipher = await requireMetadataWriter(householdId);
  return {
    titleEnc: cipher.encryptText("items.title", itemId, values.title),
    providerEnc: cipher.encryptText("items.provider", itemId, values.provider),
    referenceEnc: cipher.encryptText("items.reference", itemId, values.reference),
    referenceIndex: cipher.referenceIndex(values.reference),
    notesEnc: cipher.encryptText("items.notes", itemId, values.notes),
    costMinorEnc: cipher.encryptNumber("items.cost_minor", itemId, values.costMinor),
  };
}

/** The encrypted draft columns of a mail-in receipt, under its household's key (the instance key when `householdId` is null). */
export async function encryptedReceiptDraft(
  householdId: string | null,
  receiptId: string,
  values: { proposal?: Record<string, unknown>; fieldEvidence?: Record<string, unknown> },
) {
  const cipher = await requireReceiptMetadataWriter(householdId);
  return {
    proposalEnc: values.proposal === undefined ? null : cipher.encryptJson("imap_ingestion_messages.proposal", receiptId, values.proposal),
    fieldEvidenceEnc: values.fieldEvidence === undefined ? null : cipher.encryptJson("imap_ingestion_messages.field_evidence", receiptId, values.fieldEvidence),
  };
}

export async function createIntegrationFixture(label: string): Promise<IntegrationFixture> {
  const db = getDb();
  const namespace = `${label}-${randomUUID()}`;
  const householdSuffix = randomUUID().slice(0, 8);
  const issuer = "https://oidc.invalid.example";

  /* Written encrypted, exactly as the application writes it (#969). A fixture
     that inserted plaintext would still pass every test — the dual read falls
     back to it — while proving nothing about the path real accounts take, so
     the whole integration suite would be green on the pre-release shape alone.
     A test that wants the un-backfilled shape makes it deliberately, as
     `metadata-addresses.test.ts` does. */
  async function createUser(role: string, isInstanceAdmin = false): Promise<FixtureUser> {
    const email = `${namespace}-${role}@example.invalid`;
    const userId = randomUUID();
    const cipher = await requireInstanceMetadataWriter();
    await db.insert(users).values({
      id: userId,
      email: null,
      emailEnc: cipher.encryptText("users.email", userId, email),
      emailIndex: cipher.emailIndex(email),
      emailVerified: true,
      displayName: `Integration ${role}`,
      isInstanceAdmin,
    });
    const user: FixtureUser = { id: userId, email };
    await db.insert(userPreferences).values({ userId: user.id });
    await db.insert(externalIdentities).values({
      userId: user.id,
      issuer,
      subject: `${namespace}-${role}`,
    });
    return user;
  }

  const fixtureUsers = {
    owner: await createUser("owner"),
    member: await createUser("member"),
    outsider: await createUser("outsider"),
    admin: await createUser("admin", true),
    disabled: await createUser("disabled"),
    secondOwner: await createUser("second-owner"),
  } satisfies Record<FixtureRole | "secondOwner", FixtureUser>;

  const [household] = await db.insert(households).values({
    name: `Integration ${label}-${householdSuffix}`,
    timezone: "Europe/London",
    defaultCurrency: "GBP",
    setupCompleted: true,
  }).returning({ id: households.id, name: households.name });
  const [secondHousehold] = await db.insert(households).values({
    name: `Second ${label}-${householdSuffix}`,
    timezone: "Europe/London",
    defaultCurrency: "GBP",
    setupCompleted: true,
  }).returning({ id: households.id, name: households.name });

  await db.insert(memberships).values([
    { householdId: household.id, userId: fixtureUsers.owner.id, role: "owner" },
    { householdId: household.id, userId: fixtureUsers.member.id, role: "member" },
    { householdId: secondHousehold.id, userId: fixtureUsers.secondOwner.id, role: "owner" },
  ]);

  const [section] = await db.insert(sections).values({
    householdId: household.id,
    slug: `documents-${namespace}`,
    name: "Documents",
    position: 0,
  }).returning({ id: sections.id });
  const [secondSection] = await db.insert(sections).values({
    householdId: secondHousehold.id,
    slug: `documents-second-${namespace}`,
    name: "Documents",
    position: 0,
  }).returning({ id: sections.id });

  const itemId = randomUUID();
  const [item] = await db.insert(items).values({
    id: itemId,
    householdId: household.id,
    sectionId: section.id,
    ...await encryptedItemColumns(household.id, itemId, { title: `Integration item ${namespace}` }),
    currency: "GBP",
  }).returning({ id: items.id });
  const secondItemId = randomUUID();
  const [secondItem] = await db.insert(items).values({
    id: secondItemId,
    householdId: secondHousehold.id,
    sectionId: secondSection.id,
    ...await encryptedItemColumns(secondHousehold.id, secondItemId, { title: `Second integration item ${namespace}` }),
    currency: "GBP",
  }).returning({ id: items.id });

  const displayName = "integration-document.pdf";
  const secondDisplayName = "second-integration-document.pdf";
  const [document] = await db.insert(documents).values({
    householdId: household.id,
    itemId: item.id,
    uploadedByUserId: fixtureUsers.member.id,
    displayName,
    mediaType: "application/pdf",
    sizeBytes: 128,
    contentSha256: createHash("sha256").update(namespace).digest("hex"),
    lifecycle: "available",
    scanStatus: "skipped",
    availableAt: new Date(),
  }).returning({ id: documents.id, displayName: documents.displayName });
  const [secondDocument] = await db.insert(documents).values({
    householdId: secondHousehold.id,
    itemId: secondItem.id,
    uploadedByUserId: fixtureUsers.secondOwner.id,
    displayName: secondDisplayName,
    mediaType: "application/pdf",
    sizeBytes: 128,
    contentSha256: createHash("sha256").update(`${namespace}-second`).digest("hex"),
    lifecycle: "available",
    scanStatus: "skipped",
    availableAt: new Date(),
  }).returning({ id: documents.id, displayName: documents.displayName });
  const [archive] = await db.insert(portableArchives).values({
    householdId: household.id,
    requestedByUserId: fixtureUsers.owner.id,
    storageKey: randomUUID(),
    contentSha256: createHash("sha256").update(`${namespace}-archive`).digest("hex"),
    sizeBytes: 32,
    expiresAt: new Date(Date.now() + 86_400_000),
  }).returning({ id: portableArchives.id });

  async function session(role: FixtureRole | "secondOwner", options: { idToken?: string } = {}): Promise<IntegrationSession> {
    const userId = fixtureUsers[role].id;
    const config = getAuthConfig();
    const created = await createSession(userId, config, undefined, options.idToken ? { idToken: options.idToken } : undefined);
    /* A plain literal, not a framework request (#735). `readSession` takes a
       `CookieReader`, which is one method — `src/lib/http.ts` says so in as
       many words, and the whole point of that seam is that a test does not
       have to build a request object to satisfy it. */
    const persisted = await readSession(
      { get: (name) => (name === sessionCookieName(config) ? created.token : undefined) },
      config,
    );
    if (!persisted) throw new Error(`Integration session for ${role} was not persisted`);
    const csrfToken = csrfTokenForSession(persisted, config);
    return {
      userId,
      sessionId: persisted.id,
      token: created.token,
      csrfToken,
      headers: {
        cookie: `${sessionCookieName(config)}=${created.token}`,
        origin: config.appUrl.origin,
        "sec-fetch-site": "same-origin",
        "x-csrf-token": csrfToken,
      },
    };
  }

  return {
    household,
    secondHousehold,
    section,
    item,
    document,
    secondItem,
    secondDocument,
    archive,
    users: fixtureUsers,
    session,
    async expireSession(sessionToExpire) {
      await db.update(sessions).set({ expiresAt: new Date(0) }).where(eq(sessions.id, sessionToExpire.sessionId));
    },
    async removeMember() {
      await db.delete(memberships).where(and(eq(memberships.householdId, household.id), eq(memberships.userId, fixtureUsers.member.id)));
    },
    async disableUser(role) {
      await db.update(users).set({ disabledAt: new Date(), updatedAt: new Date() }).where(eq(users.id, fixtureUsers[role].id));
    },
    async auditCount(entityId) {
      const rows = await db.select({ id: auditLog.id }).from(auditLog).where(entityId ? eq(auditLog.entityId, entityId) : eq(auditLog.householdId, household.id));
      return rows.length;
    },
    async cleanup() {
      await cleanupIntegrationEnvironment();
    },
  };
}
