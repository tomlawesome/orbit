import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  auditLog,
  imapIngestionAttachments,
  imapIngestionMessages,
  imapIngestionStagingObjects,
  imapNotificationDeliveries,
  imapRecipientAliases,
  items,
  mailInMailbox,
  mailInRelays,
  mailInSecrets,
  mailInSenderAddresses,
  mailInUnattributedReplies,
  memberships,
} from "@/db/schema";
import { scanAndHoldImapAttachment } from "@/server/mail-in/imap-attachment-holding";
import { assignImapReceiptHousehold, discardImapReviewItem, getImapReview, listImapInbox } from "@/server/mail-in/imap-inbox";
import { reconcileImapRecipientAliases, runImapIngestionCycle, setImapClientFactoryForTests } from "@/server/mail-in/imap-ingestion";
import { getImapIngestionConfig } from "@/server/mail-in/mailbox-config";
import { setMailboxSettings, type MailboxSettingsDependencies, type MailboxSettingsInput } from "@/server/mail-in/mailbox-settings";
import { readRelaySettings, rotateRelayAddress, setRelayIngest } from "@/server/mail-in/relay-settings";
import { relayAddressFor } from "@/server/mail-in/relays";
import { requestSenderCheck } from "@/server/mail-in/sender-addresses";
import { openMetadataReader } from "@/server/metadata/fields";
import { approveReviewedIntake } from "@/server/reviewed-intake";
import { cleanupIntegrationEnvironment, createIntegrationFixture, encryptedReceiptDraft, type IntegrationFixture } from "./support/fixtures";
import { attributedHeaders, verifiedSenderFor, fakeImapMailbox } from "./support/mail-in";
import { fromOfHeaders, signedSource } from "./support/dkim-fixture";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { syntheticPdf } from "../support/synthetic-documents";

/* #1681: a forward is attributed only on its own DKIM signature, so the
   sources below are signed with the fixture key this stub publishes. */
vi.mock("node:dns/promises", async () => (await import("./support/dkim-fixture")).fixtureDnsModule());

/*
 * #1632 (an instance administrator gets a relay like any member; owner
 * decision 47). Written before the fix: one case per point of the issue's
 * specification, against a real database. `fixture.users.admin` is an
 * instance administrator with no household membership.
 */
const settings: MailboxSettingsInput = {
  host: "imap.example.test",
  port: 993,
  accountUser: "intake@example.test",
  mailbox: "INBOX",
  tlsServerName: "imap.example.test",
  providerProfile: "mailcow",
  trustedRecipientHeader: "X-Original-To",
  pollSeconds: 300,
  password: "fake-admin-relay-password",
};
const providerReady: MailboxSettingsDependencies = { verifyImap: async () => "ready" };

const { GET: previewAttachment } = await loadRoute("imap-inbox/[receiptId]/attachments/[attachmentId]/preview");
const { POST: approveRoute } = await loadRoute("reviewed-intake/approve");

let fixture: IntegrationFixture;
let admin: { id: string; isInstanceAdmin: true };
let member: { id: string; isInstanceAdmin: false };

beforeEach(async () => {
  fixture = await createIntegrationFixture("admin-relay");
  admin = { id: fixture.users.admin.id, isInstanceAdmin: true };
  member = { id: fixture.users.member.id, isInstanceAdmin: false };
  await setMailboxSettings(fixture.users.admin.id, null, settings, providerReady);
});

