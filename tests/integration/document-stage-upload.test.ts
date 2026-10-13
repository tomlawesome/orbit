import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documentCrypto, documentJobs, documents, items } from "@/db/schema";
import { resetDocumentConfigForTests } from "@/server/documents/config";
import { reconcileDocumentStorage, runDocumentMaintenanceCycle } from "@/server/document-worker";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";
import { syntheticPdf as createSyntheticPdf } from "../support/synthetic-documents";

/* #1316 (owner, 2026-10-13): the first half of an all-or-nothing create. The
   stage route stores a document before any item exists:

     POST /api/households/:householdId/documents

   (the same raw-body shape as the item's own documents route, with the
   client's document id in `x-orbit-document-id` and the draft item's id in
   `x-orbit-item-id`: the ciphertext is sealed under that item id, recorded as
   `documents.sealed_item_id`, and binding checks it -- amendment "sealing
   context for staged uploads"). The document is scanned and
   stored as for any upload but has no item and a `delete_after` about 24 hours
   ahead; binding it through `item.upsert { documentIds }` clears that.
   Uploading is idempotent on the client's document id, so a retry with the
   same draft id and document id never stores the file twice.

   The route is loaded lazily so each test names its own failure while the
   route does not yet exist. */

const { POST: applyWorkspaceCommand } = await loadRoute("workspace/commands");
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

const DAY_MS = 86_400_000;
const syntheticPdf = createSyntheticPdf("synthetic staged document");
type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;

async function stage(
  fixture: Fixture,
  session: Session | null,
  { documentId, itemId, filename = "policy.pdf", body = syntheticPdf, householdId = fixture.household.id }:
    { documentId?: string; itemId?: string; filename?: string; body?: Buffer; householdId?: string } = {},
) {
  const { POST } = await stageRoute();
  const call = {
    url: `http://127.0.0.1:3000/api/households/${householdId}/documents`,
    method: "POST",
    headers: {
      "content-length": String(body.length),
      "content-type": "application/pdf",
      "x-orbit-filename": encodeURIComponent(filename),
      ...(documentId ? { "x-orbit-document-id": documentId } : {}),
      ...(itemId ? { "x-orbit-item-id": itemId } : {}),
    },
    body: new Uint8Array(body),
    params: { householdId },
  };
  return session ? callRouteForSession(POST, session, call) : callRoute(POST, call);
}

async function withRequiredScanMode<T>(work: () => Promise<T>): Promise<T> {
  const previous = process.env.DOCUMENT_SCAN_MODE;
  process.env.DOCUMENT_SCAN_MODE = "required";
  resetDocumentConfigForTests();
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.DOCUMENT_SCAN_MODE;
    else process.env.DOCUMENT_SCAN_MODE = previous;
    resetDocumentConfigForTests();
    vi.mocked(scanFileWithClamAv).mockReset();
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
  }
}

