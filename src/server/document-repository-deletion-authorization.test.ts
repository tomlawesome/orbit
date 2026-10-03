import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/app-error";

/**
 * #1151 A3-S1 (owner decision 2026-10-03, option a): `canAccessHouseholdDocuments`
 * takes no role, so `requestDocumentDeletion`/`restoreDocument` previously let
 * any ordinary household member queue another member's document for purge, or
 * undo someone else's deletion. Only the household owner or the member who
 * uploaded the document may do either now.
 *
 * A fake `@/db` exercises the real function bodies, including the real
 * `@/server/documents/authorization` module, rather than a real database.
 */

const mocks = vi.hoisted(() => ({
  selectQueues: new Map<string, unknown[][]>(),
  updateReturningQueues: new Map<string, unknown[][]>(),
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  insertCalls: [] as Array<{ table: string; values: unknown }>,
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
      orderBy: () => chain,
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
        return {
          onConflictDoNothing: () => Promise.resolve(),
          then: (resolve: (value: undefined) => unknown) => Promise.resolve(undefined).then(resolve),
        };
      },
    };
  }

  const fakeDb: Record<string, unknown> = {
    select: () => selectBuilder(),
    update: (t: unknown) => updateBuilder(getTableName(t as never)),
    insert: (t: unknown) => insertBuilder(getTableName(t as never)),
    execute: async () => undefined,
    transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
  };

  return { getDb: () => fakeDb };
});

vi.mock("@/server/documents/config", () => ({
  getDocumentConfig: () => ({
    storageRoot: "/private/documents",
    quarantineRoot: "/private/quarantine",
    maxBytes: 25 * 1_048_576,
    householdQuotaBytes: 1_000_000_000,
    instanceQuotaBytes: 1_000_000_000,
    retentionDays: 30,
    scanMode: "disabled" as const,
  }),
  wrappingKey: () => ({ keyEncryptionKey: Buffer.alloc(32, 1), keyId: "key-1" }),
  keyEncryptionKeyFor: () => Buffer.alloc(32, 1),
}));

const { requestDocumentDeletion, restoreDocument } = await import("./document-repository");

const ownerUserId = "39a5fac9-38cb-4178-b68a-a8d8db97ed3b";
const uploaderUserId = "6d9a6a01-9b0f-4a44-9f2c-1a9c7b9d5a01";
const otherMemberUserId = "c3f6a9a0-3f0e-4f3b-9b3a-2a1d8e7c6b02";
const documentId = "26f04310-3f96-4828-94b2-f2fc693bc89e";
const householdId = "66a1f3d8-b79d-47a5-92fe-a4824270aa9a";
const itemId = "6f1c9e2a-7b3d-4c1a-8b2e-9d0a1f2b3c4d";

function seedDocumentRecord(opts: {
  callerIsAdministrator: boolean;
  callerMembershipRole: "owner" | "member" | null;
  lifecycle: string;
  scanStatus?: string;
  deleteAfter?: Date | null;
}) {
  queue(mocks.selectQueues, "users", [{
    id: documentId,
    householdId,
    itemId,
    displayName: "bill.pdf",
    mediaType: "application/pdf",
    sizeBytes: 5,
    lifecycle: opts.lifecycle,
    scanStatus: opts.scanStatus ?? "clean",
    contentSha256: "hash",
    deleteAfter: opts.deleteAfter ?? null,
    availableAt: new Date(),
    uploadedByUserId: uploaderUserId,
    administrator: opts.callerIsAdministrator,
    membershipUserId: opts.callerMembershipRole ? "self" : "self",
    membershipRole: opts.callerMembershipRole,
  }]);
}

beforeEach(() => {
  mocks.selectQueues.clear();
  mocks.updateReturningQueues.clear();
  mocks.updateCalls.length = 0;
  mocks.insertCalls.length = 0;
});

describe("requestDocumentDeletion authorization (#1151 A3-S1)", () => {
  it("refuses an ordinary member who did not upload the document", async () => {
    seedDocumentRecord({ callerIsAdministrator: false, callerMembershipRole: "member", lifecycle: "available" });

    let caught: unknown;
    try {
      await requestDocumentDeletion(otherMemberUserId, documentId);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("document_deletion_forbidden");
    expect((caught as AppError).status).toBe(403);
    // The forbidden caller must never reach the lifecycle update.
    expect(mocks.updateCalls.some((call) => call.table === "documents")).toBe(false);
  });

  it("allows the member who uploaded the document", async () => {
    seedDocumentRecord({ callerIsAdministrator: false, callerMembershipRole: "member", lifecycle: "available" });
    queue(mocks.updateReturningQueues, "documents", [{
      id: documentId,
      itemId,
      displayName: "bill.pdf",
      mediaType: "application/pdf",
      sizeBytes: 5,
      lifecycle: "pending_deletion",
      scanStatus: "clean",
      availableAt: new Date(),
      deleteAfter: new Date(),
      version: 2,
    }]);

    const result = await requestDocumentDeletion(uploaderUserId, documentId);
    expect(result.lifecycle).toBe("pending_deletion");
  });

  it("allows the household owner even though they did not upload it", async () => {
    seedDocumentRecord({ callerIsAdministrator: false, callerMembershipRole: "owner", lifecycle: "available" });
    queue(mocks.updateReturningQueues, "documents", [{
      id: documentId,
      itemId,
      displayName: "bill.pdf",
      mediaType: "application/pdf",
      sizeBytes: 5,
      lifecycle: "pending_deletion",
      scanStatus: "clean",
      availableAt: new Date(),
      deleteAfter: new Date(),
      version: 2,
    }]);

    const result = await requestDocumentDeletion(ownerUserId, documentId);
    expect(result.lifecycle).toBe("pending_deletion");
  });
});

describe("restoreDocument authorization (#1151 A3-S1)", () => {
  it("refuses an ordinary member who did not upload the document", async () => {
    seedDocumentRecord({
      callerIsAdministrator: false,
      callerMembershipRole: "member",
      lifecycle: "pending_deletion",
      deleteAfter: new Date(Date.now() + 86_400_000),
    });

    let caught: unknown;
    try {
      await restoreDocument(otherMemberUserId, documentId);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("document_deletion_forbidden");
    expect((caught as AppError).status).toBe(403);
    expect(mocks.updateCalls.some((call) => call.table === "documents")).toBe(false);
  });
});
