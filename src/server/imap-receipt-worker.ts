import nodemailer from "nodemailer";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { imapIngestionAttachments, imapIngestionMessages, users } from "@/db/schema";
import { categorizeProviderError, getNotificationWorkerConfig } from "@/server/notification-worker";

/** Sends content-free IMAP receipts from durable records; retry state never stores provider text. */
export async function runImapReceiptCycle(): Promise<void> {
  const config = getNotificationWorkerConfig();
  const staleBefore = new Date(Date.now() - Math.max(config.pollMilliseconds * 3, 60_000));
  const candidates = await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
    .where(or(inArray(imapIngestionMessages.receiptStatus, ["pending", "retry"]), and(eq(imapIngestionMessages.receiptStatus, "processing"), lt(imapIngestionMessages.updatedAt, staleBefore)))).limit(25);
  if (!candidates.length) return;
  const ids = candidates.map((row) => row.id);
  await getDb().update(imapIngestionMessages).set({ receiptStatus: "processing", updatedAt: new Date() })
    .where(and(inArray(imapIngestionMessages.id, ids), or(inArray(imapIngestionMessages.receiptStatus, ["pending", "retry"]), and(eq(imapIngestionMessages.receiptStatus, "processing"), lt(imapIngestionMessages.updatedAt, staleBefore)))));
  const deliveries = await getDb().select({ id: imapIngestionMessages.id, attempts: imapIngestionMessages.receiptAttempts, email: users.email, displayName: users.displayName, count: sql<number>`count(${imapIngestionAttachments.id})::int` })
    .from(imapIngestionMessages).innerJoin(users, eq(users.id, imapIngestionMessages.userId))
    .leftJoin(imapIngestionAttachments, eq(imapIngestionAttachments.messageId, imapIngestionMessages.id))
    .where(and(inArray(imapIngestionMessages.id, ids), eq(imapIngestionMessages.receiptStatus, "processing"))).groupBy(imapIngestionMessages.id, users.email, users.displayName);
  const transporter = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl, { requireTLS: config.smtpSecurity === "starttls", tls: { minVersion: "TLSv1.2" } }) : undefined;
  for (const delivery of deliveries) {
    const attempts = delivery.attempts + 1;
    try {
      if (!transporter) throw Object.assign(new Error("SMTP is not configured"), { code: "smtp_unconfigured" });
      await transporter.sendMail({ from: config.smtpFrom, to: delivery.email, subject: "Orbit received your document", text: `Hello ${delivery.displayName},\n\nOrbit securely received ${delivery.count ? "your document attachment" : "your message"}. Review it in Orbit before it becomes visible in your household.\n` });
      await getDb().update(imapIngestionMessages).set({ receiptStatus: "sent", receiptAttempts: attempts, receiptSentAt: new Date(), receiptFailureCode: null, updatedAt: new Date() }).where(and(eq(imapIngestionMessages.id, delivery.id), eq(imapIngestionMessages.receiptStatus, "processing")));
    } catch (error) {
      const category = (error as { code?: string }).code === "smtp_unconfigured" ? "smtp_unconfigured" : categorizeProviderError("email", error);
      const terminal = category === "smtp_unconfigured" || category === "smtp_rejected" || attempts >= config.maxAttempts;
      await getDb().update(imapIngestionMessages).set({ receiptStatus: terminal ? (category === "smtp_unconfigured" || category === "smtp_rejected" ? "cancelled" : "failed") : "retry", receiptAttempts: attempts, receiptFailureCode: category, updatedAt: new Date() }).where(and(eq(imapIngestionMessages.id, delivery.id), eq(imapIngestionMessages.receiptStatus, "processing")));
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
