import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/reviewed-intake/approve/route";
import { getDb } from "@/db";
import { imapIngestionMessages } from "@/db/schema";
import { requestForSession, requestWithoutSession, createIntegrationFixture } from "./support/fixtures";

function body(fixture: Awaited<ReturnType<typeof createIntegrationFixture>>, overrides: Record<string, unknown> = {}) {
  return {
    operationId: "11111111-1111-4111-8111-111111111111",
    source: { kind: "direct_upload", expectedDocument: false },
    householdId: fixture.household.id,
    sectionId: fixture.section.id,
    action: "create_separate",
    item: { title: "Reviewed route item", currency: "GBP", status: "active" },
    attachmentIds: [],
    ...overrides,
  };
}

function request(session: Awaited<ReturnType<Awaited<ReturnType<typeof createIntegrationFixture>>["session"]>>, url: string, payload: unknown, headers: Record<string, string> = {}) {
  return requestForSession(session, url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/reviewed-intake/approve security contract", () => {
  it("rejects signed-out and CSRF-failed requests with no-store sanitized errors", async () => {
    const fixture = await createIntegrationFixture("reviewed-route-auth");
    const url = `http://127.0.0.1:3000/api/reviewed-intake/approve`;
    const signedOut = await POST(requestWithoutSession(url, { method: "POST", body: "{}" }));
    expect(signedOut.status).toBe(401);
    expect(signedOut.headers.get("cache-control")).toBe("no-store");
    const member = await fixture.session("member");
    const csrf = await POST(request(member, url, body(fixture), { "x-csrf-token": "wrong" }));
    expect(csrf.status).toBe(403);
    expect(await csrf.json()).toEqual({ error: { code: "csrf_failed", message: "The request could not be verified" } });
    expect(csrf.headers.get("cache-control")).toBe("no-store");
    await fixture.cleanup();
  });

  it("does not disclose a mailbox receipt to another user and rejects altered replay", async () => {
    const fixture = await createIntegrationFixture("reviewed-route-replay");
    const member = await fixture.session("member");
    const outsider = await fixture.session("outsider");
    const [receipt] = await getDb().insert(imapIngestionMessages).values({
      mailbox: "private", mailboxUidValidity: "1", mailboxUid: Math.floor(Math.random() * 1000000),
      contentSha256: crypto.randomUUID().replaceAll("-", ""), recipientAliasSha256: "alias",
      userId: fixture.users.member.id, householdId: fixture.household.id, status: "pending_review",
      expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    }).returning({ id: imapIngestionMessages.id });
    const url = "http://127.0.0.1:3000/api/reviewed-intake/approve";
    const mailbox = body(fixture, { source: { kind: "mailbox_draft", receiptId: receipt.id, draftVersion: 1 }, operationId: "33333333-3333-4333-8333-333333333333" });
    const hidden = await POST(request(outsider, url, mailbox));
    expect(hidden.status).toBe(404);
    const first = await POST(request(member, url, body(fixture)));
    expect(first.status).toBe(200);
    const altered = await POST(request(member, url, body(fixture, { item: { title: "Altered", currency: "GBP", status: "active" } })));
    expect(altered.status).toBe(409);
    expect((await altered.json()).error).toEqual({ code: "reviewed_intake_conflict", message: "That approval identity was already used" });
    await fixture.cleanup();
  });
});