afterEach(async () => {
  const db = getDb();
  setImapClientFactoryForTests(undefined);
  await db.delete(imapNotificationDeliveries);
  await db.delete(imapIngestionStagingObjects);
  await db.delete(imapIngestionAttachments);
  await db.delete(imapIngestionMessages);
  await db.delete(imapRecipientAliases);
  await db.delete(mailInRelays);
  await db.delete(mailInSenderAddresses);
  await db.delete(mailInUnattributedReplies);
  await db.update(mailInMailbox).set({ passwordSecretId: null, aliasKeySecretId: null });
  await db.delete(mailInMailbox);
  await db.delete(mailInSecrets);
  await db.delete(auditLog);
  await fixture.cleanup();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/** Gives the administrator a real membership of the fixture household. */
async function joinHousehold() {
  await getDb().insert(memberships).values({ householdId: fixture.household.id, userId: admin.id, role: "member" });
}

/**
 * One staged receipt for `userId`, with one real held PDF, not yet assigned to
 * a household (an administrator holds no membership to assign it to).
 */
async function seedReceipt(userId: string, options: { householdId?: string | null; title?: string } = {}) {
  const receiptId = randomUUID();
  const householdId = options.householdId === undefined ? null : options.householdId;
  const held = await scanAndHoldImapAttachment({
    bytes: syntheticPdf("admin relay fixture"),
    filename: "admin-receipt.pdf",
    declaredMediaType: "application/pdf",
    recipientUserId: userId,
    receiptId,
  });
  await getDb().insert(imapIngestionMessages).values({
    id: receiptId, mailbox: "private", mailboxUidValidity: `admin-relay-${receiptId.slice(0, 8)}`, mailboxUid: 700,
    contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: `admin-relay-${receiptId.slice(0, 8)}`,
    userId, householdId, status: "pending_review", receiptStatus: "pending", draftVersion: 1,
    expiresAt: new Date(Date.now() + 86_400_000),
    ...await encryptedReceiptDraft(householdId, receiptId, { proposal: { title: options.title ?? "Admin receipt" } }),
  });
  await getDb().insert(imapIngestionAttachments).values({
    id: held.id, messageId: receiptId, displayName: held.displayName, mediaType: held.mediaType, sizeBytes: held.sizeBytes,
    contentSha256: held.contentSha256, storageKey: held.storageKey, ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored",
  });
  return { receiptId, attachmentId: held.id };
}

/** A reviewed-intake filing of a mailbox draft; a fresh operation identity per call. */
const filing = (receiptId: string) => ({
  operationId: randomUUID(),
  source: { kind: "mailbox_draft" as const, receiptId, draftVersion: 1 },
  householdId: fixture.household.id,
  sectionId: fixture.section.id,
  action: "create_separate" as const,
  item: { title: "Filed by the administrator", currency: "GBP", status: "active" as const },
  attachmentIds: [] as string[],
});

const householdItems = () => getDb().select({ id: items.id }).from(items).where(eq(items.householdId, fixture.household.id));

const receiptRow = async (receiptId: string) => (await getDb().select({
  status: imapIngestionMessages.status,
  approvedItemId: imapIngestionMessages.approvedItemId,
  approvalOperationId: imapIngestionMessages.approvalOperationId,
}).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId)))[0];

const approveViaRoute = async (receiptId: string, overrides: Record<string, unknown> = {}) => callRouteForSession(approveRoute, await fixture.session("admin"), {
  url: "http://127.0.0.1:3000/api/reviewed-intake/approve",
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...filing(receiptId), ...overrides }),
});

const previewUrl = (receiptId: string, attachmentId: string) =>
  `http://127.0.0.1:3000/api/imap-inbox/${receiptId}/attachments/${attachmentId}/preview`;

const fakeMailer = (mailed: Array<{ to: string }>) => ({
  smtpConfig: () => ({
    smtpUrl: "smtps://fake:fake@smtp.example.test:465",
    smtpSecurity: "implicit_tls" as const,
    smtpFrom: "orbit@example.test",
    vapidSubject: "",
    vapidPublicKey: "",
    vapidPrivateKey: "",
    pollMilliseconds: 60_000,
    maxAttempts: 5,
  }),
  appUrl: () => "http://127.0.0.1:3000",
  sendMail: async (message: { to: string }) => { mailed.push(message); },
});

const pdfBodyStructure = {
  part: "1", type: "application", subtype: "pdf", disposition: "attachment",
  dispositionParameters: { filename: "forwarded.pdf" }, size: 64,
} as never;

function mailboxHolding(uidValidity: bigint, headers: Buffer) {
  setImapClientFactoryForTests(() => fakeImapMailbox({
    uidValidity,
    search: "all",
    deleted: [],
    messages: [{ uid: 1, headers, source: () => signedSource(fromOfHeaders(headers)!, "admin-relay-message"), bodyStructure: pdfBodyStructure }],
    download: () => syntheticPdf("forwarded attachment"),
  }).client);
}

