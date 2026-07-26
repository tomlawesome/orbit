import { createHmac, timingSafeEqual } from "node:crypto";
import { ImapFlow } from "imapflow";
import { z } from "zod";
import { readRuntimeSecret } from "@/lib/runtime-secret";

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
