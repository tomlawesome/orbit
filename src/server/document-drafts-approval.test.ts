import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/app-error";

/**
 * Covers two A2 audit findings in `approveDocumentDraft`'s merge path:
 *
 * - A2-F1: the edited title is validated but never written to the item.
 * - SR1-R1: the document-to-item link is rewritten with no check that the
 *   document is still `available`, racing a concurrent deletion.
 *
 * A fake `@/db` lets these be proved as pure call-ordering/data facts,
 * without a real database (out of scope here), following the pattern in
 * `document-content-boundary.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  selectQueues: new Map<string, unknown[][]>(),
  updateReturningQueues: new Map<string, unknown[][]>(),
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  insertCalls: [] as Array<{ table: string; values: unknown }>,
  requireMetadataWriter: vi.fn(),
}));

function queue(map: Map<string, unknown[][]>, table: string, rows: unknown[]) {
  const existing = map.get(table) ?? [];
  existing.push(rows);
  map.set(table, existing);
}

function nextRows(map: Map<string, unknown[][]>, table: string): unknown[] {
  const list = map.get(table);
  if (!list || list.length === 0) return [];
  return list.shift()!;
}

vi.mock("@/db", async () => {
  const { getTableName } = await import("drizzle-orm");

  function selectBuilder() {
    let table = "";
    const chain: Record<string, unknown> = {
      from(t: unknown) {
        table = getTableName(t as never);
        return chain;
      },
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      limit: () => chain,
      then: (resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(nextRows(mocks.selectQueues, table)).then(resolve, reject),
    };
    return chain;
  }

  function updateBuilder(table: string) {
    let values: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {
      set(v: Record<string, unknown>) {
        values = v;
        return chain;
      },
      where: () => chain,
      returning: () => {
        mocks.updateCalls.push({ table, values });
        return Promise.resolve(nextRows(mocks.updateReturningQueues, table));
      },
      then: (resolve: (value: undefined) => unknown, reject?: (reason: unknown) => unknown) => {
        mocks.updateCalls.push({ table, values });
        return Promise.resolve(undefined).then(resolve, reject);
      },
    };
    return chain;
  }

  function insertBuilder(table: string) {
    return {
      values: (v: unknown) => {
        mocks.insertCalls.push({ table, values: v });
        return Promise.resolve();
      },
    };
  }

  const fakeDb: Record<string, unknown> = {
    select: () => selectBuilder(),
    update: (t: unknown) => updateBuilder(getTableName(t as never)),
    insert: (t: unknown) => insertBuilder(getTableName(t as never)),
    transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
  };

  return { getDb: () => fakeDb };
});

vi.mock("@/server/workspace-access", () => ({
  acquireActiveHouseholdLock: vi.fn(async () => undefined),
  validUuid: (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value),
}));

vi.mock("@/server/metadata/fields", () => ({
  requireMetadataWriter: mocks.requireMetadataWriter,
  openMetadataReader: vi.fn(),
}));

vi.mock("@/server/documents/config", () => ({
  getDocumentConfig: () => ({ scanMode: "disabled" }),
}));

vi.mock("@/server/document-repository", () => ({
  isDocumentContentReady: () => true,
  readDocumentDownload: vi.fn(),
}));

vi.mock("@/server/documents/tika", () => ({ extractTextWithTika: vi.fn() }));

const { approveDocumentDraft } = await import("./document-drafts");

const userId = "11111111-1111-1111-1111-111111111111";
const draftId = "22222222-2222-2222-2222-222222222222";
const documentId = "33333333-3333-3333-3333-333333333333";
const sectionId = "44444444-4444-4444-4444-444444444444";
const itemId = "55555555-5555-5555-5555-555555555555";
const householdId = "66666666-6666-6666-6666-666666666666";

function seedHappyPath() {
  queue(mocks.selectQueues, "document_drafts", [{ id: draftId, documentId, status: "pending_review" }]);
  queue(mocks.selectQueues, "documents", [{
    id: documentId,
    householdId,
    displayName: "old-name.pdf",
    mediaType: "application/pdf",
    lifecycle: "available",
    scanStatus: "clean",
    administrator: false,
    member: userId,
  }]);
  queue(mocks.selectQueues, "sections", [{ id: sectionId }]);
  queue(mocks.selectQueues, "households", [{ currency: "GBP" }]);
  queue(mocks.selectQueues, "items", [{ id: itemId }]);
  // The in-transaction re-check that the draft is still pending review.
  queue(mocks.selectQueues, "document_drafts", [{ id: draftId }]);
}

beforeEach(() => {
  mocks.selectQueues.clear();
  mocks.updateReturningQueues.clear();
  mocks.updateCalls.length = 0;
  mocks.insertCalls.length = 0;
  mocks.requireMetadataWriter.mockReset();
  mocks.requireMetadataWriter.mockResolvedValue({
    encryptText: () => Buffer.from("enc"),
    encryptNumber: () => Buffer.from("enc"),
    referenceIndex: () => "idx",
  });
});

describe("approveDocumentDraft merge mode (#1151 A2-F1, SR1-R1)", () => {
  it("writes the edited title to the item, not just the provider and reference (A2-F1)", async () => {
    seedHappyPath();
    queue(mocks.updateReturningQueues, "documents", [{ id: documentId }]);
    queue(mocks.updateReturningQueues, "document_drafts", [{ id: draftId }]);

    const result = await approveDocumentDraft(
      userId,
      draftId,
      sectionId,
      { title: "New Title", provider: "Acme", reference: "AB-123" },
      "merge",
      itemId,
    );

    expect(result).toEqual({ itemId });
    const itemUpdate = mocks.updateCalls.find((call) => call.table === "items");
    expect(itemUpdate?.values.title).toBe("New Title");
  });

  it("refuses to relink a document that is no longer available, rather than resurrecting it (SR1-R1)", async () => {
    seedHappyPath();
    // The document was concurrently deleted: the conditional update matches
    // no row.
    queue(mocks.updateReturningQueues, "documents", []);

    let caught: unknown;
    try {
      await approveDocumentDraft(
        userId,
        draftId,
        sectionId,
        { title: "New Title", provider: "Acme", reference: "AB-123" },
        "merge",
        itemId,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("document_not_found");
    // The draft must not have been approved once the link failed.
    const draftApproval = mocks.updateCalls.find((call) => call.table === "document_drafts" && call.values.status === "approved");
    expect(draftApproval).toBeUndefined();
  });
});
