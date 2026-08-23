import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "@/lib/env";

/**
 * The review inbox's read contract (#467). Only the database and the auth
 * config are stubbed: the session is read through the real `readSession` and
 * the payload is shaped by the real `listImapInbox`, so what these tests pin
 * is the endpoint's own behaviour rather than a rehearsal of it.
 *
 * Every predicate the endpoint issues is captured and compiled with drizzle's
 * own dialect, which is how the cross-user cases below can assert that the
 * signed-in user's id — the request's only input — is what the reads are
 * bound to.
 */

const config: AuthConfig = {
  appUrl: new URL("https://orbit.example"),
  sessionSecret: "imap-inbox-route-session-secret-that-is-long-enough",
  sessionTtlSeconds: 3600,
  issuer: "https://issuer.imap-inbox.example.invalid/",
  clientId: "imap-inbox-client",
  clientSecret: "imap-inbox-client-secret",
  callbackUrl: "https://orbit.example/api/auth/callback",
  scopes: "openid profile email",
  claims: { email: "email", emailVerified: "email_verified", name: "name", avatar: "picture" },
  secureCookies: true,
};

/** Every query the route makes, answered in order from a queue of row sets,
 * with each `where` predicate recorded for the boundary assertions. */
const mocks = vi.hoisted(() => ({ rows: [] as unknown[][], wheres: [] as unknown[], deleteSession: vi.fn() }));

function queryStub(rows: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = new Proxy({}, {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject);
      }
      if (property === "where") return (predicate: unknown) => { mocks.wheres.push(predicate); return chain; };
      return () => chain;
    },
  });
  return chain;
}

/* The guard has its own contract and integration tests (#523); these
   tests pin the route's own behaviour, so it always passes here. */
vi.mock("@/server/maintenance", () => ({ assertOutsideMaintenance: vi.fn(async () => {}) }));
vi.mock("@/db", () => ({
  getDb: () => ({
    select: () => queryStub(mocks.rows.shift() ?? []),
    delete: () => ({ where: mocks.deleteSession }),
  }),
}));
vi.mock("@/lib/env", () => ({ getAuthConfig: () => config }));

import { GET } from "./route";

const dialect = new PgDialect();

/** The parameters every read after the session lookup was bound to. */
function boundParameters(): unknown[][] {
  return mocks.wheres.slice(1).map((predicate) => dialect.sqlToQuery(predicate as SQL).params);
}

const READER = "22222222-2222-4222-8222-222222222222";
const OTHER_READER = "33333333-3333-4333-8333-333333333333";
const HOUSEHOLD = "44444444-4444-4444-8444-444444444444";
const LEFT_HOUSEHOLD = "55555555-5555-4555-8555-555555555555";
const SESSION_TOKEN = "imap-inbox-route-session-token";

function sessionRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    activeHouseholdId: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    userId,
    email: "reader@example.invalid",
    emailVerified: true,
    displayName: "Inbox Reader",
    avatarUrl: null,
    isInstanceAdmin: false,
    disabledAt: null,
    themeMode: "dark",
    themeId: "starchart",
    textSize: "comfortable",
    urgencyPalette: "themed",
    emailNotifications: true,
    pushNotifications: true,
    ...overrides,
  };
}

function receiptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    status: "pending_review",
    householdId: HOUSEHOLD,
    draftVersion: 1,
    proposal: { title: "Home insurance renewal", provider: "Harbour Mutual" },
    fieldEvidence: { title: { source: "parser", confidence: "high" } },
    expiresAt: new Date("2026-09-25T00:00:00.000Z"),
    receivedAt: new Date("2026-08-11T09:24:00.000Z"),
    failureCode: null,
    hasApprovalOperation: false,
    hasApprovedItem: false,
    attachmentCount: 1,
    ...overrides,
  };
}

function attachmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    messageId: "66666666-6666-4666-8666-666666666666",
    displayName: "policy-schedule.pdf",
    mediaType: "application/pdf",
    sizeBytes: 831_488,
    status: "stored",
    approvedItemId: null,
    ...overrides,
  };
}

function filedRow(overrides: Record<string, unknown> = {}) {
  return {
    itemId: "88888888-8888-4888-8888-888888888888",
    householdId: HOUSEHOLD,
    title: "Car MOT — Volvo V60",
    itemStatus: "active",
    messageId: "99999999-9999-4999-8999-999999999999",
    filedAt: new Date("2025-08-30T10:00:00.000Z"),
    ...overrides,
  };
}

type InboxBody = {
  receipts: Array<{
    id: string;
    attachmentCount: number;
    attachments: Array<{ id: string; ordinal: number; displayName: string; mediaType: string; sizeBytes: number; scanState: string }>;
  }>;
  households: Array<{ id: string }>;
  filed: Array<{ itemId: string; householdId: string; title: string; itemStatus: string; documentName: string | null; documentCount: number; filedAt: string | null }>;
};

