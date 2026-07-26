import nodemailer from "nodemailer";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { imapIngestionAttachments, imapIngestionMessages, users } from "@/db/schema";
import { categorizeProviderError, getNotificationWorkerConfig } from "@/server/notification-worker";

interface ClaimedReceipt { id: string; leaseToken: string }

/** Atomically leases receipts so multiple web or worker replicas cannot send duplicates. */
async function claimReceipts(limit = 25): Promise<ClaimedReceipt[]> {
  const rows = await getDb().execute(sql<ClaimedReceipt>`
    with claimable as (
      select id
      from imap_ingestion_messages
      where receipt_status in ('pending', 'retry')
        or (receipt_status = 'processing' and receipt_locked_at < now() - interval '10 minutes')
      order by created_at
      for update skip locked
      limit ${limit}
    )
    update imap_ingestion_messages as message
    set receipt_status = 'processing',
        receipt_locked_at = now(),
        receipt_lease_token = gen_random_uuid(),
        receipt_attempts = message.receipt_attempts + 1,
        updated_at = now()
    from claimable
    where message.id = claimable.id
    returning message.id, message.receipt_lease_token as "leaseToken"
  `);
  return rows as unknown as ClaimedReceipt[];
}

/** Sends content-free IMAP receipts from durable records; retry state never stores provider text. */
export async function runImapReceiptCycle(): Promise<void> {
  const config = getNotificationWorkerConfig();
  const claimed = await claimReceipts();
  if (!claimed.length) return;
  const tokens = new Map(claimed.map((receipt) => [receipt.id, receipt.leaseToken]));
  const deliveries = await getDb().select({
    id: imapIngestionMessages.id,
    leaseToken: imapIngestionMessages.receiptLeaseToken,
    attempts: imapIngestionMessages.receiptAttempts,
    email: users.email,
    displayName: users.displayName,
    count: sql<number>`count(${imapIngestionAttachments.id})::int`,
  }).from(imapIngestionMessages).innerJoin(users, eq(users.id, imapIngestionMessages.userId))
    .leftJoin(imapIngestionAttachments, eq(imapIngestionAttachments.messageId, imapIngestionMessages.id))
    .where(inArray(imapIngestionMessages.id, claimed.map((receipt) => receipt.id)))
    .groupBy(imapIngestionMessages.id, users.email, users.displayName);
  const transporter = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl, { requireTLS: config.smtpSecurity === "starttls", tls: { minVersion: "TLSv1.2" } }) : undefined;
  for (const delivery of deliveries) {
    const leaseToken = tokens.get(delivery.id);
    if (!leaseToken || delivery.leaseToken !== leaseToken) continue;
    try {
      if (!transporter) throw Object.assign(new Error("SMTP is not configured"), { code: "smtp_unconfigured" });
      await transporter.sendMail({ from: config.smtpFrom, to: delivery.email, subject: "Orbit received your document", text: `Hello ${delivery.displayName},\n\nOrbit securely received ${delivery.count ? "your document attachment" : "your message"}. Review it in Orbit before it becomes visible in your household.\n` });
      await getDb().update(imapIngestionMessages).set({ receiptStatus: "sent", receiptSentAt: new Date(), receiptLockedAt: null, receiptLeaseToken: null, receiptFailureCode: null, updatedAt: new Date() }).where(and(eq(imapIngestionMessages.id, delivery.id), eq(imapIngestionMessages.receiptStatus, "processing"), eq(imapIngestionMessages.receiptLeaseToken, leaseToken)));
    } catch (error) {
      const category = (error as { code?: string }).code === "smtp_unconfigured" ? "smtp_unconfigured" : categorizeProviderError("email", error);
      const terminal = category === "smtp_unconfigured" || category === "smtp_rejected" || delivery.attempts >= config.maxAttempts;
      await getDb().update(imapIngestionMessages).set({ receiptStatus: terminal ? (category === "smtp_unconfigured" || category === "smtp_rejected" ? "cancelled" : "failed") : "retry", receiptLockedAt: null, receiptLeaseToken: null, receiptFailureCode: category, updatedAt: new Date() }).where(and(eq(imapIngestionMessages.id, delivery.id), eq(imapIngestionMessages.receiptStatus, "processing"), eq(imapIngestionMessages.receiptLeaseToken, leaseToken)));
    }
  }
}

const workerState = globalThis as typeof globalThis & { __orbitImapReceiptWorkerStarted?: boolean };
export function startImapReceiptWorker(): void {
  if (workerState.__orbitImapReceiptWorkerStarted) return;
  workerState.__orbitImapReceiptWorkerStarted = true;
  const poll = async () => { try { await runImapReceiptCycle(); } catch { console.error("Orbit IMAP receipt cycle failed"); } finally { setTimeout(poll, getNotificationWorkerConfig().pollMilliseconds).unref(); } };
  void poll();
}
