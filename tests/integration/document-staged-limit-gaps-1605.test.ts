import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documents } from "@/db/schema";
import { requestDocumentDeletion, restoreDocument } from "@/server/document-repository";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { syntheticPdf as createSyntheticPdf } from "../support/synthetic-documents";

/* #1605 P-1 review gaps. (1) Uploads still being checked ('quarantined',
   'scanning') are outstanding too: counting only 'available' lets a member
   past the cap by sending in parallel. (2) Restoring a never-bound staged
   upload makes it outstanding again, so it meets the same cap. */

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

describe("the staged-upload cap, review gaps (P-1)", () => {
  it.each(["quarantined", "scanning"] as const)("counts an upload still '%s' towards the 100: 99 available plus one of those refuses the next", async (lifecycle) => {
    const fixture = await createIntegrationFixture(`staged-cap-${lifecycle}`);
    const member = await fixture.session("member");
    const ids = await stageMany(fixture, member, 100);
    await getDb().update(documents).set({ lifecycle }).where(eq(documents.id, ids[0]));

    const refused = await stage(fixture, member);
    expect(refused.response.status).toBe(429);
    expect(await refused.response.json()).toMatchObject({ error: { code: "document_staged_limit" } });
  }, 300_000);

  it("refuses to restore a never-bound staged upload with 429 document_staged_limit while 100 others wait", async () => {
    const fixture = await createIntegrationFixture("staged-cap-restore");
    const member = await fixture.session("member");
    const ids = await stageMany(fixture, member, 100);
    await requestDocumentDeletion(member.userId, ids[0]);
    expect((await stage(fixture, member)).response.status).toBe(201);

    await expect(restoreDocument(member.userId, ids[0])).rejects.toMatchObject({ code: "document_staged_limit", status: 429 });
  }, 300_000);
});
