import { describe, expect, it } from "vitest";
import { GET as getReceipt } from "@/app/api/imap-inbox/[receiptId]/route";
import { GET as getInbox } from "@/app/api/imap-inbox/route";
import { getDb } from "@/db";
import { imapIngestionAttachments, imapIngestionMessages, items } from "@/db/schema";
import { eq } from "drizzle-orm";
import { listImapInbox } from "@/server/imap-inbox";
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
    const memberInbox = await getInbox(requestForSession(member, url));
    expect((await memberInbox.json()).receipts).toHaveLength(1);
    const peerInbox = await getInbox(requestForSession(await fixture.session("owner"), url));
    expect((await peerInbox.json()).receipts).toHaveLength(0);
    const adminInbox = await getInbox(requestForSession(await fixture.session("admin"), url));
    expect((await adminInbox.json()).receipts).toHaveLength(0);
    const disabled = await fixture.session("disabled");
    await fixture.disableUser("disabled");
    expect((await getInbox(requestForSession(disabled, url))).status).toBe(401);
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
    await getDb().update(items).set({ provider: "Shared provider" }).where(eq(items.id, fixture.secondItem.id));
    const [selectedCandidate] = await getDb().insert(items).values({
      householdId: fixture.household.id, sectionId: fixture.section.id, title: "Other household record", provider: "Shared provider", currency: "GBP",
    }).returning({ id: items.id });
    const [receipt] = await getDb().insert(imapIngestionMessages).values({
      mailbox: "private", mailboxUidValidity: "safe", mailboxUid: 102,
      contentSha256: crypto.randomUUID().replaceAll("-", ""), recipientAliasSha256: "safe-alias",
      userId: member.userId, status: "pending_review", householdId: fixture.household.id,
      proposal: { title: "Safe title", provider: "Shared provider", sender: "must-not-appear", filename: "must-not-appear.pdf" },
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
    expect(payload.candidates).toEqual([{ itemId: selectedCandidate.id, title: "Other household record", reason: "matching provider" }]);
    expect(JSON.stringify(payload)).not.toContain("must-not-appear");
    expect(JSON.stringify(payload)).not.toContain("storageKey");
    expect(JSON.stringify(payload)).not.toContain("contentSha256");
    await fixture.removeMember();
    expect((await listImapInbox(member.userId)).receipts).toHaveLength(0);
    await fixture.cleanup();
  });
});
