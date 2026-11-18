import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documents } from "@/db/schema";
import { requestDocumentDeletion, restoreDocument } from "@/server/document-repository";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { syntheticPdf as createSyntheticPdf } from "../support/synthetic-documents";

/* #1904: the per-member staged-upload cap (100, #1605 P-1) and the restore gate
   count only documents unbound by #1871's rule (bound_at null). A kept document
   whose item was deleted (item_id null, bound_at set) is not a staged upload. */

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

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;

async function stage(fixture: Fixture, session: Session) {
  const documentId = randomUUID();
  const body = createSyntheticPdf(`staged ${documentId}`);
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
  const ids: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const { response, documentId } = await stage(fixture, session);
    expect(response.status).toBe(201);
    ids.push(documentId);
  }
  return ids;
}

/* A kept document whose item was deleted: item_id null (the foreign key), bound_at set. */
async function stageKeptOrphan(fixture: Fixture, session: Session) {
  const { response, documentId } = await stage(fixture, session);
  expect(response.status).toBe(201);
  await getDb().execute(sql`update documents set bound_at = now() - interval '1 day', delete_after = null where id = ${documentId}`);
  const [state] = await getDb().select({ itemId: documents.itemId }).from(documents).where(eq(documents.id, documentId));
  expect(state.itemId).toBeNull();
  return documentId;
}

describe("the staged cap ignores kept documents bound before their item was deleted (#1904)", () => {
  it("restores a kept orphan while 100 unbound uploads wait", async () => {
    // Catches the restore gate counting by item_id alone: it refuses with 429 document_staged_limit.
    const fixture = await createIntegrationFixture("cap1904-restore");
    const member = await fixture.session("member");
    const kept = await stageKeptOrphan(fixture, member);
    await requestDocumentDeletion(member.userId, kept);
    await stageMany(fixture, member, 100);

    await expect(restoreDocument(member.userId, kept)).resolves.toBeDefined();
    const [state] = await getDb().select({ lifecycle: documents.lifecycle }).from(documents).where(eq(documents.id, kept));
    expect(state.lifecycle).toBe("available");
  }, 300_000);

  it("does not count a kept orphan towards the cap, before or after its restore", async () => {
    // Catches the cap query counting an orphan: the 100th plain upload is refused (before), and
    // after the restore a freed slot is still refused (after).
    const fixture = await createIntegrationFixture("cap1904-count");
    const member = await fixture.session("member");
    const kept = await stageKeptOrphan(fixture, member);
    const ids = await stageMany(fixture, member, 100); // before: 100 unbound plus the orphan all fit

    await requestDocumentDeletion(member.userId, kept);
    await getDb().execute(sql`update documents set lifecycle = 'pending_deletion' where id = ${ids[0]}`);
    await restoreDocument(member.userId, kept); // after: orphan back, 99 unbound waiting
    const next = await stage(fixture, member);
    expect(next.response.status).toBe(201);
  }, 300_000);

  it("still counts a plain unbound staged upload: the 101st is refused with 429", async () => {
    // Control: passes now and must keep passing, so the fix cannot simply drop the cap.
    const fixture = await createIntegrationFixture("cap1904-plain");
    const member = await fixture.session("member");
    await stageMany(fixture, member, 100);

    const refused = await stage(fixture, member);
    expect(refused.response.status).toBe(429);
    expect(await refused.response.json()).toMatchObject({ error: { code: "document_staged_limit" } });
  }, 300_000);
});