function send(session: Session, body: Record<string, unknown>) {
  return callRouteForSession(applyWorkspaceCommand, session, {
    url: "http://127.0.0.1:3000/api/workspace/commands",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createWith(fixture: Fixture, itemId: string, documentIds: string[], title = "Boiler cover") {
  return {
    type: "item.upsert",
    householdId: fixture.household.id,
    kind: "inspection",
    item: { id: itemId, sectionId: fixture.section.id, title, currency: "GBP", dueDate: "2026-11-02", recurrenceMonths: 12 },
    documentIds,
  };
}

/** The new column is read with SQL so a missing column is a plain failure here. */
async function sealedItemId(id: string) {
  const rows = await getDb().execute(sql`select sealed_item_id from documents where id = ${id}`);
  return (rows[0] as { sealed_item_id: string | null } | undefined)?.sealed_item_id;
}

async function download(session: Session, documentId: string) {
  return callRouteForSession(downloadDocument, session, {
    url: `http://127.0.0.1:3000/api/documents/${documentId}/download`,
    params: { documentId },
  });
}

async function documentRows(id: string) {
  return getDb().select({
    id: documents.id, itemId: documents.itemId, householdId: documents.householdId, deleteAfter: documents.deleteAfter,
    lifecycle: documents.lifecycle, uploadedBy: documents.uploadedByUserId, displayName: documents.displayName,
  }).from(documents).where(eq(documents.id, id));
}

describe("the stage route stores a document with no item", () => {
  it("answers 201 with the client's document id, an unbound row, and delete_after about 24 hours ahead", async () => {
    const fixture = await createIntegrationFixture("stage-stores");
    const member = await fixture.session("member");
    const documentId = randomUUID();
    const itemId = randomUUID();
    const before = Date.now();

    const response = await stage(fixture, member, { documentId, itemId });
    expect(response.status).toBe(201);
    const { document } = await response.json() as { document: { id: string; displayName: string } };
    expect(document).toMatchObject({ id: documentId, displayName: "policy.pdf" });

    const rows = await documentRows(documentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemId: null, householdId: fixture.household.id, lifecycle: "available", uploadedBy: fixture.users.member.id,
    });
    const due = rows[0].deleteAfter?.getTime() ?? 0;
    expect(due).toBeGreaterThan(before + DAY_MS - 60 * 60 * 1000);
    expect(due).toBeLessThan(Date.now() + DAY_MS + 60 * 60 * 1000);
    expect(await getDb().select({ id: documentCrypto.documentId }).from(documentCrypto).where(eq(documentCrypto.documentId, documentId)))
      .toHaveLength(1);
    expect(await sealedItemId(documentId), "the id the ciphertext was sealed under is kept beside it").toBe(itemId);
  });

  it("is idempotent on the client's document id: a second send returns the same document and stores nothing new", async () => {
    const fixture = await createIntegrationFixture("stage-idempotent");
    const member = await fixture.session("member");
    const documentId = randomUUID();
    const itemId = randomUUID();

    const first = await stage(fixture, member, { documentId, itemId });
    const second = await stage(fixture, member, { documentId, itemId });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await second.json()).document.id).toBe(documentId);
    expect(await documentRows(documentId)).toHaveLength(1);
    expect(await getDb().select({ id: documentCrypto.documentId }).from(documentCrypto).where(eq(documentCrypto.documentId, documentId)))
      .toHaveLength(1);
  });

  it("refuses the same document id sent with different bytes", async () => {
    const fixture = await createIntegrationFixture("stage-content-reuse");
    const member = await fixture.session("member");
    const documentId = randomUUID();
    const itemId = randomUUID();
    expect((await stage(fixture, member, { documentId, itemId })).status).toBe(201);
    const changed = await stage(fixture, member, { documentId, itemId, body: Buffer.concat([syntheticPdf, Buffer.from("changed content")]) });
    expect(changed.status).toBe(409);
    expect((await changed.json()).error.code).toBe("document_conflict");
  });

  it("a second send of an id that is already bound hands back the document and leaves it bound", async () => {
    const fixture = await createIntegrationFixture("stage-after-bind");
    const owner = await fixture.session("owner");
    const documentId = randomUUID();
    const itemId = randomUUID();
    expect((await stage(fixture, owner, { documentId, itemId })).status).toBe(201);
    expect((await send(owner, createWith(fixture, itemId, [documentId]))).status).toBe(200);

    const again = await stage(fixture, owner, { documentId, itemId });
    expect(again.status).toBe(201);
    expect((await again.json()).document.id).toBe(documentId);
    expect(await documentRows(documentId)).toMatchObject([{ itemId, deleteAfter: null }]);
  });

  it("needs a filename, a valid document id and a signed-in member of the household", async () => {
    const fixture = await createIntegrationFixture("stage-access");
    const member = await fixture.session("member");
    const outsider = await fixture.session("secondOwner");

    const noName = await stage(fixture, member, { documentId: randomUUID(), itemId: randomUUID(), filename: "" });
    expect(noName.status).toBe(422);

    const badId = await stage(fixture, member, { documentId: "not-a-uuid", itemId: randomUUID() });
    expect(badId.status).toBe(422);
    expect((await badId.json()).error.code).toBe("document_id_invalid");

    const outsiderId = randomUUID();
    const refused = await stage(fixture, outsider, { documentId: outsiderId, itemId: randomUUID() });
    expect([403, 404]).toContain(refused.status);
    expect(await documentRows(outsiderId)).toHaveLength(0);

    const anonymousId = randomUUID();
    const anonymous = await stage(fixture, null, { documentId: anonymousId, itemId: randomUUID() });
    expect(anonymous.status).toBe(401);
    expect(await documentRows(anonymousId)).toHaveLength(0);
  });
});

