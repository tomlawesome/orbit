import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { imapIngestionMessages, memberships, metadataKeys } from "@/db/schema";
import { findHeldDuplicates } from "@/server/document-repository";
import { assignImapReceiptHousehold, getImapReview, listImapInbox } from "@/server/mail-in/imap-inbox";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { openMetadataWriter } from "@/server/metadata/fields";
import { resetMetadataKeyCacheForTests } from "@/server/metadata/keys";
import { syntheticPdf } from "../support/synthetic-documents";
import { cleanupIntegrationEnvironment, createIntegrationFixture, damageEnvelope, encryptedReceiptDraft } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import {
  attachmentColumns, openSeal, seedAttachment, seedReceipt, sha256Of, sealFor, stubPdfinfo, type SealScope,
} from "./support/imap-attachment-hash";

/* #1778, build note D (design note 58551): the readers and the re-key.
   - "already held" in the mail-in review and inbox unseals the stored hash
     with the receipt's household reader and asks `findHeldDuplicates` only
     about the hashes that opened; a hash that will not open is "cannot
     verify", never a match; a legacy row with only the plain hash still
     matches (fallback, until the contract release #1835); matches map back
     to attachments by row id;
   - `assignImapReceiptHousehold` re-keys, in the same transaction, every
     attachment of the receipt whose seal opens under the source scope's key
     to the target household's key, bound to the attachment id; a value that
     will not open is left exactly as it is; a locked target household
     refuses the assignment 503 `metadata_locked` with nothing changed.
   Written from the note alone. */

const { POST: attachToItem } = await loadRoute("households/[householdId]/items/[itemId]/documents");

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));

/* Passed through, and watched: only hashes that opened are asked about. */
vi.mock("@/server/document-repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/document-repository")>();
  return { ...actual, findHeldDuplicates: vi.fn(actual.findHeldDuplicates) };
});

const unstubPdfinfo = stubPdfinfo();

afterAll(async () => {
  unstubPdfinfo();
  await cleanupIntegrationEnvironment();
});

