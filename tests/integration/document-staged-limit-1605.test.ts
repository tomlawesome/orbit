import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { requestDocumentDeletion, STAGED_UPLOADS_PER_MEMBER_LIMIT } from "@/server/document-repository";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { syntheticPdf as createSyntheticPdf } from "../support/synthetic-documents";

/* #1605 P-1 (from #1426): nothing limited how many files one member could
   stage. Ruling: at most 100 outstanding staged uploads per member (available,
   no item), counted under the household quota lock, refused with 429
   `document_staged_limit`. */

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
/* #1915 W-S1: said from the constant, and never tells the member to delete.
   #1943 A-F1/A-F3: the wait is the configured hold (default 24 h = 1 day), not a fixed "a day". */
const WORDS = `You already have ${STAGED_UPLOADS_PER_MEMBER_LIMIT} uploads waiting to be attached to an item. Add the item they belong to, or wait up to 1 day and they are cleared`;

async function stage(fixture: Fixture, session: Session, documentId = randomUUID()) {
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

describe("a member's outstanding staged uploads are capped (P-1)", () => {
  it("exports the cap as 100", () => {
    expect(STAGED_UPLOADS_PER_MEMBER_LIMIT).toBe(100);
  });

  it("refuses the 101st with 429 document_staged_limit and the exact words, leaves other members alone, and frees a slot when one is discarded", async () => {
    const fixture = await createIntegrationFixture("staged-cap");
    const member = await fixture.session("member");
    const owner = await fixture.session("owner");
    const kept: string[] = [];
    for (let count = 0; count < 100; count += 1) {
      const { response, documentId } = await stage(fixture, member);
      expect(response.status).toBe(201);
      kept.push(documentId);
    }

    const refused = await stage(fixture, member);
    expect(refused.response.status).toBe(429);
    expect(await refused.response.json()).toMatchObject({ error: { code: "document_staged_limit", message: WORDS } });

    // The cap is per member, not per household.
    expect((await stage(fixture, owner)).response.status).toBe(201);

    // A discarded copy no longer counts.
    await requestDocumentDeletion(member.userId, kept[0], { stagedDiscard: true });
    expect((await stage(fixture, member)).response.status).toBe(201);
  }, 300_000);
});
