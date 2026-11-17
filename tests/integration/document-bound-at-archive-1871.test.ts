import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documents } from "@/db/schema";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import * as repository from "@/server/portable-archive-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { archiveForm } from "./support/portable-archive-upload";
import { postForm, proofCookie } from "./support/portable-archive-routes";
import { loadRoute } from "./support/request-event";
import { seedStoredDocuments } from "./support/stored-documents";
import { syntheticPdf } from "../support/synthetic-documents";

/* #1871: export -> import round trip. The import stages each document and
   binds it at the switch, which must set bound_at (and clear delete_after).
   No imported document may be left with bound_at null: a restore of it would
   later give it a staged hold the sweep acts on. The format stays v2. */

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));

const passphrase = "correct-horse-battery-staple";
const { POST: importRoute } = await loadRoute("portable-archives/import");

beforeEach(() => {
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

describe("a v2 archive round trip leaves every imported document bound (#1871)", () => {
  it("imported documents carry bound_at about the switch time and no delete_after", async () => {
    // Catches an import switch that clears delete_after but not bound_at: imported papers would look like unclaimed uploads.
    const source = await createIntegrationFixture("b1871-arch-source");
    const target = await createIntegrationFixture("b1871-arch-target");
    await seedStoredDocuments(source, [syntheticPdf("b1871 archive 0"), syntheticPdf("b1871 archive 1")]);
    await getDb().delete(documents).where(eq(documents.householdId, target.household.id));
    const archive = await repository.createPortableArchive({ userId: source.users.owner.id, householdId: source.household.id, passphrase, includeDocuments: true });
    const file = Buffer.from((await repository.readPortableArchive(source.users.owner.id, archive.id)).bytes);
    expect(file.subarray(0, 8).toString("latin1"), "the format stays v2").toBe("ORBITARC");

    const before = Date.now() - 2_000;
    const owner = await target.session("owner");
    const response = await postForm(importRoute, "/api/portable-archives/import", owner,
      archiveForm({ householdId: target.household.id, passphrase, conflictItemIds: [] }, file), await proofCookie(owner, "archive_import"));
    expect(response.status).toBe(200);

    const rows = await getDb().execute(sql`
      select item_id, bound_at, delete_after from documents where household_id = ${target.household.id}`) as unknown as
      Array<{ item_id: string | null; bound_at: Date | null; delete_after: Date | null }>;
    expect(rows, "the import brought both documents across").toHaveLength(2);
    for (const imported of rows) {
      expect(imported.item_id).not.toBeNull();
      expect(imported.delete_after).toBeNull();
      expect(imported.bound_at, "bound at the switch").not.toBeNull();
      expect(new Date(imported.bound_at!).getTime()).toBeGreaterThanOrEqual(before);
      expect(new Date(imported.bound_at!).getTime()).toBeLessThanOrEqual(Date.now() + 2_000);
    }
  });
});