afterEach(() => {
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;
interface AlreadyHeld { documentId: string; entry: { itemId: string; title: string } | null }
type Reviewed = { attachments: Array<{ id: string; alreadyHeld?: AlreadyHeld | null }> };

const pdf = (label: string) => syntheticPdf(`attachment hash review ${label}`);

async function attach(fixture: Fixture, session: Session, body: Buffer) {
  const documentId = randomUUID();
  const response = await callRouteForSession(attachToItem, session, {
    url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${fixture.item.id}/documents`,
    method: "POST",
    headers: {
      "content-length": String(body.length),
      "content-type": "application/pdf",
      "x-orbit-filename": encodeURIComponent("Service history.pdf"),
      "x-orbit-document-id": documentId,
    },
    body: new Uint8Array(body),
    params: { householdId: fixture.household.id, itemId: fixture.item.id },
  });
  expect(response.status, "the household's own copy is stored").toBe(201);
  return documentId;
}

/** A pending receipt with a draft under the scope key it is in, as a mail in review has. */
async function receipt(fixture: Fixture, householdId: string | null) {
  const receiptId = await seedReceipt({ userId: fixture.users.member.id, householdId });
  await getDb().update(imapIngestionMessages).set(await encryptedReceiptDraft(householdId, receiptId, { proposal: { title: "Your MOT certificate" } }))
    .where(eq(imapIngestionMessages.id, receiptId));
  return receiptId;
}

async function reviewOf(fixture: Fixture, receiptId: string, householdId = fixture.household.id): Promise<Reviewed> {
  return await getImapReview(fixture.users.member.id, receiptId, householdId) as unknown as Reviewed;
}

const markOf = (review: Reviewed, id: string) => review.attachments.find((one) => one.id === id)?.alreadyHeld ?? null;
const household = (fixture: Fixture, which: "first" | "second" = "first"): SealScope => ({ household: which === "first" ? fixture.household.id : fixture.secondHousehold.id });

async function receiptRow(receiptId: string) {
  const [row] = await getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
  return row!;
}

/** Makes `scopeHouseholdId`'s key fail to open, runs `work`, and puts the key back. */
async function withLockedHousehold<T>(householdId: string, work: () => Promise<T>): Promise<T> {
  await openMetadataWriter(householdId);
  const [key] = await getDb().select({ wrapAuthTag: metadataKeys.wrapAuthTag }).from(metadataKeys)
    .where(and(eq(metadataKeys.scope, "household"), eq(metadataKeys.householdId, householdId)));
  expect(key, "the household's key exists").toBeTruthy();
  try {
    await getDb().execute(sql`update metadata_keys set wrap_auth_tag = ${randomBytes(16).toString("base64")} where scope = 'household' and household_id = ${householdId}`);
    resetMetadataKeyCacheForTests();
    return await work();
  } finally {
    await getDb().update(metadataKeys).set({ wrapAuthTag: key.wrapAuthTag })
      .where(and(eq(metadataKeys.scope, "household"), eq(metadataKeys.householdId, householdId)));
    resetMetadataKeyCacheForTests();
  }
}

describe("'already held' reads the sealed attachment hash (#1778)", () => {
  it("marks the matching attachment and only that one, from the sealed value, with the plain column NULL and no digest in the answer", async () => {
    const fixture = await createIntegrationFixture("attach-hash-held-sealed");
    const member = await fixture.session("member");
    const held = pdf("held");
    const fresh = pdf("fresh");
    const documentId = await attach(fixture, member, held);
    const receiptId = await receipt(fixture, fixture.household.id);
    const fresher = await seedAttachment(receiptId, { sha256: sha256Of(fresh), sealedUnder: household(fixture) });
    const matching = await seedAttachment(receiptId, { sha256: sha256Of(held), sealedUnder: household(fixture) });
    expect((await attachmentColumns(matching)).plain, "the seed has no plain hash").toBeNull();

    const review = await reviewOf(fixture, receiptId);
    expect(markOf(review, fresher)).toBeNull();
    expect(markOf(review, matching)).toMatchObject({ documentId });
    expect(JSON.stringify(review)).not.toContain(sha256Of(held));
  });

  it("the inbox list marks it too, with one lookup per receipt asked only about the hashes that opened", async () => {
    const fixture = await createIntegrationFixture("attach-hash-held-list");
    const member = await fixture.session("member");
    const heldA = pdf("list held a");
    const fresh = pdf("list fresh");
    const documentId = await attach(fixture, member, heldA);
    const receiptId = await receipt(fixture, fixture.household.id);
    const a = await seedAttachment(receiptId, { sha256: sha256Of(heldA), sealedUnder: household(fixture) });
    const b = await seedAttachment(receiptId, { sha256: sha256Of(fresh), sealedUnder: household(fixture) });

    vi.mocked(findHeldDuplicates).mockClear();
    const inbox = await listImapInbox(member.userId);
    const listed = inbox.receipts.find((one) => one.id === receiptId) as unknown as Reviewed;
    expect(listed, "the receipt is in the reader's inbox").toBeTruthy();
    expect(markOf(listed, a)).toMatchObject({ documentId });
    expect(markOf(listed, b)).toBeNull();
    const asked = vi.mocked(findHeldDuplicates).mock.calls.filter(([, shas]) => shas.includes(sha256Of(heldA)));
    expect(asked).toHaveLength(1);
    expect([...asked[0][1]].sort()).toEqual([sha256Of(heldA), sha256Of(fresh)].sort());
    expect(JSON.stringify(inbox)).not.toContain(sha256Of(heldA));
  });

  it("a legacy row with only the plain hash still matches (fallback until the contract release)", async () => {
    const fixture = await createIntegrationFixture("attach-hash-held-plain");
    const member = await fixture.session("member");
    const held = pdf("legacy plain");
    const documentId = await attach(fixture, member, held);
    const receiptId = await receipt(fixture, fixture.household.id);
    const legacy = await seedAttachment(receiptId, { sha256: sha256Of(held), plain: true });
    const review = await reviewOf(fixture, receiptId);
    expect(markOf(review, legacy)).toMatchObject({ documentId });
  });

  it("matches back by row id, not by hash: a sealed row and a plain row of the same bytes are both marked", async () => {
    const fixture = await createIntegrationFixture("attach-hash-held-by-id");
    const member = await fixture.session("member");
    const held = pdf("by row id");
    const documentId = await attach(fixture, member, held);
    const receiptId = await receipt(fixture, fixture.household.id);
    const sealed = await seedAttachment(receiptId, { sha256: sha256Of(held), sealedUnder: household(fixture) });
    const plain = await seedAttachment(receiptId, { sha256: sha256Of(held), plain: true });
    const review = await reviewOf(fixture, receiptId);
    expect(markOf(review, sealed)).toMatchObject({ documentId });
    expect(markOf(review, plain)).toMatchObject({ documentId });
  });

  it("does not mark an attachment whose bytes only another household holds", async () => {
    const fixture = await createIntegrationFixture("attach-hash-held-cross");
    const owner = await fixture.session("owner");
    const bytes = pdf("held elsewhere");
    await attach(fixture, owner, bytes);
    await getDb().insert(memberships).values({ householdId: fixture.secondHousehold.id, userId: fixture.users.member.id, role: "member" }).onConflictDoNothing();
    const receiptId = await receipt(fixture, fixture.secondHousehold.id);
    const one = await seedAttachment(receiptId, { sha256: sha256Of(bytes), sealedUnder: household(fixture, "second") });
    expect(markOf(await reviewOf(fixture, receiptId, fixture.secondHousehold.id), one)).toBeNull();
  });

  it("a seal that will not open is 'cannot verify', never a match, and its digest is not asked about: damaged, moved to another row, sealed under another household's key", async () => {
    const fixture = await createIntegrationFixture("attach-hash-held-unopenable");
    const member = await fixture.session("member");
    /* Three different held files (one mail cannot hold the same bytes twice), one per way a seal can fail to open. */
    const files = [pdf("unopenable damaged"), pdf("unopenable moved"), pdf("unopenable foreign")];
    for (const bytes of files) await attach(fixture, member, bytes);
    const receiptId = await receipt(fixture, fixture.household.id);
    const ids: string[] = [];
    for (const bytes of files) ids.push(await seedAttachment(receiptId, { sha256: sha256Of(bytes), sealedUnder: household(fixture) }));
    const [damaged, moved, foreign] = ids;
    const sealedColumn = (id: string, value: string) => getDb().execute(sql`update imap_ingestion_attachments set content_sha256_sealed = ${value} where id = ${id}`);
    await sealedColumn(damaged, damageEnvelope((await attachmentColumns(damaged)).sealed!));
    await sealedColumn(moved, await sealFor(household(fixture), randomUUID(), sha256Of(files[1])));
    await sealedColumn(foreign, await sealFor(household(fixture, "second"), foreign, sha256Of(files[2])));

    vi.mocked(findHeldDuplicates).mockClear();
    const review = await reviewOf(fixture, receiptId);
    for (const id of ids) expect(markOf(review, id), "cannot verify is not a match").toBeNull();
    const asked = vi.mocked(findHeldDuplicates).mock.calls.flatMap(([, shas]) => [...shas]);
    for (const bytes of files) expect(asked, "a hash that did not open is never looked up").not.toContain(sha256Of(bytes));
  });

  it("an unreadable seal on one attachment does not stop the others being marked", async () => {
    const fixture = await createIntegrationFixture("attach-hash-held-one-bad");
    const member = await fixture.session("member");
    const bad = pdf("one bad");
    const good = pdf("one good");
    await attach(fixture, member, bad);
    const goodDocument = await attach(fixture, member, good);
    const receiptId = await receipt(fixture, fixture.household.id);
    const damaged = await seedAttachment(receiptId, { sha256: sha256Of(bad), sealedUnder: household(fixture) });
    const fine = await seedAttachment(receiptId, { sha256: sha256Of(good), sealedUnder: household(fixture) });
    await getDb().execute(sql`update imap_ingestion_attachments set content_sha256_sealed = ${damageEnvelope((await attachmentColumns(damaged)).sealed!)} where id = ${damaged}`);
    const review = await reviewOf(fixture, receiptId);
    expect(markOf(review, damaged)).toBeNull();
    expect(markOf(review, fine)).toMatchObject({ documentId: goodDocument });
  });
});

describe("attributing a receipt re-keys its attachment hashes in the same transaction (#1778)", () => {
  it("instance key to the household: the seal opens under the household, no longer under the instance, bound to the same row, and the review then marks the held attachment", async () => {
    const fixture = await createIntegrationFixture("attach-hash-assign");
    const member = await fixture.session("member");
    const held = pdf("assign held");
    const fresh = pdf("assign fresh");
    const documentId = await attach(fixture, member, held);
    const receiptId = await receipt(fixture, null);
    const matching = await seedAttachment(receiptId, { sha256: sha256Of(held), sealedUnder: "instance" });
    const other = await seedAttachment(receiptId, { sha256: sha256Of(fresh), sealedUnder: "instance" });
    const before = await attachmentColumns(matching);
    expect(await openSeal("instance", matching, before.sealed)).toEqual({ ok: true, sha256: sha256Of(held) });

    await assignImapReceiptHousehold(member.userId, receiptId, fixture.household.id);

    const after = await attachmentColumns(matching);
    expect(after.sealed, "a fresh envelope under a different key").not.toBe(before.sealed);
    expect(await openSeal(household(fixture), matching, after.sealed)).toEqual({ ok: true, sha256: sha256Of(held) });
    expect((await openSeal("instance", matching, after.sealed)).ok).toBe(false);
    expect((await openSeal(household(fixture), other, (await attachmentColumns(other)).sealed)).ok, "every attachment of the receipt moved").toBe(true);
    expect(after.contentIndex, "the dedupe index is keyed to the instance and never re-keyed").toBe(before.contentIndex);
    expect(after.plain).toBeNull();

    const review = await reviewOf(fixture, receiptId);
    expect(markOf(review, matching)).toMatchObject({ documentId });
    expect(markOf(review, other)).toBeNull();
  });

  it("a receipt with attachments but no draft is re-keyed as well", async () => {
    const fixture = await createIntegrationFixture("attach-hash-assign-no-draft");
    const member = await fixture.session("member");
    const receiptId = await seedReceipt({ userId: member.userId, householdId: null });
    const only = await seedAttachment(receiptId, { sha256: sha256Of(pdf("no draft")), sealedUnder: "instance" });
    await assignImapReceiptHousehold(member.userId, receiptId, fixture.household.id);
    expect((await openSeal(household(fixture), only, (await attachmentColumns(only)).sealed)).ok).toBe(true);
  });

  it("moving the receipt to a second household re-keys again, and the first household's reader no longer opens it", async () => {
    const fixture = await createIntegrationFixture("attach-hash-assign-move");
    const member = await fixture.session("member");
    await getDb().insert(memberships).values({ householdId: fixture.secondHousehold.id, userId: member.userId, role: "member" }).onConflictDoNothing();
    const bytes = pdf("assign move");
    const receiptId = await receipt(fixture, null);
    const one = await seedAttachment(receiptId, { sha256: sha256Of(bytes), sealedUnder: "instance" });

    await assignImapReceiptHousehold(member.userId, receiptId, fixture.household.id);
    expect((await openSeal(household(fixture), one, (await attachmentColumns(one)).sealed)).ok).toBe(true);
    await assignImapReceiptHousehold(member.userId, receiptId, fixture.secondHousehold.id);

    const moved = await attachmentColumns(one);
    expect(await openSeal(household(fixture, "second"), one, moved.sealed)).toEqual({ ok: true, sha256: sha256Of(bytes) });
    expect((await openSeal(household(fixture), one, moved.sealed)).ok, "the first household's key no longer opens it").toBe(false);
    expect((await openSeal("instance", one, moved.sealed)).ok).toBe(false);
  });

  it("a damaged seal is left exactly as it is, never a match, and the receipt still assigns; its neighbours are re-keyed", async () => {
    const fixture = await createIntegrationFixture("attach-hash-assign-damaged");
    const member = await fixture.session("member");
    const bytes = pdf("assign damaged");
    await attach(fixture, member, bytes);
    const receiptId = await receipt(fixture, null);
    const bad = await seedAttachment(receiptId, { sha256: sha256Of(bytes), sealedUnder: "instance" });
    const good = await seedAttachment(receiptId, { sha256: sha256Of(pdf("assign damaged neighbour")), sealedUnder: "instance" });
    const damagedValue = damageEnvelope((await attachmentColumns(bad)).sealed!);
    await getDb().execute(sql`update imap_ingestion_attachments set content_sha256_sealed = ${damagedValue} where id = ${bad}`);

    await assignImapReceiptHousehold(member.userId, receiptId, fixture.household.id);

    expect((await receiptRow(receiptId)).householdId, "the receipt assigned").toBe(fixture.household.id);
    expect((await attachmentColumns(bad)).sealed, "the damaged value is left as it was").toBe(damagedValue);
    expect((await openSeal(household(fixture), good, (await attachmentColumns(good)).sealed)).ok).toBe(true);
    expect(markOf(await reviewOf(fixture, receiptId), bad), "cannot verify is not a match").toBeNull();
  });

  it("a locked target household refuses the assignment 503 metadata_locked, and nothing changes", async () => {
    const fixture = await createIntegrationFixture("attach-hash-assign-locked");
    const member = await fixture.session("member");
    const receiptId = await receipt(fixture, null);
    const one = await seedAttachment(receiptId, { sha256: sha256Of(pdf("assign locked")), sealedUnder: "instance" });
    const receiptBefore = await receiptRow(receiptId);
    const attachmentBefore = await attachmentColumns(one);

    await withLockedHousehold(fixture.household.id, async () => {
      await expect(assignImapReceiptHousehold(member.userId, receiptId, fixture.household.id))
        .rejects.toMatchObject({ code: "metadata_locked", status: 503 });
    });

    expect(await receiptRow(receiptId)).toEqual(receiptBefore);
    expect(await attachmentColumns(one)).toEqual(attachmentBefore);
    expect((await receiptRow(receiptId)).householdId).toBeNull();
  });

  it("a legacy plain-only attachment passes through an assignment untouched, and still matches afterwards", async () => {
    const fixture = await createIntegrationFixture("attach-hash-assign-plain");
    const member = await fixture.session("member");
    const bytes = pdf("assign plain");
    const documentId = await attach(fixture, member, bytes);
    const receiptId = await receipt(fixture, null);
    const legacy = await seedAttachment(receiptId, { sha256: sha256Of(bytes), plain: true });
    const before = await attachmentColumns(legacy);

    await assignImapReceiptHousehold(member.userId, receiptId, fixture.household.id);

    expect(await attachmentColumns(legacy), "only the backfill converts a plain row").toEqual(before);
    expect(markOf(await reviewOf(fixture, receiptId), legacy)).toMatchObject({ documentId });
  });
});
