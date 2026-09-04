import { describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { imapIngestionMessages } from "@/db/schema";
import { createIntegrationFixture } from "./support/fixtures";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";

const { POST } = await loadRoute("reviewed-intake/approve");

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

function approve(session: Awaited<ReturnType<Awaited<ReturnType<typeof createIntegrationFixture>>["session"]>>, url: string, payload: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return callRouteForSession(POST, session, {
    url,
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/reviewed-intake/approve security contract", () => {
  it("rejects signed-out and CSRF-failed requests with no-store sanitized errors", async () => {
    const fixture = await createIntegrationFixture("reviewed-route-auth");
    const url = `http://127.0.0.1:3000/api/reviewed-intake/approve`;
    const signedOut = await callRoute(POST, { url, method: "POST", body: "{}" });
    expect(signedOut.status).toBe(401);
    expect(signedOut.headers.get("cache-control")).toBe("no-store");
    const member = await fixture.session("member");
    const csrf = await approve(member, url, body(fixture), { "x-csrf-token": "wrong" });
    expect(csrf.status).toBe(403);
    expect(await csrf.json()).toEqual({ error: { code: "csrf_failed", message: "The CSRF token is missing or invalid" } });
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
    const hidden = await approve(outsider, url, mailbox);
    expect(hidden.status).toBe(404);
    const first = await approve(member, url, body(fixture));
    expect(first.status).toBe(200);
    const altered = await approve(member, url, body(fixture, { item: { title: "Altered", currency: "GBP", status: "active" } }));
    expect(altered.status).toBe(409);
    expect((await altered.json()).error).toEqual({ code: "reviewed_intake_conflict", message: "That approval identity was already used" });
    await fixture.cleanup();
  });

  it("covers disabled membership, destination, target, stale-version, and cache boundaries", async () => {
    const fixture = await createIntegrationFixture("reviewed-route-boundaries");
    const member = await fixture.session("member");
    const disabled = await fixture.session("disabled");
    const url = "http://127.0.0.1:3000/api/reviewed-intake/approve";
    await fixture.disableUser("disabled");
    const disabledResponse = await approve(disabled, url, body(fixture));
    expect(disabledResponse.status).toBe(401);
    expect(disabledResponse.headers.get("cache-control")).toBe("no-store");

    const removedFixture = await createIntegrationFixture("reviewed-route-removed");
    const removedMember = await removedFixture.session("member");
    await removedFixture.removeMember();
    const removed = await approve(removedMember, url, body(removedFixture));
    expect(removed.status).toBe(404);
    expect(await removed.json()).toEqual({ error: { code: "household_not_found", message: "That household is not available" } });

    const wrongTarget = await approve(member, url, body(fixture, { targetItemId: fixture.secondItem.id, action: "attach_existing" }));
    expect(wrongTarget.status).toBe(404);
    expect((await wrongTarget.json()).error.code).toBe("item_not_found");
    const wrongHousehold = await approve(member, url, body(fixture, { householdId: fixture.secondHousehold.id }));
    expect(wrongHousehold.status).toBe(404);
    expect((await wrongHousehold.json()).error.code).toBe("household_not_found");
    const wrongSection = await approve(member, url, body(fixture, { sectionId: "55555555-5555-4555-8555-555555555555" }));
    expect(wrongSection.status).toBe(404);
    expect((await wrongSection.json()).error.code).toBe("section_not_found");

    const [receipt] = await getDb().insert(imapIngestionMessages).values({
      mailbox: "private", mailboxUidValidity: "2", mailboxUid: 9001,
      contentSha256: crypto.randomUUID().replaceAll("-", ""), recipientAliasSha256: "stale-alias",
      userId: fixture.users.member.id, householdId: fixture.household.id, draftVersion: 2, status: "pending_review",
      expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    }).returning({ id: imapIngestionMessages.id });
    const stale = await approve(member, url, body(fixture, { source: { kind: "mailbox_draft", receiptId: receipt.id, draftVersion: 1 }, operationId: "44444444-4444-4444-8444-444444444444" }));
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("reviewed_intake_stale");
    await fixture.cleanup();
    await removedFixture.cleanup();
  });
});
