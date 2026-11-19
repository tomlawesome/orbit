import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documents, imapIngestionAttachments, imapIngestionMessages } from "@/db/schema";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { createPortableArchive, readPortableArchive } from "@/server/portable-archive-repository";
import { approveReviewedIntake } from "@/server/reviewed-intake";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { sealedHash } from "./support/imap-attachment-seed";
import { archiveForm } from "./support/portable-archive-upload";
import { postForm, proofCookie } from "./support/portable-archive-routes";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { seedStoredDocuments } from "./support/stored-documents";
import { holdAttachmentBytes } from "../support/imap-holding";
import { syntheticPdf } from "../support/synthetic-documents";

/* #1446 review, #1605 P-1 / #1904: the per-member staged-upload cap (100) limits only a
   member's own staged uploads, the direct upload path. System staging (archive import,
   mail approval) stages under the member too, but is never refused by the cap and does
   not count against it. #1605's P-1 text concerns the purge job's missing limit and does
   not extend the cap to these paths. */

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));

const { POST: importRoute } = await loadRoute("portable-archives/import");
const passphrase = "correct-horse-battery-staple";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

afterEach(() => {
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;

async function stage(fixture: Fixture, session: Session) {
  const documentId = randomUUID();
  const body = syntheticPdf(`staged ${documentId}`);
  const { POST } = await loadRoute("households/[householdId]/documents");
  const response = await callRouteForSession(POST, session, {
    url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/documents`,
    method: "POST",
    headers: {
      "content-length": String(body.length),
      "content-type": "application/pdf",
      "x-orbit-filename": encodeURIComponent("policy.pdf"),
      "x-orbit-document-id": documentId,
      "x-orbit-item-id": randomUUID(),
    },
    body: new Uint8Array(body),
    params: { householdId: fixture.household.id },
  });
  return { response, documentId };
}

async function stageMany(fixture: Fixture, session: Session, count: number) {
  for (let n = 0; n < count; n += 1) expect((await stage(fixture, session)).response.status).toBe(201);
}

async function receiptWithAttachment(fixture: Fixture, label: string, uid: number) {
  const receiptId = randomUUID();
  const held = await holdAttachmentBytes({ bytes: syntheticPdf(label), displayName: `${label}.pdf`, mediaType: "application/pdf", recipientUserId: fixture.users.member.id, receiptId });
  await getDb().insert(imapIngestionMessages).values({
    id: receiptId, mailbox: "private", mailboxUidValidity: label, mailboxUid: uid,
    recipientAliasSha256: label, userId: fixture.users.member.id, householdId: fixture.household.id,
    status: "pending_review", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
  });
  await getDb().insert(imapIngestionAttachments).values({
    id: held.id, messageId: receiptId, displayName: held.displayName, mediaType: held.mediaType, sizeBytes: held.sizeBytes,
    ...await sealedHash(receiptId, held.id, held.contentSha256), storageKey: held.storageKey, ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored",
  });
  return {
    attachmentId: held.id,
    input: {
      operationId: randomUUID(),
      source: { kind: "mailbox_draft" as const, receiptId, draftVersion: 1 },
      householdId: fixture.household.id,
      sectionId: fixture.section.id,
      action: "attach_existing" as const,
      targetItemId: fixture.item.id,
      item: { title: `${label} value`, currency: "GBP", status: "active" },
      attachmentIds: [held.id],
    },
  };
}

describe("system staging is outside the staged-upload cap (#1605 P-1, #1904)", () => {
  it("an archive import of 101 documents succeeds", async () => {
    // Catches uploadItemDocument's cap firing on the import's own staged: true uploads:
    // the 101st document gets 429 document_staged_limit and the import fails.
    const source = await createIntegrationFixture("cap-sys-import-source");
    const target = await createIntegrationFixture("cap-sys-import-target");
    const contents = Array.from({ length: 101 }, (_, n) => syntheticPdf(`archive document ${n}`));
    await seedStoredDocuments(source, contents);
    const archive = await createPortableArchive({ userId: source.users.owner.id, householdId: source.household.id, passphrase, includeDocuments: true });
    const file = Buffer.from((await readPortableArchive(source.users.owner.id, archive.id)).bytes);

    const targetOwner = await target.session("owner");
    const imported = await postForm(
      importRoute, "/api/portable-archives/import", targetOwner,
      archiveForm({ householdId: target.household.id, passphrase, conflictItemIds: [] }, file),
      await proofCookie(targetOwner, "archive_import"),
    );
    const answer = imported.status === 200 ? null : await imported.clone().text();
    expect(imported.status, answer ?? "").toBe(200);
    const bound = await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, target.household.id));
    expect(bound.length, "every document was restored").toBeGreaterThanOrEqual(101);
  }, 600_000);

  it("approving mail succeeds while the member has 100 direct uploads waiting", async () => {
    // Catches the cap firing on the approval's staged copy of the attachment: 429 document_staged_limit.
    const fixture = await createIntegrationFixture("cap-sys-mail");
    const member = await fixture.session("member");
    await stageMany(fixture, member, 100);
    const { attachmentId, input } = await receiptWithAttachment(fixture, "cap sys mail", 1605001);

    const outcome = await approveReviewedIntake(fixture.users.member.id, input);
    expect(outcome.attachedAttachmentIds).toContain(attachmentId);
  }, 300_000);

  it("a member's 101st direct upload is still refused with 429", async () => {
    // Control: passes now and must keep passing, so the fix cannot drop the cap.
    const fixture = await createIntegrationFixture("cap-sys-direct");
    const member = await fixture.session("member");
    await stageMany(fixture, member, 100);

    const refused = await stage(fixture, member);
    expect(refused.response.status).toBe(429);
    expect(await refused.response.json()).toMatchObject({ error: { code: "document_staged_limit" } });
  }, 300_000);
});