describe("a refused file is refused at the stage, in the server's own words", () => {
  it("answers a detected virus as document_malware_detected and keeps no usable document", async () => {
    const fixture = await createIntegrationFixture("stage-malware");
    const member = await fixture.session("member");
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "infected", signature: "synthetic-signature" });
    await withRequiredScanMode(async () => {
      const documentId = randomUUID();
      const response = await stage(fixture, member, { documentId, itemId: randomUUID() });
      expect(response.status).toBe(422);
      const { error } = await response.json() as { error: { code: string; message: string } };
      expect(error.code).toBe("document_malware_detected");
      expect(error.message).not.toBe("");
      const rows = await documentRows(documentId);
      expect(rows.every((one) => one.lifecycle === "rejected")).toBe(true);
    });
  });

  it("a file the upload will not keep, such as a truncated PDF, is refused with a 4xx and a reason", async () => {
    const fixture = await createIntegrationFixture("stage-unsupported");
    const member = await fixture.session("member");
    const response = await stage(fixture, member, {
      documentId: randomUUID(), itemId: randomUUID(), filename: "notes.exe", body: Buffer.from("MZ not a document"),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect((await response.json() as { error: { message: string } }).error.message).not.toBe("");
  });
});

describe("a scanner outage holds the staged document and the item can still bind it", () => {
  it("answers 202, keeps delete_after, and lets item.upsert bind it", async () => {
    const fixture = await createIntegrationFixture("stage-scanner-outage");
    const owner = await fixture.session("owner");
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "unavailable" });
    await withRequiredScanMode(async () => {
      const documentId = randomUUID();
      const itemId = randomUUID();
      const staged = await stage(fixture, owner, { documentId, itemId });
      expect(staged.status).toBe(202);
      expect((await staged.json()).document).toMatchObject({ id: documentId, recoverable: true });
      expect(await documentRows(documentId)).toMatchObject([{ itemId: null }]);

      expect((await send(owner, createWith(fixture, itemId, [documentId]))).status).toBe(200);
      expect(await documentRows(documentId)).toMatchObject([{ itemId, deleteAfter: null }]);
    });
  });
});

describe("stage then bind: a retry under the same draft id and document id uploads nothing twice", () => {
  it("an item refused after staging is retried with the same document id: one stored copy, bound once", async () => {
    const fixture = await createIntegrationFixture("stage-retry");
    const owner = await fixture.session("owner");
    const documentId = randomUUID();
    const itemId = randomUUID();

    expect((await stage(fixture, owner, { documentId, itemId })).status).toBe(201);
    const refused = await send(owner, createWith(fixture, itemId, [documentId], "  "));
    expect(refused.status).toBe(422);
    expect(await getDb().select({ id: items.id }).from(items).where(eq(items.id, itemId))).toHaveLength(0);
    expect(await documentRows(documentId)).toMatchObject([{ itemId: null }]);

    // The member fixes the name and presses Add again: same ids, no new file.
    expect((await stage(fixture, owner, { documentId, itemId })).status).toBe(201);
    expect((await send(owner, createWith(fixture, itemId, [documentId]))).status).toBe(200);

    const mine = await getDb().select({ id: documents.id, itemId: documents.itemId, deleteAfter: documents.deleteAfter })
      .from(documents).where(and(eq(documents.householdId, fixture.household.id), eq(documents.id, documentId)));
    expect(mine).toEqual([{ id: documentId, itemId, deleteAfter: null }]);
    expect(await getDb().select({ id: documentCrypto.documentId }).from(documentCrypto).where(eq(documentCrypto.documentId, documentId)))
      .toHaveLength(1);
  });
});

