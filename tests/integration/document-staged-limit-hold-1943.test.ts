import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documents } from "@/db/schema";
import { requestDocumentDeletion, STAGED_UPLOADS_PER_MEMBER_LIMIT } from "@/server/document-repository";
import { resetDocumentConfigForTests } from "@/server/documents/config";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { syntheticPdf as createSyntheticPdf } from "../support/synthetic-documents";

/* #1943 A-F1 + A-F3: both staged-limit refusals (create at upload, restore of a
   discarded staged upload) state the configured hold, stagedUploadHoldMs =
   max(24, DOCUMENT_SCAN_RECOVERY_RETENTION_HOURS) hours, in days, not "a day". */

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

const words = (wait: string) => `You already have ${STAGED_UPLOADS_PER_MEMBER_LIMIT} uploads waiting to be attached to an item. Add the item they belong to, or wait up to ${wait} and they are cleared`;

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

/** Outstanding staged rows counted by the cap, put in directly so the test does not upload 100 files. */
async function seedStaged(fixture: Fixture, userId: string, count: number) {
  await getDb().insert(documents).values(Array.from({ length: count }, () => ({
    id: randomUUID(),
    householdId: fixture.household.id,
    itemId: null,
    sealedItemId: randomUUID(),
    uploadedByUserId: userId,
    displayName: "seeded.pdf",
    mediaType: "application/pdf",
    sizeBytes: 10,
    contentSha256: "0".repeat(64),
    lifecycle: "available" as const,
    scanStatus: "clean" as const,
  })));
}

async function withRetentionHours<T>(hours: string, work: () => Promise<T>): Promise<T> {
  const previous = process.env.DOCUMENT_SCAN_RECOVERY_RETENTION_HOURS;
  process.env.DOCUMENT_SCAN_RECOVERY_RETENTION_HOURS = hours;
  resetDocumentConfigForTests();
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.DOCUMENT_SCAN_RECOVERY_RETENTION_HOURS;
    else process.env.DOCUMENT_SCAN_RECOVERY_RETENTION_HOURS = previous;
    resetDocumentConfigForTests();
  }
}

describe("the staged-limit refusals say the configured hold (#1943 A-F1, A-F3)", () => {
  for (const [hours, wait] of [["24", "1 day"], ["168", "7 days"]] as const) {
    it(`with ${hours} recovery hours, create and restore both say "wait up to ${wait}"`, async () => {
      await withRetentionHours(hours, async () => {
        const fixture = await createIntegrationFixture(`staged-hold-${hours}`);
        const member = await fixture.session("member");
        const first = await stage(fixture, member);
        expect(first.response.status).toBe(201);
        await seedStaged(fixture, member.userId, STAGED_UPLOADS_PER_MEMBER_LIMIT - 1);

        // A-F3: the create path.
        const refused = await stage(fixture, member);
        expect(refused.response.status).toBe(429);
        expect(await refused.response.json()).toMatchObject({ error: { code: "document_staged_limit", message: words(wait) } });

        // A-F1: the restore path. Delete the first copy (kept for the retention window), refill the slot, restore it.
        await requestDocumentDeletion(member.userId, first.documentId);
        await seedStaged(fixture, member.userId, 1);
        const { POST: restore } = await loadRoute("documents/[documentId]/restore");
        const restored = await callRouteForSession(restore, member, {
          url: `http://127.0.0.1:3000/api/documents/${first.documentId}/restore`,
          method: "POST",
          params: { documentId: first.documentId },
        });
        expect(restored.status).toBe(429);
        expect(await restored.json()).toMatchObject({ error: { code: "document_staged_limit", message: words(wait) } });
      });
    }, 120_000);
  }
});
