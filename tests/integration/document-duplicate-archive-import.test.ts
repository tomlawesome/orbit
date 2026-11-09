import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documents } from "@/db/schema";
import { createPortableArchive, readPortableArchive } from "@/server/portable-archive-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { archiveForm } from "./support/portable-archive-upload";
import { postForm, proofCookie } from "./support/portable-archive-routes";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { seedStoredDocuments } from "./support/stored-documents";
import { syntheticPdf } from "../support/synthetic-documents";

/* #1437, detection note decision 1: a portable-archive import restores every
   document through the ordinary upload path, and "import raises no duplicate
   alert (a restore is expected to re-create what the household holds)". Here
   the target household already holds the very file the archive restores. The
   restored copy is stored with its own fingerprint, and no upload made on the
   import's behalf reports an `alreadyHeld`. */

vi.mock("@/server/document-repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/document-repository")>();
  return { ...actual, uploadItemDocument: vi.fn(actual.uploadItemDocument) };
});

const { uploadItemDocument } = await import("@/server/document-repository");
const { POST: importRoute } = await loadRoute("portable-archives/import");
const { POST: attachToItem } = await loadRoute("households/[householdId]/items/[itemId]/documents");
const passphrase = "correct-horse-battery-staple";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

describe("an archive import raises no duplicate alert (#1437)", () => {
  it("restores a file the household already holds without an alert, and stores it with its fingerprint", async () => {
    const source = await createIntegrationFixture("dup-import-source");
    const target = await createIntegrationFixture("dup-import-target");
    const bytes = syntheticPdf("duplicate test archive import");
    await seedStoredDocuments(source, [bytes]);

    const targetOwner = await target.session("owner");
    const held = randomUUID();
    const attached = await callRouteForSession(attachToItem, targetOwner, {
      url: `http://127.0.0.1:3000/api/households/${target.household.id}/items/${target.item.id}/documents`,
      method: "POST",
      headers: {
        "content-length": String(bytes.length),
        "content-type": "application/pdf",
        "x-orbit-filename": encodeURIComponent("already here.pdf"),
        "x-orbit-document-id": held,
      },
      body: new Uint8Array(bytes),
      params: { householdId: target.household.id, itemId: target.item.id },
    });
    expect(attached.status).toBe(201);

    const archive = await createPortableArchive({ userId: source.users.owner.id, householdId: source.household.id, passphrase, includeDocuments: true });
    const file = Buffer.from((await readPortableArchive(source.users.owner.id, archive.id)).bytes);

    const callsBefore = vi.mocked(uploadItemDocument).mock.results.length;
    const imported = await postForm(
      importRoute, "/api/portable-archives/import", targetOwner,
      archiveForm({ householdId: target.household.id, passphrase, conflictItemIds: [] }, file),
      await proofCookie(targetOwner, "archive_import"),
    );
    expect(imported.status).toBe(200);

    const restored = await Promise.all(vi.mocked(uploadItemDocument).mock.results.slice(callsBefore).map((one) => one.value));
    expect(restored.length, "the import restored the document through the upload path").toBeGreaterThan(0);
    for (const summary of restored) expect((summary as { alreadyHeld?: unknown }).alreadyHeld ?? null).toBeNull();

    const sha = createHash("sha256").update(bytes).digest("hex");
    const rows = await getDb().execute(sql`
      select id, content_index from documents where household_id = ${target.household.id} and content_sha256 = ${sha} and item_id is not null`);
    expect(rows.length).toBe(2);
    const indexes = (rows as unknown as Array<{ content_index: string | null }>).map((row) => row.content_index);
    expect(indexes.every((value) => value !== null)).toBe(true);
    expect(new Set(indexes).size, "the restored copy has the household's own value, equal to the held one").toBe(1);
    expect(await getDb().select({ id: documents.id }).from(documents).where(eq(documents.id, held))).toHaveLength(1);
  }, 300_000);
});