describe("the stage names the draft item the ciphertext is sealed under (amendment)", () => {
  it("needs an x-orbit-item-id that is a uuid: missing or malformed is 422 item_id_invalid and stores nothing", async () => {
    const fixture = await createIntegrationFixture("stage-item-header");
    const member = await fixture.session("member");
    for (const itemId of [undefined, "not-a-uuid", ""]) {
      const documentId = randomUUID();
      const response = await stage(fixture, member, { documentId, itemId });
      expect(response.status, `header ${JSON.stringify(itemId)}`).toBe(422);
      expect((await response.json()).error.code).toBe("item_id_invalid");
      expect(await documentRows(documentId)).toHaveLength(0);
    }
  });

  it("a staged document is invisible until bound, then opens: download 404, bind, download 200 with the same bytes", async () => {
    const fixture = await createIntegrationFixture("stage-download-after-bind");
    const owner = await fixture.session("owner");
    const documentId = randomUUID();
    const itemId = randomUUID();

    expect((await stage(fixture, owner, { documentId, itemId })).status).toBe(201);
    expect((await download(owner, documentId)).status).toBe(404);

    expect((await send(owner, createWith(fixture, itemId, [documentId]))).status).toBe(200);
    const opened = await download(owner, documentId);
    expect(opened.status).toBe(200);
    expect(Buffer.from(await opened.arrayBuffer())).toEqual(syntheticPdf);
  });

  it("under a scanner outage: stage 202, bind, scanner back, recovery job runs, then the download opens", async () => {
    const fixture = await createIntegrationFixture("stage-outage-recovery-download");
    const owner = await fixture.session("owner");
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "unavailable" });
    await withRequiredScanMode(async () => {
      const documentId = randomUUID();
      const itemId = randomUUID();
      expect((await stage(fixture, owner, { documentId, itemId })).status).toBe(202);
      expect((await send(owner, createWith(fixture, itemId, [documentId]))).status).toBe(200);

      await getDb().update(documentJobs).set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));
      vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
      await runDocumentMaintenanceCycle();

      const [row] = await getDb().select({ lifecycle: documents.lifecycle, failureCode: documents.failureCode })
        .from(documents).where(eq(documents.id, documentId));
      expect(row, "recovery sealed and opened the ciphertext under the same item id").toEqual({ lifecycle: "available", failureCode: null });
      const opened = await download(owner, documentId);
      expect(opened.status).toBe(200);
      expect(Buffer.from(await opened.arrayBuffer())).toEqual(syntheticPdf);
    });
  });

  it("staged under draft A and bound to item B is refused: 422, no item, the row unchanged", async () => {
    const fixture = await createIntegrationFixture("stage-sealed-mismatch");
    const owner = await fixture.session("owner");
    const documentId = randomUUID();
    const draftA = randomUUID();
    const itemB = randomUUID();
    expect((await stage(fixture, owner, { documentId, itemId: draftA })).status).toBe(201);
    const [before] = await documentRows(documentId);

    const response = await send(owner, createWith(fixture, itemB, [documentId]));
    expect(response.status).toBe(422);
    expect((await response.json()).error.message).toMatch(/no longer available/iu);
    expect(await getDb().select({ id: items.id }).from(items).where(eq(items.id, itemB))).toHaveLength(0);
    expect(await documentRows(documentId)).toEqual([before]);
    expect(await sealedItemId(documentId)).toBe(draftA);

    // The right draft id still binds it.
    expect((await send(owner, createWith(fixture, draftA, [documentId]))).status).toBe(200);
  });
});

