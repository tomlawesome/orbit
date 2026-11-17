import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documentCrypto, documentJobs, documents } from "@/db/schema";
import { runDocumentMaintenanceCycle } from "@/server/document-worker";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

/* #1605 P-1, ruled 2026-11-17: the retention purge claimed 25 expired
   documents a cycle (one cycle a minute), so a large deletion queued behind
   itself for hours. Each cycle now drains the whole backlog in batches of 25
   until it is empty, paging by job id. In a storage outage the first failed
   purge ends the cycle (a circuit breaker), so the outage costs one attempt a
   cycle rather than one per job. */

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  pingClamAv: vi.fn(async () => true),
}));

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Seeds `count` documents past their retention, each with its purge job. */
async function seedExpiredPurges(label: string, count: number): Promise<string[]> {
  const fixture = await createIntegrationFixture(label);
  const db = getDb();
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    ids.push(id);
    const [row] = await db.insert(documents).values({
      id,
      householdId: fixture.household.id,
      itemId: fixture.item.id,
      displayName: `expired-${index}.pdf`,
      mediaType: "application/pdf",
      sizeBytes: 10,
      lifecycle: "pending_deletion",
      scanStatus: "clean",
      deleteAfter: new Date(Date.now() - 60_000),
    }).returning({ version: documents.version });
    await db.insert(documentCrypto).values({
      documentId: id,
      storageKey: randomBytes(32).toString("hex"),
      ciphertextSize: 10,
      envelopeVersion: 1,
      contentIv: "iv",
      contentAuthTag: "tag",
      wrappedDek: "dek",
      wrapIv: "iv",
      wrapAuthTag: "tag",
      keyId: "key",
    });
    await db.insert(documentJobs).values({ documentId: id, kind: "purge", generation: row!.version });
  }
  return ids;
}

describe("the retention purge drains its backlog each cycle (#1605 P-1)", () => {
  it("purges every expired document in one cycle, well past one batch of 25", async () => {
    vi.spyOn(LocalDocumentStorage.prototype, "deleteCiphertext").mockResolvedValue(undefined);
    vi.spyOn(LocalDocumentStorage.prototype, "deletePreviewCiphertext").mockResolvedValue(undefined);
    const ids = await seedExpiredPurges("p1-drain", 60);

    await runDocumentMaintenanceCycle();

    const rows = await getDb().select({ lifecycle: documents.lifecycle }).from(documents).where(inArray(documents.id, ids));
    expect(rows).toHaveLength(60);
    expect(rows.filter((row) => row.lifecycle !== "deleted")).toEqual([]);
  });

  it("in a storage outage spends one attempt a cycle, not one per job, and holds no other claim", async () => {
    vi.spyOn(LocalDocumentStorage.prototype, "deleteCiphertext").mockRejectedValue(new Error("storage outage"));
    vi.spyOn(LocalDocumentStorage.prototype, "deletePreviewCiphertext").mockResolvedValue(undefined);
    const ids = await seedExpiredPurges("p1-drain-outage", 30);

    await runDocumentMaintenanceCycle();

    const jobs = await getDb().select({ status: documentJobs.status, attempts: documentJobs.attempts, leaseToken: documentJobs.leaseToken })
      .from(documentJobs).where(and(inArray(documentJobs.documentId, ids), eq(documentJobs.kind, "purge")));
    expect(jobs).toHaveLength(30);
    // The first failure stops the cycle (a circuit breaker): one purge tried and failed ...
    expect(jobs.filter((job) => job.attempts > 0)).toEqual([{ status: "retry", attempts: 1, leaseToken: null }]);
    // ... and every other one is as it was: unclaimed, its attempts untouched.
    expect(jobs.filter((job) => job.attempts === 0 && job.status === "pending" && job.leaseToken === null)).toHaveLength(29);
  });

});
