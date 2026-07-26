import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ImapFlow, type MessageStructureObject } from "imapflow";
import { eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { imapIngestionAttachments, imapIngestionMessages, users } from "@/db/schema";
import { readRuntimeSecret } from "@/lib/runtime-secret";
import { scanAndHoldImapAttachment } from "@/server/imap-attachment-holding";
import { imapReceiptDestination } from "@/server/imap-inbox";
import { materializeImapReviewItem } from "@/server/imap-review-items";

const ingestionEnvironmentSchema = z.object({
  IMAP_HOST: z.string().trim().max(253).optional().default(""),
  IMAP_PORT: z.coerce.number().int().min(1).max(65_535).default(993),
  IMAP_USER: z.string().trim().max(512).optional().default(""),
  IMAP_PASSWORD: z.string().optional().default(""),
  IMAP_MAILBOX: z.string().trim().min(1).max(255).default("INBOX"),
  IMAP_TLS_SERVER_NAME: z.string().trim().max(253).optional().default(""),
  IMAP_RECIPIENT_DOMAIN: z.string().trim().toLowerCase().max(253).optional().default(""),
  IMAP_ALIAS_SECRET: z.string().min(32).optional().default(""),
  IMAP_TRUSTED_RECIPIENT_HEADER: z.string().trim().regex(/^[A-Za-z0-9-]{1,80}$/).optional().default(""),
  IMAP_POLL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  SMTP_URL: z.string().optional().default(""),
});

export interface ImapIngestionConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox: string;
  tlsServerName: string;
  recipientDomain: string;
  aliasSecret: string;
  trustedRecipientHeader: string;
  pollMilliseconds: number;
}

/**
 * Resolves the dedicated inbound mailbox configuration. IMAP is deliberately
 * disabled unless every required value is present; Orbit never downgrades to
 * plaintext IMAP or accepts a partial credential set.
 */
export function getImapIngestionConfig(environment: NodeJS.ProcessEnv = process.env): ImapIngestionConfig {
  const parsed = ingestionEnvironmentSchema.parse({
    ...environment,
    IMAP_PASSWORD: readRuntimeSecret(environment, "IMAP_PASSWORD"),
    IMAP_ALIAS_SECRET: readRuntimeSecret(environment, "IMAP_ALIAS_SECRET"),
    SMTP_URL: readRuntimeSecret(environment, "SMTP_URL"),
  });
  const configuredValues = [parsed.IMAP_HOST, parsed.IMAP_USER, parsed.IMAP_PASSWORD].filter(Boolean).length;
  if (configuredValues !== 0 && configuredValues !== 3) {
    throw new Error("IMAP_HOST, IMAP_USER, and IMAP_PASSWORD must be configured together");
  }
  if (configuredValues === 3 && !parsed.SMTP_URL) {
    throw new Error("SMTP_URL must be configured before IMAP ingestion is enabled");
  }
  if (configuredValues === 3 && (!parsed.IMAP_RECIPIENT_DOMAIN || !parsed.IMAP_ALIAS_SECRET || !parsed.IMAP_TRUSTED_RECIPIENT_HEADER)) {
    throw new Error("IMAP_RECIPIENT_DOMAIN, IMAP_ALIAS_SECRET, and IMAP_TRUSTED_RECIPIENT_HEADER are required for verified recipient aliases");
  }
  return {
    enabled: configuredValues === 3,
    host: parsed.IMAP_HOST,
    port: parsed.IMAP_PORT,
    user: parsed.IMAP_USER,
    password: parsed.IMAP_PASSWORD,
    mailbox: parsed.IMAP_MAILBOX,
    tlsServerName: parsed.IMAP_TLS_SERVER_NAME,
    recipientDomain: parsed.IMAP_RECIPIENT_DOMAIN,
    aliasSecret: parsed.IMAP_ALIAS_SECRET,
    trustedRecipientHeader: parsed.IMAP_TRUSTED_RECIPIENT_HEADER,
    pollMilliseconds: parsed.IMAP_POLL_SECONDS * 1_000,
  };
}