describe("the storage sweep retires staged uploads nobody bound", () => {
  it("moves an expired unbound upload to pending_deletion with a purge job, and leaves bound and unexpired ones alone", async () => {
    const fixture = await createIntegrationFixture("stage-sweep");
    const owner = await fixture.session("owner");
    const expired = randomUUID();
    const fresh = randomUUID();
    const bound = randomUUID();
    const boundItem = randomUUID();
    for (const [documentId, itemId] of [[expired, randomUUID()], [fresh, randomUUID()], [bound, boundItem]] as const) {
      expect((await stage(fixture, owner, { documentId, itemId })).status).toBe(201);
    }
    expect((await send(owner, createWith(fixture, boundItem, [bound]))).status).toBe(200);
    await getDb().update(documents).set({ deleteAfter: new Date(Date.now() - 60_000) }).where(eq(documents.id, expired));
    const [expiredBefore] = await getDb().select({ version: documents.version }).from(documents).where(eq(documents.id, expired));

    await reconcileDocumentStorage();

    const state = async (id: string) => {
      const [row] = await getDb().select({ lifecycle: documents.lifecycle, version: documents.version, itemId: documents.itemId })
        .from(documents).where(eq(documents.id, id));
      const jobs = await getDb().select({ id: documentJobs.id }).from(documentJobs)
        .where(and(eq(documentJobs.documentId, id), eq(documentJobs.kind, "purge")));
      return { ...row, purgeJobs: jobs.length };
    };
    expect(await state(expired)).toMatchObject({ lifecycle: "pending_deletion", version: expiredBefore.version + 1, purgeJobs: 1 });
    expect(await state(fresh)).toMatchObject({ lifecycle: "available", purgeJobs: 0 });
    expect(await state(bound)).toMatchObject({ lifecycle: "available", itemId: boundItem, purgeJobs: 0 });

    // Running it again changes nothing further.
    await reconcileDocumentStorage();
    expect(await state(expired)).toMatchObject({ lifecycle: "pending_deletion", purgeJobs: 1 });
  });
});

/* Plan risk: "the home drawer's existing attach route is unchanged -- confirm
   by test, not by reading". The drawer attaches to an item that already
   exists through the item's own documents route; that route still needs the
   item, binds at once (no delete_after), takes no x-orbit-item-id, and the
   ciphertext still opens. The amendment adds one thing: every new row records
   the id it was sealed under, which for this route is the item's own id. */
describe("the home drawer's attach route to an existing item is unchanged", () => {
  function attach(fixture: Fixture, session: Session, itemId: string, documentId: string) {
    return callRouteForSession(attachToItem, session, {
      url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${itemId}/documents`,
      method: "POST",
      headers: {
        "content-length": String(syntheticPdf.length),
        "content-type": "application/pdf",
        "x-orbit-filename": encodeURIComponent("drawer-policy.pdf"),
        "x-orbit-document-id": documentId,
      },
      body: new Uint8Array(syntheticPdf),
      params: { householdId: fixture.household.id, itemId },
    });
  }

  it("attaches to an existing item at once: 201, bound, no delete_after, sealed under that item, and it opens", async () => {
    const fixture = await createIntegrationFixture("drawer-attach");
    const member = await fixture.session("member");
    const documentId = randomUUID();

    const response = await attach(fixture, member, fixture.item.id, documentId);
    expect(response.status).toBe(201);
    expect((await response.json()).document).toMatchObject({ id: documentId, displayName: "drawer-policy.pdf" });
    expect(await documentRows(documentId)).toMatchObject([{ itemId: fixture.item.id, deleteAfter: null, lifecycle: "available" }]);
    expect(await sealedItemId(documentId)).toBe(fixture.item.id);

    const opened = await download(member, documentId);
    expect(opened.status).toBe(200);
    expect(Buffer.from(await opened.arrayBuffer())).toEqual(syntheticPdf);

    // A retry under the same id is still idempotent on this route.
    expect((await attach(fixture, member, fixture.item.id, documentId)).status).toBe(201);
    expect(await documentRows(documentId)).toHaveLength(1);
  });

  it("still refuses an item that does not exist, and stores nothing", async () => {
    const fixture = await createIntegrationFixture("drawer-attach-missing-item");
    const member = await fixture.session("member");
    const documentId = randomUUID();
    const response = await attach(fixture, member, randomUUID(), documentId);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("item_not_found");
    expect(await documentRows(documentId)).toHaveLength(0);
  });
});