describe("an instance administrator's relay, queue and review (#1632)", () => {
  it("1: reads their relay settings exactly as a member does (#1632)", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);

    const reading = await readRelaySettings(admin);
    const memberReading = await readRelaySettings(member);

    expect(reading.address).toEqual(expect.stringContaining("@"));
    expect(reading.address).not.toBe(memberReading.address);
    expect(reading.listening).toBe(memberReading.listening);
    expect(reading.listening).not.toBe("no relay on this account");
    expect(reading).toMatchObject({ lastReceived: null, ingest: "enabled", unattributed: 0 });
    expect(reading.sender).toEqual({
      address: fixture.users.admin.email,
      verified: false,
      verificationPending: false,
      expiresAt: null,
      lastForwardSigned: null,
    });
    const rows = await getDb().select({ userId: mailInSenderAddresses.userId, verifiedAt: mailInSenderAddresses.verifiedAt })
      .from(mailInSenderAddresses).where(eq(mailInSenderAddresses.userId, admin.id));
    expect(rows).toEqual([{ userId: admin.id, verifiedAt: null }]);
  });

  it("2a: rotates their relay address, leaving a member's address alone (#1632)", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const before = (await readRelaySettings(admin)).address;
    const memberBefore = (await readRelaySettings(member)).address;
    expect(before).not.toBeNull();

    const rotated = await rotateRelayAddress(admin, "rotate");

    expect(rotated.address).toBe(relayAddressFor(admin.id, 2, config));
    expect(rotated.address).not.toBe(before);
    expect((await readRelaySettings(admin)).address).toBe(rotated.address);
    expect((await readRelaySettings(member)).address).toBe(memberBefore);
    expect(await getDb().select({ currentGeneration: mailInRelays.currentGeneration })
      .from(mailInRelays).where(eq(mailInRelays.userId, admin.id))).toEqual([{ currentGeneration: 2 }]);
  });

  it("2b: pauses and resumes their own collection, leaving a member's alone (#1632)", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);

    expect((await setRelayIngest(admin, true)).ingest).toBe("paused");
    expect((await readRelaySettings(admin)).ingest).toBe("paused");
    expect((await readRelaySettings(member)).ingest).toBe("enabled");
    expect((await setRelayIngest(admin, false)).ingest).toBe("enabled");

    const audits = await getDb().select({ action: auditLog.action, entityId: auditLog.entityId }).from(auditLog)
      .where(and(eq(auditLog.entityId, admin.id)));
    expect(audits.map((row) => row.action)).toEqual(expect.arrayContaining(["mail_in_relay_paused", "mail_in_relay_resumed"]));
  });

  it("2c: sends their sending-address check to their own account address (#1632)", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const mailed: Array<{ to: string }> = [];

    const result = await requestSenderCheck(admin.id, fakeMailer(mailed));

    expect(result.address).toBe(fixture.users.admin.email);
    expect(mailed.map((message) => message.to)).toEqual([fixture.users.admin.email]);
    expect((await readRelaySettings(admin)).sender).toMatchObject({
      address: fixture.users.admin.email, verified: false, verificationPending: true,
    });
  });

  it("3: lands mail forwarded from their checked address in their own review queue (#1632)", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const adminSender = await verifiedSenderFor(admin.id);
    await verifiedSenderFor(member.id);
    expect(adminSender).toBe(fixture.users.admin.email);

    mailboxHolding(4001n, attributedHeaders(adminSender));
    await runImapIngestionCycle(config);

    const [receipt] = await getDb().select({
      userId: imapIngestionMessages.userId,
      status: imapIngestionMessages.status,
      attributedBy: imapIngestionMessages.attributedBy,
    }).from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, "4001"));
    expect(receipt).toMatchObject({ userId: admin.id, attributedBy: "sender" });
    expect(receipt.status).not.toBe("unattributed");
    expect(await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
      .where(eq(imapIngestionMessages.userId, member.id))).toHaveLength(0);

    /* "Their own review queue" is what the inbox shows. The same message from
       a member is the yardstick: whatever lane it reaches, the administrator's
       must reach too, and no one else's inbox may show it. */
    const [row] = await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
      .where(eq(imapIngestionMessages.mailboxUidValidity, "4001"));
    mailboxHolding(4002n, attributedHeaders(fixture.users.member.email));
    await runImapIngestionCycle(config);
    const [memberRow] = await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
      .where(eq(imapIngestionMessages.mailboxUidValidity, "4002"));
    const idsOf = async (userId: string) => (await listImapInbox(userId)).receipts.map((entry: { id: string }) => entry.id);
    expect(await idsOf(member.id)).toEqual([memberRow.id]);
    expect(await idsOf(admin.id)).toEqual([row.id]);
  }, 30_000);

  it("4a: lists their own receipts in the inbox and no one else's (#1632)", async () => {
    const mine = await seedReceipt(admin.id);
    const theirs = await seedReceipt(member.id, { householdId: fixture.household.id });

    const inbox = await listImapInbox(admin.id);

    expect(inbox.receipts.map((receipt: { id: string }) => receipt.id)).toEqual([mine.receiptId]);
    expect(inbox.receipts.map((receipt: { id: string }) => receipt.id)).not.toContain(theirs.receiptId);
  });

  it("4b: opens their receipt for review only with a real membership of the chosen household (#1632)", async () => {
    const mine = await seedReceipt(admin.id);
    expect((await listImapInbox(admin.id)).receipts).toHaveLength(1);

    await expect(getImapReview(admin.id, mine.receiptId, fixture.household.id)).rejects.toMatchObject({ code: "inbox_receipt_not_found", status: 404 });

    await joinHousehold();
    /* As in the app: the receipt is placed in a household first, then read
       for review against that household. */
    await expect(assignImapReceiptHousehold(admin.id, mine.receiptId, fixture.household.id)).resolves.toEqual({ receiptId: mine.receiptId });
    const review = await getImapReview(admin.id, mine.receiptId, fixture.household.id);
    expect(review.receipt.id).toBe(mine.receiptId);
    expect(review.receipt.proposal).toMatchObject({ title: "Admin receipt" });
  });

  it("4c: files their receipt only with a real membership of the chosen household (#1632)", async () => {
    const mine = await seedReceipt(admin.id);
    expect((await listImapInbox(admin.id)).receipts).toHaveLength(1);
    const itemsBefore = (await householdItems()).length;

    await expect(approveReviewedIntake(admin.id, filing(mine.receiptId))).rejects.toMatchObject({ code: "household_not_found", status: 404 });
    await expect(assignImapReceiptHousehold(admin.id, mine.receiptId, fixture.household.id)).rejects.toMatchObject({ code: "household_not_found", status: 404 });
    expect(await householdItems()).toHaveLength(itemsBefore);

    await joinHousehold();
    /* Not yet assigned: the case a bare toThrow could not tell from a missing membership. */
    await expect(approveReviewedIntake(admin.id, filing(mine.receiptId))).rejects.toMatchObject({ code: "reviewed_intake_not_found", status: 404 });
    await expect(assignImapReceiptHousehold(admin.id, mine.receiptId, fixture.household.id)).resolves.toEqual({ receiptId: mine.receiptId });

    const result = await approveReviewedIntake(admin.id, filing(mine.receiptId));
    expect(result.outcome).toBe("approved");
    const after = await householdItems();
    expect(after).toHaveLength(itemsBefore + 1);
    const [row] = await getDb().select({ householdId: items.householdId }).from(items).where(eq(items.id, result.itemId as string));
    expect(row?.householdId).toBe(fixture.household.id);
    expect((await receiptRow(mine.receiptId))?.approvedItemId).toBe(result.itemId);
  });

  it("4f: files their receipt into a household they are a member of (#1642 M1)", async () => {
    const mine = await seedReceipt(admin.id);
    await joinHousehold();
    await expect(assignImapReceiptHousehold(admin.id, mine.receiptId, fixture.household.id)).resolves.toEqual({ receiptId: mine.receiptId });

    const result = await approveReviewedIntake(admin.id, filing(mine.receiptId));

    expect(result.outcome).toBe("approved");
    expect(typeof result.itemId).toBe("string");
    const filed = await getDb().select({ id: items.id, householdId: items.householdId, titleEnc: items.titleEnc })
      .from(items).where(eq(items.id, result.itemId as string));
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ id: result.itemId, householdId: fixture.household.id });
    const reader = await openMetadataReader(fixture.household.id);
    expect(reader.text("items.title", filed[0].id, { encrypted: filed[0].titleEnc }).value).toBe("Filed by the administrator");
    expect(await receiptRow(mine.receiptId)).toMatchObject({ approvedItemId: result.itemId, status: "completed" });
    const inbox = await listImapInbox(admin.id);
    expect(inbox.receipts.filter((receipt: { id: string; status?: string }) => receipt.id === mine.receiptId && receipt.status === "pending_review")).toHaveLength(0);

    const second = await seedReceipt(admin.id);
    await assignImapReceiptHousehold(admin.id, second.receiptId, fixture.household.id);
    const response = await approveViaRoute(second.receiptId);
    expect(response.status).toBe(200);
  });

  it("4g: is refused a household they are not a member of, with household_not_found (#1642 M1)", async () => {
    const mine = await seedReceipt(admin.id, { householdId: fixture.household.id });
    // The fixture seeds one item per household, so "nothing written" is "no change in count".
    const countIn = async (householdId: string) =>
      (await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, householdId))).length;
    const before = [await countIn(fixture.household.id), await countIn(fixture.secondHousehold.id)];

    await expect(approveReviewedIntake(admin.id, filing(mine.receiptId))).rejects.toMatchObject({ code: "household_not_found", status: 404 });
    const refused = await approveViaRoute(mine.receiptId);
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: { code: "household_not_found", message: "That household is not available" } });

    await joinHousehold();
    await expect(approveReviewedIntake(admin.id, { ...filing(mine.receiptId), householdId: fixture.secondHousehold.id }))
      .rejects.toMatchObject({ code: "household_not_found", status: 404 });

    expect([await countIn(fixture.household.id), await countIn(fixture.secondHousehold.id)]).toEqual(before);
    expect(await receiptRow(mine.receiptId)).toMatchObject({ status: "pending_review", approvalOperationId: null });
  });

  it("4d: previews an attachment on their own receipt (#1632)", async () => {
    const mine = await seedReceipt(admin.id);
    const session = await fixture.session("admin");

    const response = await callRouteForSession(previewAttachment, session, {
      url: previewUrl(mine.receiptId, mine.attachmentId),
      params: { receiptId: mine.receiptId, attachmentId: mine.attachmentId },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("4e: discards their own receipt (#1632)", async () => {
    const mine = await seedReceipt(admin.id);
    expect((await listImapInbox(admin.id)).receipts).toHaveLength(1);

    await discardImapReviewItem(admin.id, mine.receiptId);

    const [row] = await getDb().select({ status: imapIngestionMessages.status })
      .from(imapIngestionMessages).where(eq(imapIngestionMessages.id, mine.receiptId));
    expect(row?.status).not.toBe("pending_review");
    expect((await listImapInbox(admin.id)).receipts).toHaveLength(0);
  });

  it("5: gives an administrator no access to another user's receipt, the same 404 anyone gets (#1632)", async () => {
    /* A member of the very household the receipt belongs to, so membership is
       not what keeps the receipt out of reach: ownership is. */
    await joinHousehold();
    const theirs = await seedReceipt(member.id, { householdId: fixture.household.id });
    const adminOwn = await seedReceipt(admin.id);
    expect((await listImapInbox(admin.id)).receipts).toHaveLength(1);

    const peerError = await getImapReview(fixture.users.owner.id, theirs.receiptId, fixture.household.id).catch((error: unknown) => error);
    expect(peerError).toMatchObject({ code: "inbox_receipt_not_found" });
    await expect(getImapReview(admin.id, theirs.receiptId, fixture.household.id)).rejects.toMatchObject({
      code: "inbox_receipt_not_found",
      message: (peerError as Error).message,
    });
    await expect(discardImapReviewItem(admin.id, theirs.receiptId)).rejects.toMatchObject({ code: "inbox_receipt_not_found" });
    await expect(assignImapReceiptHousehold(admin.id, theirs.receiptId, fixture.household.id)).rejects.toMatchObject({ code: "inbox_receipt_not_found" });
    expect((await listImapInbox(admin.id)).receipts.map((receipt: { id: string }) => receipt.id)).toEqual([adminOwn.receiptId]);

    const response = await callRouteForSession(previewAttachment, await fixture.session("admin"), {
      url: previewUrl(theirs.receiptId, theirs.attachmentId),
      params: { receiptId: theirs.receiptId, attachmentId: theirs.attachmentId },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "inbox_receipt_not_found", message: "That incoming document is not available" },
    });
    const [untouched] = await getDb().select({ status: imapIngestionMessages.status })
      .from(imapIngestionMessages).where(eq(imapIngestionMessages.id, theirs.receiptId));
    expect(untouched?.status).toBe("pending_review");
  });

  it("6: leaves a member's relay, inbox and review exactly as they were (#1632)", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const reading = await readRelaySettings(member);
    expect(reading.address).toBe(relayAddressFor(member.id, 1, config));
    expect(reading.sender).toEqual({ address: fixture.users.member.email, verified: false, verificationPending: false, expiresAt: null, lastForwardSigned: null });

    const mine = await seedReceipt(member.id, { householdId: fixture.household.id });
    expect((await listImapInbox(member.id)).receipts.map((receipt: { id: string }) => receipt.id)).toEqual([mine.receiptId]);
    expect((await getImapReview(member.id, mine.receiptId, fixture.household.id)).receipt.id).toBe(mine.receiptId);
    const response = await callRouteForSession(previewAttachment, await fixture.session("member"), {
      url: previewUrl(mine.receiptId, mine.attachmentId),
      params: { receiptId: mine.receiptId, attachmentId: mine.attachmentId },
    });
    expect(response.status).toBe(200);

    expect((await rotateRelayAddress(member, "rotate")).address).toBe(relayAddressFor(member.id, 2, config));
    expect((await setRelayIngest(member, true)).ingest).toBe("paused");
  });
});
