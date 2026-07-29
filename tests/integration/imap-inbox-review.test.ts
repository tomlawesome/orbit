import { describe, expect, it } from "vitest";
import { GET as getReceipt } from "@/app/api/imap-inbox/[receiptId]/route";
import { GET as getInbox } from "@/app/api/imap-inbox/route";
import { getDb } from "@/db";
import { imapIngestionAttachments, imapIngestionMessages } from "@/db/schema";
import { requestForSession, requestWithoutSession, createIntegrationFixture } from "./support/fixtures";

describe("authenticated mailbox review read boundary", () => {
  it("does not disclose a receipt to signed-out or cross-user callers", async () => {
    const fixture = await createIntegrationFixture("imap-review-route-auth");
    const member = await fixture.session("member");
    const outsider = await fixture.session("outsider");
    const [receipt] = await getDb().insert(imapIngestionMessages).values({
      mailbox: "private", mailboxUidValidity: "review", mailboxUid: 101,
      contentSha256: crypto.randomUUID().replaceAll("-", ""), recipientAliasSha256: "review-alias",
      userId: member.userId, status: "pending_review", householdId: fixture.household.id,
      proposal: { title: "Private proposal", provider: "Private provider" },
      expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    }).returning({ id: imapIngestionMessages.id });
    await getDb().insert(imapIngestionAttachments).values({
      messageId: receipt.id, displayName: "private.pdf", mediaType: "application/pdf", sizeBytes: 12,
      contentSha256: crypto.randomUUID().replaceAll("-", ""), storageKey: `review/${crypto.randomUUID()}`,
      ciphertextSize: 20, envelopeVersion: 1, contentIv: "iv", contentAuthTag: "tag", wrappedDek: "dek",
      wrapIv: "wrap-iv", wrapAuthTag: "wrap-tag", keyId: "key", status: "stored",
    });
    const url = "http://127.0.0.1:3000/api/imap-inbox";
    expect((await getInbox(requestWithoutSession(url))).status).toBe(401);
    const hidden = await getReceipt(
      requestForSession(outsider, `${url}/${receipt.id}?householdId=${fixture.household.id}`),
      { params: Promise.resolve({ receiptId: receipt.id }) },
    );
    expect(hidden.status).toBe(404);
    await fixture.cleanup();
  });

  it("requires a selected household and redacts mail and storage metadata", async () => {
    const fixture = await createIntegrationFixture("imap-review-route-safe");
    const member = await fixture.session("member");
    const [receipt] = await getDb().insert(imapIngestionMessages).values({
      mailbox: "private", mailboxUidValidity: "safe", mailboxUid: 102,
      contentSha256: crypto.randomUUID().replaceAll("-", ""), recipientAliasSha256: "safe-alias",
      userId: member.userId, status: "pending_review", householdId: fixture.household.id,
      proposal: { title: "Safe title", sender: "must-not-appear", filename: "must-not-appear.pdf" },
      fieldEvidence: { title: { source: "parser", confidence: "medium" } },
      expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    }).returning({ id: imapIngestionMessages.id });
    const response = await getReceipt(
      requestForSession(member, `http://127.0.0.1:3000/api/imap-inbox/${receipt.id}?householdId=${fixture.household.id}`),
      { params: Promise.resolve({ receiptId: receipt.id }) },
    );
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toMatchObject({ receipt: { id: receipt.id }, sections: expect.any(Array), candidates: expect.any(Array) });
    expect(JSON.stringify(payload)).not.toContain("must-not-appear");
    expect(JSON.stringify(payload)).not.toContain("storageKey");
    expect(JSON.stringify(payload)).not.toContain("contentSha256");
    await fixture.cleanup();
  });
});
