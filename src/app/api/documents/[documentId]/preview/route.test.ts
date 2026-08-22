import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "@/lib/env";
import { syntheticPdf } from "../../../../../../tests/support/synthetic-documents";

/**
 * The page-one preview endpoint's contract (#476).
 *
 * Only the database, the auth config, the document configuration, object
 * storage and the decryption primitive are stubbed: the session is read
 * through the real `readSession`, authorization through the real
 * `readDocumentDownload` path, and the image through the real renderer — so
 * these tests pin the endpoint's own behaviour rather than a rehearsal of it.
 */

const config: AuthConfig = {
  appUrl: new URL("https://orbit.example"),
  sessionSecret: "document-preview-route-session-secret-that-is-long-enough",
  sessionTtlSeconds: 3600,
  issuer: "https://issuer.preview.example.invalid/",
  clientId: "preview-client",
  clientSecret: "preview-client-secret",
  callbackUrl: "https://orbit.example/api/auth/callback",
  scopes: "openid profile email",
  claims: { email: "email", emailVerified: "email_verified", name: "name", avatar: "picture" },
  secureCookies: true,
};

const mocks = vi.hoisted(() => ({
  rows: {} as Record<string, unknown[]>,
  deleted: 0,
  documentConfig: vi.fn(),
  readCiphertext: vi.fn(),
  decryptDocument: vi.fn(),
}));

vi.mock("@/db", async () => {
  const { getTableName } = await import("drizzle-orm");

  function makeSelectBuilder() {
    let rows: unknown[] = [];
    const builder: PromiseLike<unknown[]> & Record<string, unknown> = {
      from(table: unknown) {
        rows = mocks.rows[getTableName(table as never)] ?? [];
        return builder;
      },
      innerJoin: () => builder,
      leftJoin: () => builder,
      where: () => builder,
      limit: () => builder,
      then: (onFulfilled: (value: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(onFulfilled, onRejected),
    } as never;
    return builder;
  }

  const fakeDb: Record<string, unknown> = {
    select: () => makeSelectBuilder(),
    insert: () => ({ values: () => Promise.resolve() }),
    delete: () => ({ where: () => { mocks.deleted += 1; return Promise.resolve(); } }),
  };

  return { getDb: () => fakeDb };
});

vi.mock("@/lib/env", () => ({ getAuthConfig: () => config }));
vi.mock("@/server/documents/config", () => ({ getDocumentConfig: mocks.documentConfig }));
vi.mock("@/server/documents/crypto", () => ({
  decryptDocument: mocks.decryptDocument,
  encryptDocument: vi.fn(),
}));
vi.mock("@/server/documents/storage", () => ({
  LocalDocumentStorage: class {
    readCiphertext = mocks.readCiphertext;
    ciphertextExists = vi.fn();
  },
}));

import { GET } from "./route";

const READER = "22222222-2222-4222-8222-222222222222";
const DOCUMENT = "11111111-1111-4111-8111-111111111111";
const HOUSEHOLD = "33333333-3333-4333-8333-333333333333";
const ITEM = "44444444-4444-4444-8444-444444444444";
const SESSION_TOKEN = "document-preview-route-session-token";

const documentConfig = {
  storageRoot: "/private/documents",
  quarantineRoot: "/private/quarantine",
  maxBytes: 25 * 1_048_576,
  householdQuotaBytes: 1_000_000,
  instanceQuotaBytes: 1_000_000,
  retentionDays: 30,
  scanRecoveryRetentionHours: 24,
  scanMode: "required" as const,
  clamAv: { host: "clamav", port: 3310, timeoutMs: 30_000 },
  tika: { url: null, timeoutMs: 45_000 },
  keyEncryptionKey: Buffer.alloc(32, 1),
  keyId: "test-key-id",
};

function sessionRow(userId: string) {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    activeHouseholdId: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    userId,
    email: "reader@example.invalid",
    emailVerified: true,
    displayName: "Preview Reader",
    avatarUrl: null,
    isInstanceAdmin: false,
    disabledAt: null,
    themeMode: "dark",
    themeId: "starchart",
    textSize: "comfortable",
    urgencyPalette: "themed",
    emailNotifications: true,
    pushNotifications: true,
  };
}

function accessRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DOCUMENT,
    householdId: HOUSEHOLD,
    itemId: ITEM,
    displayName: "policy.pdf",
    mediaType: "application/pdf",
    sizeBytes: 1024,
    lifecycle: "available",
    scanStatus: "clean",
    contentSha256: "not-returned-to-client",
    deleteAfter: null,
    availableAt: new Date("2026-07-31T12:00:00.000Z"),
    administrator: false,
    membershipUserId: READER,
    ...overrides,
  };
}

