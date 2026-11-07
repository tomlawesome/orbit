import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documents, imapIngestionAttachments, imapIngestionMessages, items } from "@/db/schema";
import { deriveDocumentKeyId, getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { runKekRotationToCompletion, type RotationKeys } from "@/server/documents/rewrap-worker";
import { resetMetadataKeyCacheForTests } from "@/server/metadata/keys";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { getImapReview } from "@/server/mail-in/imap-inbox";
import { cleanupIntegrationEnvironment, createIntegrationFixture, encryptedItemColumns, encryptedReceiptDraft } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { syntheticPdf } from "../support/synthetic-documents";

/* #1437: tell a household when it uploads a document it already holds.
   Specification: the issue and the detection note (2026-11-07, "security and
   architecture call"), which says what the server must do:

   - `documents.content_index` is a per-household keyed blind index of the
     file's SHA-256 (not the plain hash), set when the row is created;
   - a lookup is scoped to the household, takes the earliest match, and only
     counts documents that are available and bound to an item;
   - the upload answer carries `document.alreadyHeld`
     `{ documentId, displayName, addedAt, entry: { itemId, title } | null }`
     on a row's first successful store, never on a replay;
   - the mail-in review carries the same `alreadyHeld` on each attachment;
   - a maintenance backfill fills rows that have no value yet, in bounded
     batches, and is idempotent;
   - archive import raises no alert.

   Written from that specification alone. */

const { POST: applyWorkspaceCommand } = await loadRoute("workspace/commands");
const { GET: getReceipt } = await loadRoute("imap-inbox/[receiptId]");
const { GET: downloadDocument } = await loadRoute("documents/[documentId]/download");
const stageRoute = () => loadRoute("households/[householdId]/documents");
const { POST: attachToItem } = await loadRoute("households/[householdId]/items/[itemId]/documents");

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

afterEach(() => {
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

/* Loaded when a backfill test runs, so the module not existing yet fails those
   tests by name instead of stopping the whole file. */
const BACKFILL_MODULE = "@/server/document-maintenance/content-index-backfill";
async function backfillDocumentContentIndexes(limit?: number): Promise<unknown> {
  const module = await import(/* @vite-ignore */ BACKFILL_MODULE) as { backfillDocumentContentIndexes: (limit?: number) => Promise<unknown> };
  return module.backfillDocumentContentIndexes(limit);
}

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;

interface AlreadyHeld {
  documentId: string;
  displayName: string;
  addedAt: string;
  entry: { itemId: string; title: string } | null;
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const pdf = (label: string) => syntheticPdf(`duplicate test ${label}`);
const ENTRY_TITLE = "Car MOT - Volvo V60";

/** Gives the fixture's first item a known title so the alert's wording can be checked. */
async function titleTheItem(householdId: string, itemId: string, title = ENTRY_TITLE) {
  await getDb().update(items).set(await encryptedItemColumns(householdId, itemId, { title })).where(eq(items.id, itemId));
}

/** The member's Add form: stores the file with no item yet, sealed under a draft item id. */
async function stage(
  fixture: Fixture,
  session: Session,
  body: Buffer,
  { documentId = randomUUID(), itemId = randomUUID(), householdId = fixture.household.id, filename = "Service history.pdf" } = {},
) {
  const { POST } = await stageRoute();
  const response = await callRouteForSession(POST, session, {
    url: `http://127.0.0.1:3000/api/households/${householdId}/documents`,
    method: "POST",
    headers: {
      "content-length": String(body.length),
      "content-type": "application/pdf",
      "x-orbit-filename": encodeURIComponent(filename),
      "x-orbit-document-id": documentId,
      "x-orbit-item-id": itemId,
    },
    body: new Uint8Array(body),
    params: { householdId },
  });
  return { response, documentId, itemId };
}

/** The drawer's attach: stores the file on an existing item at once. */
async function attach(
  fixture: Fixture,
  session: Session,
  body: Buffer,
  { itemId = fixture.item.id, householdId = fixture.household.id, documentId = randomUUID(), filename = "Service history.pdf" } = {},
) {
  const response = await callRouteForSession(attachToItem, session, {
    url: `http://127.0.0.1:3000/api/households/${householdId}/items/${itemId}/documents`,
    method: "POST",
    headers: {
      "content-length": String(body.length),
      "content-type": "application/pdf",
      "x-orbit-filename": encodeURIComponent(filename),
      "x-orbit-document-id": documentId,
    },
    body: new Uint8Array(body),
    params: { householdId, itemId },
  });
  return { response, documentId };
}

async function alreadyHeldOf(response: Response): Promise<AlreadyHeld | null | undefined> {
  const { document } = await response.clone().json() as { document: { alreadyHeld?: AlreadyHeld | null } };
  return document.alreadyHeld;
}

function send(session: Session, body: Record<string, unknown>) {
  return callRouteForSession(applyWorkspaceCommand, session, {
    url: "http://127.0.0.1:3000/api/workspace/commands",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createWith(fixture: Fixture, itemId: string, documentIds: string[], title = "Car full service") {
  return {
    type: "item.upsert",
    householdId: fixture.household.id,
    item: { id: itemId, sectionId: fixture.section.id, title, currency: "GBP", dueDate: "2026-11-02", recurrenceMonths: 12, importance: "normal" },
    documentIds,
  };
}

/** Read with SQL so a missing column is a plain failure in the test that needs it. */
async function contentIndexOf(documentId: string): Promise<string | null> {
  const rows = await getDb().execute(sql`select content_index from documents where id = ${documentId}`);
  return (rows[0] as { content_index: string | null } | undefined)?.content_index ?? null;
}

async function nullIndexCount(): Promise<number> {
  const rows = await getDb().execute(sql`select count(*)::int as n from documents where content_index is null`);
  return Number((rows[0] as { n: number }).n);
}

async function rowOf(documentId: string) {
  const [row] = await getDb().select({
    id: documents.id, itemId: documents.itemId, lifecycle: documents.lifecycle, householdId: documents.householdId,
    deleteAfter: documents.deleteAfter, contentSha256: documents.contentSha256,
  }).from(documents).where(eq(documents.id, documentId));
  return row;
}

describe("the same bytes in the same household are recognised (#1437)", () => {
  it("names the earlier document and its entry in the answer, and still stores the second file", async () => {
    const fixture = await createIntegrationFixture("dup-same-household");
    const member = await fixture.session("member");
    await titleTheItem(fixture.household.id, fixture.item.id);
    const bytes = pdf("same household");

    const first = await attach(fixture, member, bytes, { filename: "Service history.pdf" });
    expect(first.response.status).toBe(201);
    expect(await alreadyHeldOf(first.response), "the first copy has nothing to be a duplicate of").toBeNull();

    const second = await stage(fixture, member, bytes, { filename: "scan 2.pdf" });
    expect(second.response.status).toBe(201);
    const held = await alreadyHeldOf(second.response);
    expect(held).toMatchObject({
      documentId: first.documentId,
      displayName: "Service history.pdf",
      entry: { itemId: fixture.item.id, title: ENTRY_TITLE },
    });
    expect(Number.isNaN(Date.parse(held!.addedAt))).toBe(false);
    // The alert never refuses: the new file is a stored, bindable document.
    expect(await rowOf(second.documentId)).toMatchObject({ lifecycle: "available", itemId: null });
  });

  it("also says so when the file is attached straight to an existing entry", async () => {
    const fixture = await createIntegrationFixture("dup-attach-route");
    const member = await fixture.session("member");
    const bytes = pdf("attach route");
    const first = await attach(fixture, member, bytes);
    const second = await attach(fixture, member, bytes);
    expect(second.response.status).toBe(201);
    expect(await alreadyHeldOf(second.response)).toMatchObject({ documentId: first.documentId });
  });

  it("returns the earliest match when several copies are held", async () => {
    const fixture = await createIntegrationFixture("dup-earliest");
    const member = await fixture.session("member");
    const bytes = pdf("earliest");
    // Upload order, id order and age order all disagree, so only age can give the answer.
    const [smallerId, largerId] = [randomUUID(), randomUUID()].sort();
    const uploadedFirst = await attach(fixture, member, bytes, { documentId: smallerId });
    const uploadedSecond = await attach(fixture, member, bytes, { documentId: largerId });
    const oldest = uploadedSecond.documentId;
    expect(oldest).toBe(largerId);
    await getDb().update(documents).set({ createdAt: new Date("2024-01-05T10:00:00Z") }).where(eq(documents.id, oldest));
    await getDb().update(documents).set({ createdAt: new Date("2025-06-01T10:00:00Z") }).where(eq(documents.id, uploadedFirst.documentId));

    const third = await stage(fixture, member, bytes);
    expect((await alreadyHeldOf(third.response))?.documentId).toBe(oldest);
  });

  it("does not repeat the alert when the same upload is sent again (an idempotent replay)", async () => {
    const fixture = await createIntegrationFixture("dup-replay");
    const member = await fixture.session("member");
    const bytes = pdf("replay");
    await attach(fixture, member, bytes);
    const second = await stage(fixture, member, bytes);
    expect(await alreadyHeldOf(second.response)).toMatchObject({ documentId: expect.any(String) });

    const replay = await stage(fixture, member, bytes, { documentId: second.documentId, itemId: second.itemId });
    expect(replay.response.status).toBe(201);
    expect(await alreadyHeldOf(replay.response) ?? null).toBeNull();
  });
});

describe("different bytes are not a match (#1437)", () => {
  it("answers alreadyHeld null for a different file in the same household", async () => {
    const fixture = await createIntegrationFixture("dup-different");
    const member = await fixture.session("member");
    await attach(fixture, member, pdf("one file"));
    const other = await stage(fixture, member, pdf("another file"));
    expect(other.response.status).toBe(201);
    expect(await alreadyHeldOf(other.response)).toBeNull();
  });
});

describe("the same bytes in another household never match (#1437)", () => {
  it("answers alreadyHeld null in the second household, on both upload routes", async () => {
    const fixture = await createIntegrationFixture("dup-cross-household");
    const owner = await fixture.session("owner");
    const secondOwner = await fixture.session("secondOwner");
    const bytes = pdf("cross household");

    const mine = await attach(fixture, owner, bytes);
    expect(mine.response.status).toBe(201);

    const staged = await stage(fixture, secondOwner, bytes, { householdId: fixture.secondHousehold.id });
    expect(staged.response.status).toBe(201);
    expect(await alreadyHeldOf(staged.response)).toBeNull();

    const attached = await attach(fixture, secondOwner, bytes, { householdId: fixture.secondHousehold.id, itemId: fixture.secondItem.id });
    expect(attached.response.status).toBe(201);
    expect(await alreadyHeldOf(attached.response)).toBeNull();
  });

  it("is symmetric: a file held only by the second household is not announced to the first", async () => {
    const fixture = await createIntegrationFixture("dup-cross-household-reverse");
    const owner = await fixture.session("owner");
    const secondOwner = await fixture.session("secondOwner");
    const bytes = pdf("cross household reverse");
    expect((await attach(fixture, secondOwner, bytes, { householdId: fixture.secondHousehold.id, itemId: fixture.secondItem.id })).response.status).toBe(201);
    const mine = await stage(fixture, owner, bytes);
    expect(await alreadyHeldOf(mine.response)).toBeNull();
  });

  it("finds no row of the other household by its stored value either", async () => {
    const fixture = await createIntegrationFixture("dup-cross-household-column");
    const owner = await fixture.session("owner");
    const secondOwner = await fixture.session("secondOwner");
    const bytes = pdf("cross household column");
    const a = await attach(fixture, owner, bytes);
    const b = await attach(fixture, secondOwner, bytes, { householdId: fixture.secondHousehold.id, itemId: fixture.secondItem.id });
    const aIndex = await contentIndexOf(a.documentId);
    expect(aIndex).not.toBeNull();
    const crossed = await getDb().execute(sql`
      select count(*)::int as n from documents where household_id = ${fixture.secondHousehold.id} and content_index = ${aIndex}`);
    expect(Number((crossed[0] as { n: number }).n)).toBe(0);
    expect(await contentIndexOf(b.documentId)).not.toBe(aIndex);
  });
});

describe("the fingerprint is a per-household keyed value, not the plain SHA-256 (#1437)", () => {
  it("gives the same file different values in two households while content_sha256 stays equal", async () => {
    const fixture = await createIntegrationFixture("dup-keyed");
    const owner = await fixture.session("owner");
    const secondOwner = await fixture.session("secondOwner");
    const bytes = pdf("keyed");
    const a = await attach(fixture, owner, bytes);
    const b = await attach(fixture, secondOwner, bytes, { householdId: fixture.secondHousehold.id, itemId: fixture.secondItem.id });

    const [aIndex, bIndex] = [await contentIndexOf(a.documentId), await contentIndexOf(b.documentId)];
    expect(aIndex).not.toBeNull();
    expect(bIndex).not.toBeNull();
    expect(aIndex).not.toBe(bIndex);
    expect((await rowOf(a.documentId)).contentSha256).toBe((await rowOf(b.documentId)).contentSha256);
    expect((await rowOf(a.documentId)).contentSha256).toBe(sha256(bytes));
  });

  it("is a 256-bit base64url value that is neither the hex hash nor its base64 form", async () => {
    const fixture = await createIntegrationFixture("dup-keyed-shape");
    const owner = await fixture.session("owner");
    const bytes = pdf("keyed shape");
    const a = await attach(fixture, owner, bytes);
    const index = await contentIndexOf(a.documentId);
    expect(index).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const plain = createHash("sha256").update(bytes).digest();
    expect(index).not.toBe(plain.toString("hex"));
    expect(index).not.toBe(plain.toString("base64url"));
    expect(index).not.toBe(plain.toString("base64"));
  });

  it("is stable within a household: the same bytes always give the same value, other bytes another", async () => {
    const fixture = await createIntegrationFixture("dup-keyed-stable");
    const owner = await fixture.session("owner");
    const bytes = pdf("keyed stable");
    const a = await attach(fixture, owner, bytes);
    const b = await attach(fixture, owner, bytes);
    const c = await attach(fixture, owner, pdf("keyed stable other"));
    expect(await contentIndexOf(a.documentId)).toBe(await contentIndexOf(b.documentId));
    expect(await contentIndexOf(c.documentId)).not.toBe(await contentIndexOf(a.documentId));
  });
});

describe("only available, item-bound documents count as already held (#1437)", () => {
  it("ignores a first copy that was only staged and never bound to an entry", async () => {
    const fixture = await createIntegrationFixture("dup-staged-first");
    const member = await fixture.session("member");
    const bytes = pdf("staged first");
    expect((await stage(fixture, member, bytes)).response.status).toBe(201);
    const second = await stage(fixture, member, bytes);
    expect(await alreadyHeldOf(second.response)).toBeNull();
  });

  it("counts a staged first copy once the entry has bound it", async () => {
    const fixture = await createIntegrationFixture("dup-staged-then-bound");
    const owner = await fixture.session("owner");
    const bytes = pdf("staged then bound");
    const first = await stage(fixture, owner, bytes);
    expect((await send(owner, createWith(fixture, first.itemId, [first.documentId]))).status).toBe(200);
    const second = await stage(fixture, owner, bytes);
    expect(await alreadyHeldOf(second.response)).toMatchObject({ documentId: first.documentId, entry: { itemId: first.itemId, title: "Car full service" } });
  });

  it.each(["pending_deletion", "deleted", "rejected", "scanning"] as const)("ignores a first copy that is %s", async (lifecycle) => {
    const fixture = await createIntegrationFixture(`dup-lifecycle-${lifecycle}`);
    const member = await fixture.session("member");
    const bytes = pdf(`lifecycle ${lifecycle}`);
    const first = await attach(fixture, member, bytes);
    await getDb().update(documents).set({ lifecycle }).where(eq(documents.id, first.documentId));
    const second = await stage(fixture, member, bytes);
    expect(second.response.status).toBe(201);
    expect(await alreadyHeldOf(second.response)).toBeNull();
  });
});

describe("the backfill fills missing values (#1437)", () => {
  async function plantUnindexed(fixture: Fixture, which: "first" | "second", sha: string) {
    const householdId = which === "first" ? fixture.household.id : fixture.secondHousehold.id;
    const itemId = which === "first" ? fixture.item.id : fixture.secondItem.id;
    const id = randomUUID();
    await getDb().insert(documents).values({
      id, householdId, itemId, displayName: `planted-${id}.pdf`, mediaType: "application/pdf", sizeBytes: 10,
      contentSha256: sha, lifecycle: "available", scanStatus: "clean",
    });
    return id;
  }

  async function drain() {
    for (let guard = 0; guard < 200 && await nullIndexCount() > 0; guard += 1) await backfillDocumentContentIndexes();
    expect(await nullIndexCount()).toBe(0);
  }

  it("gives an old row exactly the value an upload of the same file gets, and makes it matchable", async () => {
    const fixture = await createIntegrationFixture("dup-backfill-value");
    const member = await fixture.session("member");
    const bytes = pdf("backfill value");
    const first = await attach(fixture, member, bytes);
    const expected = await contentIndexOf(first.documentId);
    expect(expected).not.toBeNull();
    await getDb().execute(sql`update documents set content_index = null where id = ${first.documentId}`);

    // Until the backfill reaches it the row is simply not matched: no error, no fabrication.
    const before = await stage(fixture, member, bytes);
    expect(before.response.status).toBe(201);
    expect(await alreadyHeldOf(before.response)).toBeNull();

    await drain();
    expect(await contentIndexOf(first.documentId)).toBe(expected);
    const after = await stage(fixture, member, bytes);
    expect(await alreadyHeldOf(after.response)).toMatchObject({ documentId: first.documentId });
  });

  it("works in bounded batches: one call fills at most the limit it was given", async () => {
    const fixture = await createIntegrationFixture("dup-backfill-bounded");
    await drain();
    const planted: string[] = [];
    for (let n = 0; n < 5; n += 1) planted.push(await plantUnindexed(fixture, n % 2 === 0 ? "first" : "second", sha256(Buffer.from(`bounded ${n}`))));
    expect(await nullIndexCount()).toBe(5);

    await backfillDocumentContentIndexes(2);
    expect(await nullIndexCount(), "a batch of 2 fills 2").toBe(3);
    await backfillDocumentContentIndexes(2);
    expect(await nullIndexCount()).toBe(1);
    await backfillDocumentContentIndexes(2);
    expect(await nullIndexCount()).toBe(0);
    for (const id of planted) expect(await contentIndexOf(id)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is idempotent: a second pass changes nothing and never overwrites a value already there", async () => {
    const fixture = await createIntegrationFixture("dup-backfill-idempotent");
    await drain();
    const sha = sha256(Buffer.from("idempotent"));
    const empty = await plantUnindexed(fixture, "first", sha);
    const filled = await plantUnindexed(fixture, "first", sha);
    await getDb().execute(sql`update documents set content_index = 'already-set-by-an-upload' where id = ${filled}`);

    await drain();
    const firstPass = await contentIndexOf(empty);
    expect(firstPass).not.toBeNull();
    await drain();
    await backfillDocumentContentIndexes();
    expect(await contentIndexOf(empty)).toBe(firstPass);
    expect(await contentIndexOf(filled)).toBe("already-set-by-an-upload");
  });

  it("keys each row by its own household, so equal hashes in two households get different values", async () => {
    const fixture = await createIntegrationFixture("dup-backfill-households");
    await drain();
    const sha = sha256(Buffer.from("backfill households"));
    const a = await plantUnindexed(fixture, "first", sha);
    const b = await plantUnindexed(fixture, "second", sha);
    await drain();
    expect(await contentIndexOf(a)).not.toBe(await contentIndexOf(b));
  });
});

describe("a KEK rewrap leaves matches working (#1437)", () => {
  it("still names the first copy after the key rotation, with no row rewritten", async () => {
    const fixture = await createIntegrationFixture("dup-kek-rotation");
    const member = await fixture.session("member");
    const bytes = pdf("kek rotation");
    const first = await attach(fixture, member, bytes);
    const indexBefore = await contentIndexOf(first.documentId);
    expect(indexBefore).not.toBeNull();

    const current = getDocumentConfig();
    const originalKek = process.env.DOCUMENT_KEK;
    const nextKek = randomBytes(32);
    const keys: RotationKeys = {
      currentKek: current.keyEncryptionKey, currentKeyId: current.keyId, nextKek, nextKeyId: deriveDocumentKeyId(nextKek),
    };
    try {
      process.env.DOCUMENT_KEK_NEXT = nextKek.toString("hex");
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();
      await runKekRotationToCompletion(keys);
      process.env.DOCUMENT_KEK = nextKek.toString("hex");
      delete process.env.DOCUMENT_KEK_NEXT;
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();

      expect(await contentIndexOf(first.documentId), "the value is derived from the household key, which a rewrap does not change").toBe(indexBefore);
      const second = await stage(fixture, member, bytes);
      expect(second.response.status).toBe(201);
      expect(await alreadyHeldOf(second.response)).toMatchObject({ documentId: first.documentId });
    } finally {
      if (originalKek === undefined) delete process.env.DOCUMENT_KEK;
      else process.env.DOCUMENT_KEK = originalKek;
      delete process.env.DOCUMENT_KEK_NEXT;
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();
    }
  });
});

describe("keep it anyway stores the second copy as a normal document (#1437)", () => {
  it("binds through the ordinary save, opens, keeps its own fingerprint, and later uploads still name the original", async () => {
    const fixture = await createIntegrationFixture("dup-keep");
    const owner = await fixture.session("owner");
    const bytes = pdf("keep it anyway");
    const original = await attach(fixture, owner, bytes);

    const copy = await stage(fixture, owner, bytes);
    expect(await alreadyHeldOf(copy.response)).toMatchObject({ documentId: expect.any(String) });
    const kept = await send(owner, createWith(fixture, copy.itemId, [copy.documentId], "Car MOT second copy"));
    expect(kept.status).toBe(200);

    expect(await rowOf(copy.documentId)).toMatchObject({ itemId: copy.itemId, lifecycle: "available", deleteAfter: null });
    expect(await contentIndexOf(copy.documentId)).toBe(await contentIndexOf(original.documentId));
    const opened = await callRouteForSession(downloadDocument, owner, {
      url: `http://127.0.0.1:3000/api/documents/${copy.documentId}/download`,
      params: { documentId: copy.documentId },
    });
    expect(opened.status).toBe(200);
    expect(Buffer.from(await opened.arrayBuffer())).toEqual(bytes);

    const third = await stage(fixture, owner, bytes);
    expect((await alreadyHeldOf(third.response))?.documentId, "the earliest copy is still the one named").toBe(original.documentId);
  });

  it("not this one: a discarded second copy leaves the original named and alone", async () => {
    const fixture = await createIntegrationFixture("dup-not-this-one");
    const owner = await fixture.session("owner");
    const bytes = pdf("not this one");
    const original = await attach(fixture, owner, bytes);
    const copy = await stage(fixture, owner, bytes);
    await getDb().update(documents).set({ lifecycle: "pending_deletion" }).where(eq(documents.id, copy.documentId));
    expect(await rowOf(original.documentId)).toMatchObject({ lifecycle: "available", itemId: fixture.item.id });
    const again = await stage(fixture, owner, bytes);
    expect((await alreadyHeldOf(again.response))?.documentId).toBe(original.documentId);
  });

  it("double submit: the same save sent twice at once binds the copy once, and one request wins", async () => {
    const fixture = await createIntegrationFixture("dup-keep-double-submit");
    const owner = await fixture.session("owner");
    const bytes = pdf("double submit");
    await attach(fixture, owner, bytes);
    const copy = await stage(fixture, owner, bytes);
    expect(await alreadyHeldOf(copy.response)).toMatchObject({ documentId: expect.any(String) });

    const payload = createWith(fixture, copy.itemId, [copy.documentId], "Kept twice");
    const responses = await Promise.all([send(owner, payload), send(owner, payload)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);

    expect(await getDb().select({ id: items.id }).from(items).where(eq(items.id, copy.itemId))).toHaveLength(1);
    expect(await rowOf(copy.documentId)).toMatchObject({ itemId: copy.itemId, deleteAfter: null });
  });
});

describe("the mail-in review marks an attachment the household already holds (#1437)", () => {
  async function receiptWith(fixture: Fixture, session: Session, householdId: string, attachmentBytes: Buffer[]) {
    const receiptId = randomUUID();
    await getDb().insert(imapIngestionMessages).values({
      id: receiptId, mailbox: "private", mailboxUidValidity: `dup-${receiptId}`, mailboxUid: 501,
      contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: `dup-${receiptId}`,
      userId: session.userId, status: "pending_review", householdId, receiptStatus: "pending",
      expiresAt: new Date(Date.now() + 86_400_000),
      ...await encryptedReceiptDraft(householdId, receiptId, { proposal: { title: "Your MOT certificate" } }),
    });
    const ids: string[] = [];
    for (const [index, bytes] of attachmentBytes.entries()) {
      const id = randomUUID();
      ids.push(id);
      await getDb().insert(imapIngestionAttachments).values({
        id, messageId: receiptId, displayName: `forwarded-${index}.pdf`, mediaType: "application/pdf", sizeBytes: bytes.length,
        contentSha256: sha256(bytes), storageKey: `review/${randomUUID()}`, ciphertextSize: 20, envelopeVersion: 1,
        contentIv: "iv", contentAuthTag: "tag", wrappedDek: "dek", wrapIv: "wrap-iv", wrapAuthTag: "wrap-tag", keyId: "key", status: "stored",
        createdAt: new Date(Date.UTC(2030, 0, 1, 0, 0, index)),
      });
    }
    return { receiptId, ids };
  }

  it("marks the matching attachment with the entry that holds it, and only that one", async () => {
    const fixture = await createIntegrationFixture("dup-mail-in");
    const member = await fixture.session("member");
    await titleTheItem(fixture.household.id, fixture.item.id);
    const held = pdf("mail-in held");
    const fresh = pdf("mail-in new");
    const first = await attach(fixture, member, held);
    const { receiptId, ids } = await receiptWith(fixture, member, fixture.household.id, [fresh, held]);

    const review = await getImapReview(member.userId, receiptId, fixture.household.id);
    const byId = new Map(review.attachments.map((one) => [one.id, one as typeof one & { alreadyHeld?: AlreadyHeld | null }]));
    expect(byId.get(ids[0])!.alreadyHeld ?? null).toBeNull();
    expect(byId.get(ids[1])!.alreadyHeld).toMatchObject({
      documentId: first.documentId, entry: { itemId: fixture.item.id, title: ENTRY_TITLE },
    });
    expect(JSON.stringify(review)).not.toContain(sha256(held));
  });

  it("carries the mark on the review route's JSON too", async () => {
    const fixture = await createIntegrationFixture("dup-mail-in-route");
    const member = await fixture.session("member");
    const held = pdf("mail-in route");
    const first = await attach(fixture, member, held);
    const { receiptId, ids } = await receiptWith(fixture, member, fixture.household.id, [held]);
    const response = await callRouteForSession(getReceipt, member, {
      url: `http://127.0.0.1:3000/api/imap-inbox/${receiptId}?householdId=${fixture.household.id}`,
      params: { receiptId },
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { attachments: Array<{ id: string; alreadyHeld?: AlreadyHeld | null }> };
    expect(payload.attachments.find((one) => one.id === ids[0])?.alreadyHeld).toMatchObject({ documentId: first.documentId });
  });

  it("does not mark an attachment whose bytes only another household holds", async () => {
    const fixture = await createIntegrationFixture("dup-mail-in-cross");
    const owner = await fixture.session("owner");
    const secondOwner = await fixture.session("secondOwner");
    const bytes = pdf("mail-in cross");
    await attach(fixture, owner, bytes);
    const { receiptId, ids } = await receiptWith(fixture, secondOwner, fixture.secondHousehold.id, [bytes]);
    const review = await getImapReview(secondOwner.userId, receiptId, fixture.secondHousehold.id);
    const one = review.attachments.find((entry) => entry.id === ids[0]) as { alreadyHeld?: AlreadyHeld | null };
    expect(one.alreadyHeld ?? null).toBeNull();
  });

  it("does not mark an attachment when the only held copy is not available", async () => {
    const fixture = await createIntegrationFixture("dup-mail-in-unavailable");
    const member = await fixture.session("member");
    const bytes = pdf("mail-in unavailable");
    const first = await attach(fixture, member, bytes);
    await getDb().update(documents).set({ lifecycle: "pending_deletion" }).where(eq(documents.id, first.documentId));
    const { receiptId, ids } = await receiptWith(fixture, member, fixture.household.id, [bytes]);
    const review = await getImapReview(member.userId, receiptId, fixture.household.id);
    const one = review.attachments.find((entry) => entry.id === ids[0]) as { alreadyHeld?: AlreadyHeld | null };
    expect(one.alreadyHeld ?? null).toBeNull();
  });
});
