/**
 * mail-in/core boundary: pure parsing/config logic only. No `getDb`/`db`/
 * schema imports and no `imapflow` import — see src/server/mail-in/README.md.
 * Extracted from imap-ingestion.ts as part of the #298 module split; the
 * original module re-exports these so every existing import path keeps
 * working unchanged.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { readRuntimeSecret } from "@/lib/runtime-secret";
import type { NotificationWorkerConfig } from "@/server/notification-worker";
import { IMAP_ATTACHMENT_LIMITS } from "./imap-attachment-validation";
import type { ImapAliasGeneration } from "./imap-recipient";

const ingestionEnvironmentSchema = z.object({
  IMAP_ENABLED: z.enum(["true", "false"]).optional().default("true").transform((value) => value === "true"),
  IMAP_HOST: z.string().trim().max(253).optional().default(""),
  IMAP_PORT: z.coerce.number().int().min(1).max(65_535).default(993),
  IMAP_USER: z.string().trim().max(512).optional().default(""),
  IMAP_PASSWORD: z.string().optional().default(""),
  IMAP_MAILBOX: z.string().trim().min(1).max(255).default("INBOX"),
  IMAP_TLS_SERVER_NAME: z.string().trim().max(253).optional().default(""),
  IMAP_RECIPIENT_DOMAIN: z.string().trim().toLowerCase().max(253).optional().default(""),
  IMAP_TRUSTED_RECIPIENT_HEADER: z.string().trim().regex(/^[A-Za-z0-9-]{1,80}$/).optional().default(""),
  IMAP_POLL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  SMTP_URL: z.string().optional().default(""),
  SMTP_HOST: z.string().optional().default(""),
});

export interface ImapIngestionConfig {
  configured: boolean;
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox: string;
  tlsServerName: string;
  recipientDomain: string;
  currentAliasGeneration: number;
  currentAliasSecret: string;
  previousAliasGeneration?: number;
  previousAliasSecret?: string;
  previousAliasExpiresAt?: Date;
  aliasCurrent: ImapAliasGeneration;
  aliasPrevious?: ImapAliasGeneration;
  /** Deprecated in-memory compatibility name; never persist or log it. */
  aliasSecret: string;
  trustedRecipientHeader: string;
  pollMilliseconds: number;
}

/** TLS-only provider options shared by polling and bounded verification. */
export function imapProviderConnectionOptions(config: ImapIngestionConfig) {
  return {
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.password },
    tls: { rejectUnauthorized: true, servername: config.tlsServerName || config.host },
    logger: false as const,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    maxLiteralSize: IMAP_ATTACHMENT_LIMITS.rawMessageBytes,
  };
}

/** Non-secret configuration commitment used only to invalidate stale preflight results. */
export function imapProviderConfigCommitment(config: ImapIngestionConfig, smtp: NotificationWorkerConfig): string {
  return createHash("sha256").update(JSON.stringify([
    "orbit:mail-provider-preflight:v1",
    config.host, config.port, config.user, config.mailbox, config.tlsServerName,
    config.recipientDomain, config.trustedRecipientHeader, config.currentAliasGeneration,
    config.previousAliasGeneration ?? null, config.previousAliasExpiresAt?.toISOString() ?? null,
    smtp.smtpSecurity, smtp.smtpFrom,
  ])).digest("hex");
}

const MAX_PREVIOUS_ALIAS_TRANSITION_MS = 90 * 86_400_000;

function runtimeSecretFromNames(environment: NodeJS.ProcessEnv, names: string[]): string | undefined {
  const configuredNames = names.filter((name) => {
    const direct = environment[name];
    const file = environment[`${name}_FILE`];
    return (typeof direct === "string" && direct.length > 0) || (typeof file === "string" && file.length > 0);
  });
  if (configuredNames.length > 1) throw new Error(`${names.join(" or ")} cannot both be configured`);
  return configuredNames.length ? readRuntimeSecret(environment, configuredNames[0]) : undefined;
}

function positiveGeneration(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error(`${label} must be a positive integer`);
  return generation;
}