function cryptoRow() {
  return {
    documentId: DOCUMENT,
    envelopeVersion: 1,
    keyId: documentConfig.keyId,
    storageKey: "a".repeat(64),
    contentIv: Buffer.alloc(12),
    contentAuthTag: Buffer.alloc(16),
    wrappedDek: Buffer.alloc(32),
    wrapIv: Buffer.alloc(12),
    wrapAuthTag: Buffer.alloc(16),
  };
}

function signedIn(): NextRequest {
  const request = new NextRequest(`http://127.0.0.1:3000/api/documents/${DOCUMENT}/preview`);
  request.cookies.set("__Host-orbit-session", SESSION_TOKEN);
  return request;
}

function previewFor(documentId = DOCUMENT, request = signedIn()) {
  return GET(request, { params: Promise.resolve({ documentId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = {};
  mocks.deleted = 0;
  mocks.documentConfig.mockReturnValue(documentConfig);
});

describe("GET /api/documents/[documentId]/preview", () => {
  it("answers a member with a non-cacheable, sniff-proof page-one image", async () => {
    mocks.rows.sessions = [sessionRow(READER)];
    mocks.rows.users = [accessRow()];
    mocks.rows.document_crypto = [cryptoRow()];
    mocks.readCiphertext.mockResolvedValue(Buffer.alloc(256));
    mocks.decryptDocument.mockReturnValue(syntheticPdf("Route preview"));

    const response = await previewFor();
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("content-length")).toBe(String(body.length));
    expect(body.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it("refuses a signed-out request without reading any document", async () => {
    mocks.rows.users = [accessRow()];

    const response = await previewFor(DOCUMENT, new NextRequest(`http://127.0.0.1:3000/api/documents/${DOCUMENT}/preview`));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "session_required", message: "A valid session is required" } });
    expect(mocks.decryptDocument).not.toHaveBeenCalled();
  });

  it("answers another household's document as not found, never as an image", async () => {
    mocks.rows.sessions = [sessionRow(READER)];
    mocks.rows.users = [accessRow({ administrator: false, membershipUserId: null })];
    mocks.rows.document_crypto = [cryptoRow()];

    const response = await previewFor();

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "document_not_found", message: "That document is not available" },
    });
    expect(mocks.readCiphertext).not.toHaveBeenCalled();
    expect(mocks.decryptDocument).not.toHaveBeenCalled();
  });

  it("words an unpreviewable document as a bounded code rather than a server error", async () => {
    mocks.rows.sessions = [sessionRow(READER)];
    mocks.rows.users = [accessRow()];
    mocks.rows.document_crypto = [cryptoRow()];
    mocks.readCiphertext.mockResolvedValue(Buffer.alloc(256));
    mocks.decryptDocument.mockReturnValue(Buffer.from("this is not a document"));

    const response = await previewFor();

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      error: {
        code: "document_preview_unsupported",
        message: "Orbit cannot show a picture of this document",
      },
    });
  });

  it("answers a malformed document identifier as not found", async () => {
    mocks.rows.sessions = [sessionRow(READER)];

    const response = await previewFor("not-a-uuid");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "document_not_found" } });
  });
});