/** A deterministic opaque forwarding alias; the user ID and secret never appear in the address. */
export function imapRecipientAlias(userId: string, config = getImapIngestionConfig()): string {
  if (!config.enabled) throw new Error("IMAP ingestion is not configured");
  const token = createHmac("sha256", config.aliasSecret).update(`orbit-imap-alias:${userId}`).digest("base64url");
  return `orbit+${token}@${config.recipientDomain}`;
}

/** Constant-time comparison for the provider-injected delivery recipient value. */
export function matchesImapRecipientAlias(value: string, userId: string, config = getImapIngestionConfig()): boolean {
  const received = Buffer.from(value.trim().toLowerCase());
  const expected = Buffer.from(imapRecipientAlias(userId, config).toLowerCase());
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Reads one provider-injected recipient header without retaining raw mail headers. */
export function trustedRecipientFromHeaders(headers: Buffer | undefined, headerName: string): string | undefined {
  if (!headers) return undefined;
  const lines = headers.toString("utf8").replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
  const prefix = `${headerName.toLowerCase()}:`;
  const value = lines.find((line) => line.toLowerCase().startsWith(prefix))?.slice(prefix.length).trim();
  return value?.slice(0, 512) || undefined;
}

async function userForRecipientAlias(recipient: string, config: ImapIngestionConfig): Promise<string | undefined> {
  const candidates = await getDb().select({ id: users.id }).from(users).where(isNull(users.disabledAt));
  return candidates.find((candidate) => matchesImapRecipientAlias(recipient, candidate.id, config))?.id;
}

function attachmentParts(structure: MessageStructureObject | undefined): string[] {
  if (!structure) return [];
  const children = structure.childNodes?.flatMap(attachmentParts) ?? [];
  return structure.part && structure.disposition?.toLowerCase() === "attachment" ? [structure.part, ...children] : children;
}

/**
 * Polls the dedicated mailbox and records only an idempotent receipt. It does
 * not parse, retain, attach, create, or merge household data; later review
 * work must explicitly choose a household and approve a document draft.
 */
export async function runImapIngestionCycle(config = getImapIngestionConfig()): Promise<void> {
  if (!config.enabled) return;
  const client = new ImapFlow({
    host: config.host, port: config.port, secure: true,
    auth: { user: config.user, pass: config.password },
    tls: { rejectUnauthorized: true, servername: config.tlsServerName || config.host },
    logger: false, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000,
    maxLiteralSize: 32 * 1024 * 1024,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(config.mailbox, { readOnly: true });
    try {
      if (!client.mailbox) throw new Error("IMAP mailbox could not be opened");
      const uidValidity = client.mailbox.uidValidity.toString();
      for await (const message of client.fetch({ seen: false }, { uid: true, headers: [config.trustedRecipientHeader], source: { maxLength: 25 * 1024 * 1024 }, internalDate: true, size: true, bodyStructure: true }, { uid: true })) {
        const source = message.source;
        const oversized = !source || (message.size ?? 0) > 25 * 1024 * 1024 || source.length > 25 * 1024 * 1024;
        const recipient = trustedRecipientFromHeaders(message.headers, config.trustedRecipientHeader);
        const userId = recipient ? await userForRecipientAlias(recipient, config) : undefined;
        const destination = userId ? await imapReceiptDestination(userId) : undefined;
        const contentSha256 = oversized
          ? createHash("sha256").update(`oversized:${uidValidity}:${message.uid}`).digest("hex")
          : createHash("sha256").update(source!).digest("hex");
        const aliasSha256 = createHash("sha256").update(recipient ?? "").digest("hex");
        const [receipt] = await getDb().insert(imapIngestionMessages).values({
          mailbox: config.mailbox, mailboxUidValidity: uidValidity, mailboxUid: message.uid,
          contentSha256, recipientAliasSha256: aliasSha256, userId: userId ?? null, householdId: destination?.householdId ?? null,
          status: oversized ? "failed" : userId ? "pending_review" : "quarantined",
          failureCode: oversized ? "message_too_large" : userId ? null : "recipient_unverified",
          receivedAt: message.internalDate instanceof Date ? message.internalDate : new Date(),
        }).onConflictDoNothing().returning({ id: imapIngestionMessages.id });
        if (receipt && userId && !oversized) {
          try {
            const parts = attachmentParts(message.bodyStructure);
            const downloads = parts.length ? await client.downloadMany(message.uid, parts, { uid: true }) : {};
            for (const download of Object.values(downloads)) {
              if (!download.content) continue;
              const held = await scanAndHoldImapAttachment({ bytes: download.content, filename: download.meta.filename, declaredMediaType: download.meta.contentType });
              await getDb().insert(imapIngestionAttachments).values({
                id: held.id, messageId: receipt.id, displayName: held.displayName, mediaType: held.mediaType,
                sizeBytes: held.sizeBytes, contentSha256: held.contentSha256, storageKey: held.storageKey,
                ciphertextSize: held.ciphertextSize, ...held.envelope,
              }).onConflictDoNothing();
              download.content.fill(0);
            }
            if (destination?.householdId) await materializeImapReviewItem(userId, receipt.id);
          } catch {
            await getDb().update(imapIngestionMessages).set({ status: "failed", failureCode: "attachment_processing_failed", updatedAt: new Date() }).where(eq(imapIngestionMessages.id, receipt.id));
          }
        }
        message.source?.fill(0);
      }
    } finally { lock.release(); }
  } finally {
    try { await client.logout(); } catch { /* Network failure already has no raw-mail logging. */ }
  }
}

const workerState = globalThis as typeof globalThis & {
  __orbitImapWorkerStarted?: boolean;
  __orbitImapWorkerRunning?: boolean;
  __orbitImapWorkerLastSuccessAt?: string;
  __orbitImapWorkerLastErrorAt?: string;
};

export function getImapIngestionWorkerHealth() {
  return {
    started: workerState.__orbitImapWorkerStarted ?? false,
    running: workerState.__orbitImapWorkerRunning ?? false,
    lastSuccessAt: workerState.__orbitImapWorkerLastSuccessAt ?? null,
    lastErrorAt: workerState.__orbitImapWorkerLastErrorAt ?? null,
  };
}

/** Starts one polling loop per process; receipt uniqueness protects replica workers. */
export function startImapIngestionWorker(config = getImapIngestionConfig()): void {
  if (workerState.__orbitImapWorkerStarted || !config.enabled) return;
  workerState.__orbitImapWorkerStarted = true;
  const poll = async () => {
    workerState.__orbitImapWorkerRunning = true;
    try {
      await runImapIngestionCycle(config);
      workerState.__orbitImapWorkerLastSuccessAt = new Date().toISOString();
    } catch {
      workerState.__orbitImapWorkerLastErrorAt = new Date().toISOString();
      console.error("Orbit IMAP ingestion cycle failed");
    } finally {
      workerState.__orbitImapWorkerRunning = false;
      setTimeout(poll, config.pollMilliseconds).unref();
    }
  };
  void poll();
}

/** Establishes a bounded TLS-only connection without listing or fetching mail. */
export async function verifyImapProvider(config = getImapIngestionConfig()): Promise<"ready" | "imap_unconfigured" | "imap_unavailable"> {
  if (!config.enabled) return "imap_unconfigured";
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.password },
    tls: { rejectUnauthorized: true, servername: config.tlsServerName || config.host },
    logger: false,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 5_000,
    maxLiteralSize: 32 * 1024 * 1024,
    verifyOnly: true,
  });
  try {
    await client.connect();
    return "ready";
  } catch {
    return "imap_unavailable";
  } finally {
    try { await client.logout(); } catch { /* Connection may not have completed. */ }
  }
}