function signedIn(): NextRequest {
  const request = new NextRequest("http://127.0.0.1:3000/api/imap-inbox");
  request.cookies.set("__Host-orbit-session", SESSION_TOKEN);
  return request;
}

async function inboxFor(rows: unknown[][]): Promise<{ status: number; noStore: string | null; body: InboxBody; raw: string }> {
  mocks.rows.splice(0, mocks.rows.length, ...rows);
  mocks.wheres.length = 0;
  const response = await GET(signedIn());
  const body = await response.json() as InboxBody;
  return { status: response.status, noStore: response.headers.get("cache-control"), body, raw: JSON.stringify(body) };
}

afterEach(() => {
  mocks.rows.length = 0;
  mocks.wheres.length = 0;
  mocks.deleteSession.mockReset();
});

describe("GET /api/imap-inbox", () => {
  it("names each held attachment for its recipient, with its size and clean verdict", async () => {
    const { status, noStore, body, raw } = await inboxFor([
      [sessionRow(READER)],
      [{ id: READER, isInstanceAdmin: false }],
      [receiptRow()],
      [{ id: HOUSEHOLD, name: "Lawson home", currency: "GBP" }],
      [attachmentRow()],
      [],
    ]);

    expect(status).toBe(200);
    expect(noStore).toBe("no-store");
    expect(body.receipts).toHaveLength(1);
    expect(body.receipts[0].attachmentCount).toBe(1);
    expect(body.receipts[0].attachments).toEqual([{
      id: "77777777-7777-4777-8777-777777777777",
      ordinal: 1,
      displayName: "policy-schedule.pdf",
      mediaType: "application/pdf",
      sizeBytes: 831_488,
      scanState: "clean",
    }]);
    // The names are the only new surface: nothing about where the bytes live,
    // nor the mail they arrived in, travels with them (#411).
    expect(raw).not.toContain("storageKey");
    expect(raw).not.toContain("contentSha256");
    expect(raw).not.toContain("messageId");
  });

  it("numbers a message's attachments in arrival order, not the order they were read", async () => {
    // The read is newest-first so the bound drops the oldest names, but the
    // ordinal the reader sees still counts from the first document to arrive.
    const { body } = await inboxFor([
      [sessionRow(READER)],
      [{ id: READER, isInstanceAdmin: false }],
      [receiptRow({ attachmentCount: 2 })],
      [{ id: HOUSEHOLD, name: "Lawson home", currency: "GBP" }],
      [
        attachmentRow({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", displayName: "second.pdf" }),
        attachmentRow({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", displayName: "first.pdf" }),
      ],
      [],
    ]);

    expect(body.receipts[0].attachments.map((attachment) => [attachment.ordinal, attachment.displayName])).toEqual([
      [1, "first.pdf"],
      [2, "second.pdf"],
    ]);
  });

  it("says which item each filed document became, and when", async () => {
    const { body } = await inboxFor([
      [sessionRow(READER)],
      [{ id: READER, isInstanceAdmin: false }],
      [],
      [{ id: HOUSEHOLD, name: "Lawson home", currency: "GBP" }],
      [attachmentRow({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        messageId: "99999999-9999-4999-8999-999999999999",
        displayName: "mot-reminder.pdf",
        status: "assigned",
        approvedItemId: "88888888-8888-4888-8888-888888888888",
      })],
      [filedRow()],
    ]);

    expect(body.filed).toEqual([{
      itemId: "88888888-8888-4888-8888-888888888888",
      householdId: HOUSEHOLD,
      title: "Car MOT — Volvo V60",
      itemStatus: "active",
      documentName: "mot-reminder.pdf",
      documentCount: 1,
      filedAt: "2025-08-30T10:00:00.000Z",
    }]);
  });

  it("reports a filed item whose staged bytes are long gone, without inventing a name", async () => {
    // The receipt has burned up and its attachment rows went with it; the
    // item link is what survives, so the lane still lists it.
    const { body } = await inboxFor([
      [sessionRow(READER)],
      [{ id: READER, isInstanceAdmin: false }],
      [],
      [{ id: HOUSEHOLD, name: "Lawson home", currency: "GBP" }],
      [],
      [filedRow({ filedAt: null })],
    ]);

    expect(body.filed).toEqual([expect.objectContaining({ documentName: null, documentCount: 0, filedAt: null })]);
  });

  it("sanitises a hostile filename on the way out rather than trusting the column", async () => {
    // A row written before intake normalized names, or by a future writer
    // that forgets to: a traversal path, a right-to-left override dressing an
    // executable up as a PDF, embedded newlines and NULs, and no length bound.
    const hostile = `  ../../etc/\u202Efdp.exe  report\n\nname.pdf${"\u0000".repeat(4)}${"z".repeat(400)}  `;
    const { body, raw } = await inboxFor([
      [sessionRow(READER)],
      [{ id: READER, isInstanceAdmin: false }],
      [receiptRow()],
      [{ id: HOUSEHOLD, name: "Lawson home", currency: "GBP" }],
      [attachmentRow({ displayName: hostile })],
      [],
    ]);

    const [{ displayName }] = body.receipts[0].attachments;
    expect(displayName.startsWith("fdp.exe reportname.pdf")).toBe(true);
    expect(displayName).not.toContain("/");
    expect(displayName).not.toContain("..");
    expect(displayName).not.toContain("\n");
    expect(raw).not.toContain("\u202E");
    expect(raw).not.toContain("\u0000");
    expect(Buffer.byteLength(displayName, "utf8")).toBeLessThanOrEqual(180);
  });

  it("keeps a Windows path's leaf and nothing above it", async () => {
    const { body } = await inboxFor([
      [sessionRow(READER)],
      [{ id: READER, isInstanceAdmin: false }],
      [receiptRow()],
      [{ id: HOUSEHOLD, name: "Lawson home", currency: "GBP" }],
      [attachmentRow({ displayName: "C:\\Users\\tom\\Desktop\\policy schedule.PDF" })],
      [],
    ]);

    expect(body.receipts[0].attachments[0].displayName).toBe("policy schedule.PDF");
  });

  it("keeps an unnamed or unreadable attachment to a bounded word, never an empty chip", async () => {
    const { body } = await inboxFor([
      [sessionRow(READER)],
      [{ id: READER, isInstanceAdmin: false }],
      [receiptRow()],
      [{ id: HOUSEHOLD, name: "Lawson home", currency: "GBP" }],
      [attachmentRow({ displayName: "‪‫", mediaType: "application/x-msdownload" })],
      [],
    ]);

    expect(body.receipts[0].attachments[0]).toMatchObject({
      displayName: "document.pdf",
      mediaType: "application/octet-stream",
      scanState: "clean",
    });
  });

  it("withholds a filed item in a household the reader has left", async () => {
    const { body } = await inboxFor([
      [sessionRow(READER)],
      [{ id: READER, isInstanceAdmin: false }],
      [],
      [{ id: HOUSEHOLD, name: "Lawson home", currency: "GBP" }],
      [],
      [
        filedRow(),
        filedRow({ itemId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", householdId: LEFT_HOUSEHOLD, title: "Not yours any more" }),
      ],
    ]);

    expect(body.filed.map((entry) => entry.itemId)).toEqual(["88888888-8888-4888-8888-888888888888"]);
    expect(JSON.stringify(body)).not.toContain("Not yours any more");
    expect(JSON.stringify(body)).not.toContain(LEFT_HOUSEHOLD);
  });

  it("cannot be asked for another reader's provenance — the session is the only input", async () => {
    const first = await inboxFor([
      [sessionRow(READER)],
      [{ id: READER, isInstanceAdmin: false }],
      [],
      [{ id: HOUSEHOLD, name: "Lawson home", currency: "GBP" }],
      [attachmentRow({ messageId: "99999999-9999-4999-8999-999999999999", displayName: "first-readers-mail.pdf", status: "assigned" })],
      [filedRow({ title: "First reader's item" })],
    ]);
    const firstBound = boundParameters();

    const second = await inboxFor([
      [sessionRow(OTHER_READER)],
      [{ id: OTHER_READER, isInstanceAdmin: false }],
      [],
      [{ id: HOUSEHOLD, name: "Lawson home", currency: "GBP" }],
      [],
      [],
    ]);
    const secondBound = boundParameters();

    // The URL carries no user id and no household id, so there is nothing to
    // substitute; every read past the session lookup is bound to the id the
    // session itself resolved to, and never to the other reader's.
    expect(firstBound.length).toBeGreaterThanOrEqual(4);
    expect(firstBound.every((params) => params.includes(READER))).toBe(true);
    expect(firstBound.some((params) => params.includes(OTHER_READER))).toBe(false);
    expect(secondBound.every((params) => params.includes(OTHER_READER))).toBe(true);
    expect(secondBound.some((params) => params.includes(READER))).toBe(false);

    expect(first.body.filed).toHaveLength(1);
    expect(second.body.filed).toEqual([]);
    expect(second.raw).not.toContain("First reader's item");
    expect(second.raw).not.toContain("first-readers-mail.pdf");
  });

  it("tells an instance admin there is nothing filed rather than handing them somebody's mail", async () => {
    const { status, body } = await inboxFor([
      [sessionRow("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { isInstanceAdmin: true })],
      [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", isInstanceAdmin: true }],
    ]);

    expect(status).toBe(200);
    expect(body).toEqual({ receipts: [], households: [], filed: [] });
  });

  it("refuses a request without a session and says nothing else", async () => {
    mocks.rows.length = 0;
    const response = await GET(new NextRequest("http://127.0.0.1:3000/api/imap-inbox"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "session_required", message: "A valid session is required" },
    });
  });
});