function previousExpiry(value: string | undefined): Date | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) {
    throw new Error("IMAP_ALIAS_PREVIOUS_EXPIRES_AT must be an explicit UTC timestamp");
  }
  const expiry = new Date(value);
  if (Number.isNaN(expiry.getTime())) throw new Error("IMAP_ALIAS_PREVIOUS_EXPIRES_AT must be an explicit UTC timestamp");
  if (expiry.getTime() > Date.now() + MAX_PREVIOUS_ALIAS_TRANSITION_MS) {
    throw new Error("IMAP previous alias expiry exceeds the bounded rotation window");
  }
  return expiry;
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
    SMTP_URL: readRuntimeSecret(environment, "SMTP_URL"),
  });
  const configuredValues = [parsed.IMAP_HOST, parsed.IMAP_USER, parsed.IMAP_PASSWORD].filter(Boolean).length;
  if (configuredValues !== 0 && configuredValues !== 3) {
    throw new Error("IMAP_HOST, IMAP_USER, and IMAP_PASSWORD must be configured together");
  }
  if (configuredValues === 3 && parsed.IMAP_ENABLED && !parsed.SMTP_URL && !parsed.SMTP_HOST) {
    throw new Error("SMTP must be configured before IMAP ingestion is enabled");
  }
  const currentAliasSecret = runtimeSecretFromNames(environment, ["IMAP_ALIAS_CURRENT_SECRET", "IMAP_ALIAS_CURRENT_KEY", "IMAP_ALIAS_SECRET"]);
  const currentAliasGeneration = positiveGeneration(
    environment.IMAP_ALIAS_CURRENT_GENERATION || environment.IMAP_ALIAS_GENERATION,
    "IMAP alias current generation",
  );
  const previousAliasSecret = runtimeSecretFromNames(environment, ["IMAP_ALIAS_PREVIOUS_SECRET", "IMAP_ALIAS_PREVIOUS_KEY"]);
  const previousAliasGeneration = positiveGeneration(environment.IMAP_ALIAS_PREVIOUS_GENERATION, "IMAP alias previous generation");
  const previousAliasExpiresAt = previousExpiry(environment.IMAP_ALIAS_PREVIOUS_EXPIRES_AT || environment.IMAP_ALIAS_PREVIOUS_EXPIRY);
  const previousConfiguredValues = [previousAliasGeneration, previousAliasSecret, previousAliasExpiresAt].filter((value) => value !== undefined).length;
  if (configuredValues === 3 && (!parsed.IMAP_RECIPIENT_DOMAIN || !parsed.IMAP_TRUSTED_RECIPIENT_HEADER || !currentAliasGeneration || !currentAliasSecret)) {
    throw new Error("IMAP_RECIPIENT_DOMAIN, IMAP alias current generation and secret, and IMAP_TRUSTED_RECIPIENT_HEADER are required for verified recipient aliases");
  }
  if (configuredValues === 3 && currentAliasSecret && currentAliasSecret.length < 32) {
    throw new Error("IMAP alias current secret must be at least 32 characters");
  }
  if (configuredValues === 3 && previousAliasSecret && previousAliasSecret.length < 32) {
    throw new Error("IMAP alias previous secret must be at least 32 characters");
  }
  if (previousConfiguredValues !== 0 && previousConfiguredValues !== 3) {
    throw new Error("IMAP alias previous generation, secret, and expiry must be configured together");
  }
  if (previousAliasGeneration && currentAliasGeneration === previousAliasGeneration) {
    throw new Error("IMAP alias current and previous generations must be distinct");
  }
  const currentAlias: ImapAliasGeneration = {
    generation: currentAliasGeneration ?? 1,
    secret: currentAliasSecret ?? "",
  };
  const aliasPrevious = previousConfiguredValues === 3 && previousAliasGeneration && previousAliasSecret && previousAliasExpiresAt
    ? { generation: previousAliasGeneration, secret: previousAliasSecret, expiresAt: previousAliasExpiresAt }
    : undefined;
  return {
    configured: configuredValues === 3,
    enabled: configuredValues === 3 && parsed.IMAP_ENABLED,
    host: parsed.IMAP_HOST,
    port: parsed.IMAP_PORT,
    user: parsed.IMAP_USER,
    password: parsed.IMAP_PASSWORD,
    mailbox: parsed.IMAP_MAILBOX,
    tlsServerName: parsed.IMAP_TLS_SERVER_NAME,
    recipientDomain: parsed.IMAP_RECIPIENT_DOMAIN,
    currentAliasGeneration: currentAlias.generation,
    currentAliasSecret: currentAlias.secret,
    previousAliasGeneration: aliasPrevious?.generation,
    previousAliasSecret: aliasPrevious?.secret,
    previousAliasExpiresAt: aliasPrevious?.expiresAt,
    aliasCurrent: currentAlias,
    aliasPrevious,
    aliasSecret: currentAlias.secret,
    trustedRecipientHeader: parsed.IMAP_TRUSTED_RECIPIENT_HEADER,
    pollMilliseconds: parsed.IMAP_POLL_SECONDS * 1_000,
  };
}

/** Bounded retry schedule shared by claim tests and the attachment worker. */
export function imapAttachmentRetryDelayMs(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("IMAP attachment attempt is invalid");
  return Math.min(15 * 60_000, 1_000 * 2 ** Math.min(attempts - 1, 10));
}
