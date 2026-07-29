import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { imapIngestionMessages, items } from "@/db/schema";
import { approveReviewedIntake } from "@/server/reviewed-intake";
import { assignImapReceiptHousehold, listImapInbox } from "@/server/imap-inbox";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const operation = (seed: string) => `${seed.slice(0, 8)}-1111-4111-8111-111111111111`;

describe("private reviewed intake approval boundary", () => {
  it("assigns a mailbox receipt without materializing any household item", async () => {
    const fixture = await createIntegrationFixture("reviewed-private-assignment");
    const member = await fixture.session("member");
    const [receipt] = await getDb().insert(imapIngestionMessages).values({
      mailbox: "private-test-mailbox",
      mailboxUidValidity: "private-test-validity",
      mailboxUid: 99,
      contentSha256: operation("aaaaaaaa"),
      recipientAliasSha256: operation("bbbbbbbb"),
      userId: member.userId,
      status: "pending_review",
      householdId: null,
      receiptStatus: "cancelled",
      expiresAt: new Date(Date.now() + 86_400_000),
    }).returning({ id: imapIngestionMessages.id });
    const before = await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, fixture.household.id));

    await assignImapReceiptHousehold(member.userId, receipt.id, fixture.household.id);

    expect(await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, fixture.household.id))).toEqual(before);
    const [stored] = await getDb().select({ householdId: imapIngestionMessages.householdId, reviewItemId: imapIngestionMessages.reviewItemId })
      .from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receipt.id));
    expect(stored).toEqual({ householdId: fixture.household.id, reviewItemId: null });
  });

  it("keeps drafts private and makes direct approval idempotent", async () => {
    const fixture = await createIntegrationFixture("reviewed-direct-approval");
    const member = await fixture.session("member");
    const outsider = await fixture.session("outsider");
    const before = await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, fixture.household.id));
    const input = {
      operationId: operation("cccccccc"),
      source: { kind: "direct_upload" as const },
      householdId: fixture.household.id,
      sectionId: fixture.section.id,
      action: "create_separate" as const,
      item: { title: "Exact reviewed value", provider: "Reviewed provider", currency: "GBP", status: "active" as const },
      attachmentIds: [],
    };

    expect((await listImapInbox(outsider.userId)).receipts).toHaveLength(0);
    const first = await approveReviewedIntake(member.userId, input);
    const second = await approveReviewedIntake(member.userId, input);
    expect(second.itemId).toBe(first.itemId);
    expect(await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, fixture.household.id))).toHaveLength(before.length + 1);
    const [created] = await getDb().select({ title: items.title, provider: items.provider }).from(items).where(eq(items.id, first.itemId));
    expect(created).toEqual({ title: "Exact reviewed value", provider: "Reviewed provider" });
  });

  it("does not apply submitted fields when attaching to an existing item", async () => {
    const fixture = await createIntegrationFixture("reviewed-attach-existing");
    const member = await fixture.session("member");
    const before = await getDb().select({ title: items.title, provider: items.provider, reference: items.reference, sectionId: items.sectionId })
      .from(items).where(and(eq(items.id, fixture.item.id), eq(items.householdId, fixture.household.id)));

    await approveReviewedIntake(member.userId, {
      operationId: operation("dddddddd"),
      source: { kind: "direct_upload" },
      householdId: fixture.household.id,
      sectionId: fixture.section.id,
      action: "attach_existing",
      targetItemId: fixture.item.id,
      item: { title: "Must not overwrite", provider: "Must not overwrite", currency: "GBP", status: "active" },
      attachmentIds: [],
    });

    expect(await getDb().select({ title: items.title, provider: items.provider, reference: items.reference, sectionId: items.sectionId })
      .from(items).where(eq(items.id, fixture.item.id))).toEqual(before);
  });
});
