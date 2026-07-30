import { createHash, randomUUID } from "node:crypto";
import { ImapFlow, type MessageStructureObject } from "imapflow";
import { and, asc, eq, gt, inArray, isNull, lte, lt, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { imapIngestionAttachments, imapIngestionMessages, imapIngestionStagingObjects, imapRecipientAliases, imapRecipientRotationState, users } from "@/db/schema";
import { readRuntimeSecret } from "@/lib/runtime-secret";
import { getNotificationWorkerConfig, verifySmtpProviderConnection, type NotificationWorkerConfig } from "@/server/notification-worker";
import { purgeHeldImapAttachment, scanAndHoldImapAttachment } from "@/server/imap-attachment-holding";
import { getDocumentConfig } from "@/server/documents/config";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { classifyImapBodyStructure, IMAP_ATTACHMENT_LIMITS, type ImapAttachmentCandidate } from "@/server/imap-attachment-validation";
import {
  deriveImapRecipientAlias,
  digestImapAliasConfiguration,
  digestImapRecipientAlias,
  matchImapRecipientAliasGeneration,
  normalizeImapRecipientAlias,
  parseTrustedRecipientHeader,
  type ImapAliasGeneration,
} from "@/server/imap-recipient";
import {
  decideImapRotationState,
  type ImapRotationConfigState,
  type ImapRotationState,
} from "@/server/imap-rotation";

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

export type ImapPreflightStatus = "not_configured" | "disabled" | "verification_pending" | "available" | "provider_unavailable" | "unsafe_input" | "retrying" | "exhausted" | "retention_backlog";

export interface ImapProviderPreflightState {
  status: ImapPreflightStatus;
  smtp: "not_configured" | "available" | "provider_unavailable" | "unsafe_input";
  imap: "not_configured" | "available" | "provider_unavailable" | "unsafe_input";
  checkedAt: string | null;
}

export interface ImapProviderVerificationDependencies {
  verifySmtp?: (config: NotificationWorkerConfig) => Promise<"ready" | "smtp_unconfigured" | "smtp_unavailable" | "smtp_rejected" | "unsafe_input">;
  verifyImap?: (config: ImapIngestionConfig) => Promise<"ready" | "imap_unconfigured" | "imap_unavailable">;
}

export type ImapClientFactory = (config: ImapIngestionConfig) => ImapFlow;
let imapClientFactoryForTests: ImapClientFactory | undefined;

const providerState = globalThis as typeof globalThis & {
  __orbitImapProviderPreflight?: ImapProviderPreflightState & { commitment?: string; inFlight?: Promise<ImapProviderPreflightState> };
};

/** Injects a deterministic provider adapter for receipt/restart contract tests. */
export function setImapClientFactoryForTests(factory: ImapClientFactory | undefined): void {
  imapClientFactoryForTests = factory;
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

function createImapClient(config: ImapIngestionConfig, verifyOnly = false): ImapFlow {
  if (imapClientFactoryForTests) return imapClientFactoryForTests(config);
  return new ImapFlow({ ...imapProviderConnectionOptions(config), ...(verifyOnly ? { verifyOnly: true } : {}) });
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

export function getImapProviderPreflightState(config?: ImapIngestionConfig, smtp?: NotificationWorkerConfig): ImapProviderPreflightState {
  const state = providerState.__orbitImapProviderPreflight;
  if (config && !config.configured) return { status: "not_configured", smtp: "not_configured", imap: "not_configured", checkedAt: null };
  if (config && !config.enabled) return { status: "disabled", smtp: "not_configured", imap: "not_configured", checkedAt: null };
  if (state && config && smtp && state.commitment !== imapProviderConfigCommitment(config, smtp) && config.enabled) {
    return { status: "verification_pending", smtp: "not_configured", imap: "not_configured", checkedAt: null };
  }
  return state ? { status: state.status, smtp: state.smtp, imap: state.imap, checkedAt: state.checkedAt } : {
    status: "verification_pending", smtp: "not_configured", imap: "not_configured", checkedAt: null,
  };
}

/** Verifies both independent providers before a worker is allowed to poll. */
export async function verifyImapIngestionProviders(
  config = getImapIngestionConfig(),
  smtp = getNotificationWorkerConfig(),
  dependencies: ImapProviderVerificationDependencies = {},
): Promise<ImapProviderPreflightState> {
  const commitment = imapProviderConfigCommitment(config, smtp);
  if (!config.configured) {
    const state: ImapProviderPreflightState = { status: "not_configured", smtp: "not_configured", imap: "not_configured", checkedAt: new Date().toISOString() };
    providerState.__orbitImapProviderPreflight = { ...state, commitment };
    return state;
  }
  if (!config.enabled) {
    const state: ImapProviderPreflightState = { status: "disabled", smtp: smtp.smtpUrl ? "not_configured" : "not_configured", imap: "not_configured", checkedAt: null };
    providerState.__orbitImapProviderPreflight = { ...state, commitment };
    return state;
  }
  const previous = providerState.__orbitImapProviderPreflight;
  if (previous?.commitment === commitment && previous.status === "available" && previous.checkedAt
    && Date.now() - Date.parse(previous.checkedAt) < 60_000) return getImapProviderPreflightState();
  if (previous?.commitment === commitment && previous.inFlight) return previous.inFlight;

  const pending: ImapProviderPreflightState = { status: "verification_pending", smtp: "not_configured", imap: "not_configured", checkedAt: null };
  const inFlight = (async () => {
    const [smtpVerification, imapVerification] = await Promise.allSettled([
      dependencies.verifySmtp?.(smtp) ?? verifySmtpProviderConnection(smtp),
      dependencies.verifyImap?.(config) ?? verifyImapProvider(config),
    ]);
    const smtpResult = smtpVerification.status === "fulfilled" ? smtpVerification.value : "smtp_unavailable";
    const imapResult = imapVerification.status === "fulfilled" ? imapVerification.value : "imap_unavailable";
    const smtpStatus = smtpResult === "ready" ? "available" : smtpResult === "smtp_unconfigured" ? "not_configured" : smtpResult === "unsafe_input" ? "unsafe_input" : "provider_unavailable";
    const imapStatus = imapResult === "ready" ? "available" : imapResult === "imap_unconfigured" ? "not_configured" : "provider_unavailable";
    const status: ImapPreflightStatus = smtpStatus === "unsafe_input" ? "unsafe_input"
      : smtpStatus === "available" && imapStatus === "available" ? "available"
      : smtpStatus === "not_configured" || imapStatus === "not_configured" ? "not_configured"
      : "provider_unavailable";
    const state: ImapProviderPreflightState = { status, smtp: smtpStatus, imap: imapStatus, checkedAt: new Date().toISOString() };
    providerState.__orbitImapProviderPreflight = { ...state, commitment };
    return state;
  })();
  providerState.__orbitImapProviderPreflight = { ...pending, commitment, inFlight };
  return inFlight;
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

/** A deterministic opaque forwarding alias; the user ID, key, and generation never appear in the address. */
export function imapRecipientAlias(userId: string, config = getImapIngestionConfig()): string {
  if (!config.enabled) throw new Error("IMAP ingestion is not configured");
  return deriveImapRecipientAlias(userId, config.recipientDomain, config.aliasCurrent);
}

/** Constant-time comparison for the provider-injected delivery recipient value. */
export function matchesImapRecipientAlias(value: string, userId: string, config = getImapIngestionConfig()): boolean {
  if (!config.enabled) return false;
  return matchImapRecipientAliasGeneration(value, userId, config.recipientDomain, config.aliasCurrent)
    || Boolean(config.aliasPrevious && matchImapRecipientAliasGeneration(value, userId, config.recipientDomain, config.aliasPrevious));
}

/** Reads one provider-injected recipient header without retaining raw mail headers. */
export function trustedRecipientFromHeaders(headers: Buffer | undefined, headerName: string): string | undefined {
  const result = parseTrustedRecipientHeader(headers, headerName);
  return result.kind === "value" ? result.value : undefined;
}

type RecipientResolution = {
  userId?: string;
  generation?: number;
  failureCode?: string;
  digest?: string;
};

function trustedRecipientFailure(result: ReturnType<typeof parseTrustedRecipientHeader>): string | undefined {
  switch (result.kind) {
    case "missing": return "recipient_missing";
    case "duplicate": return "recipient_header_ambiguous";
    case "folded": return "recipient_header_folded";
    case "malformed": return "recipient_header_malformed";
    default: return undefined;
  }
}

type ImapDbExecutor = Pick<ReturnType<typeof getDb>, "select" | "insert" | "update">;

function rotationConfigState(config: ImapIngestionConfig, now: Date): ImapRotationConfigState {
  const activePrevious = config.aliasPrevious && config.aliasPrevious.expiresAt && config.aliasPrevious.expiresAt.getTime() > now.getTime()
    ? config.aliasPrevious
    : undefined;
  return {
    currentGeneration: config.aliasCurrent.generation,
    currentCommitment: digestImapAliasConfiguration(config.recipientDomain, config.trustedRecipientHeader, config.aliasCurrent),
    previousGeneration: activePrevious?.generation,
    previousExpiresAt: activePrevious?.expiresAt,
    previousCommitment: activePrevious ? digestImapAliasConfiguration(config.recipientDomain, config.trustedRecipientHeader, activePrevious) : undefined,
  };
}

function sameRotationState(left: ImapRotationState, right: ImapRotationState): boolean {
  return left.currentGeneration === right.currentGeneration
    && left.currentCommitment === right.currentCommitment
    && left.previousGeneration === right.previousGeneration
    && left.previousExpiresAt?.getTime() === right.previousExpiresAt?.getTime()
    && left.previousCommitment === right.previousCommitment;
}

async function readPersistedImapRotationState(executor: ImapDbExecutor, lock: boolean): Promise<ImapRotationState | null> {
  const query = executor.select({
    currentGeneration: imapRecipientRotationState.currentGeneration,
    currentCommitment: imapRecipientRotationState.currentCommitment,
    previousGeneration: imapRecipientRotationState.previousGeneration,
    previousExpiresAt: imapRecipientRotationState.previousExpiresAt,
    previousCommitment: imapRecipientRotationState.previousCommitment,
  }).from(imapRecipientRotationState).where(eq(imapRecipientRotationState.id, 1)).limit(1);
  const rows = lock ? await query.for("update") : await query;
  const row = rows[0];
  return row
    ? {
      currentGeneration: row.currentGeneration,
      currentCommitment: row.currentCommitment,
      previousGeneration: row.previousGeneration,
      previousExpiresAt: row.previousExpiresAt,
      previousCommitment: row.previousCommitment,
    }
    : null;
}

/** Locks and advances the database-authoritative singleton before any alias or receipt mutation. */
async function ensureImapRotationAuthority(executor: ImapDbExecutor, config: ImapIngestionConfig, now: Date): Promise<ImapRotationState> {
  let persisted = await readPersistedImapRotationState(executor, true);
  if (!persisted) {
    const initial = decideImapRotationState(null, rotationConfigState(config, now), now);
    await executor.insert(imapRecipientRotationState).values({
      id: 1,
      currentGeneration: initial.currentGeneration,
      currentCommitment: initial.currentCommitment,
      previousGeneration: initial.previousGeneration,
      previousExpiresAt: initial.previousExpiresAt,
      previousCommitment: initial.previousCommitment,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();
    persisted = await readPersistedImapRotationState(executor, true);
    if (!persisted) throw new Error("IMAP alias rotation state could not be initialized");
  }

  const next = decideImapRotationState(persisted, rotationConfigState(config, now), now);
  if (!sameRotationState(persisted, next)) {
    await executor.update(imapRecipientRotationState).set({
      currentGeneration: next.currentGeneration,
      currentCommitment: next.currentCommitment,
      previousGeneration: next.previousGeneration,
      previousExpiresAt: next.previousExpiresAt,
      previousCommitment: next.previousCommitment,
      updatedAt: now,
    }).where(eq(imapRecipientRotationState.id, 1));
  }
  return next;
}

/** Reconciles current and at most one previous aliases from trusted application code. */
export async function reconcileImapRecipientAliases(config: ImapIngestionConfig, limit = 1_000, now = new Date()): Promise<void> {
  if (!config.enabled) return;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("IMAP alias reconciliation limit must be positive");
  const database = getDb();
  await database.transaction(async (transaction) => {
    await ensureImapRotationAuthority(transaction, config, now);
  });
  let lastUserId: string | undefined;
  while (true) {
    const candidates = await database.select({ id: users.id, disabledAt: users.disabledAt }).from(users)
      .where(lastUserId ? gt(users.id, lastUserId) : undefined).orderBy(asc(users.id)).limit(limit);
    if (candidates.length === 0) break;
    await database.transaction(async (transaction) => {
      const authority = await ensureImapRotationAuthority(transaction, config, now);
      const activePrevious = authority.previousGeneration && authority.previousExpiresAt && config.aliasPrevious?.generation === authority.previousGeneration
        ? { ...config.aliasPrevious, expiresAt: authority.previousExpiresAt }
        : undefined;
      for (const candidate of candidates) {
        if (candidate.disabledAt) {
          await transaction.update(imapRecipientAliases).set({ status: "legacy_inactive", activeUntil: now, updatedAt: now })
            .where(and(eq(imapRecipientAliases.userId, candidate.id), eq(imapRecipientAliases.status, "active")));
          continue;
        }

        const currentDigest = digestImapRecipientAlias(deriveImapRecipientAlias(candidate.id, config.recipientDomain, config.aliasCurrent));
        await transaction.insert(imapRecipientAliases).values({
          userId: candidate.id,
          generation: config.aliasCurrent.generation,
          aliasSha256: currentDigest,
          status: "active",
          activeUntil: null,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: [imapRecipientAliases.userId, imapRecipientAliases.generation],
          set: { aliasSha256: currentDigest, status: "active", activeUntil: null, updatedAt: now },
        });

        if (activePrevious) {
          const previousDigest = digestImapRecipientAlias(deriveImapRecipientAlias(candidate.id, config.recipientDomain, activePrevious));
          await transaction.insert(imapRecipientAliases).values({
            userId: candidate.id,
            generation: activePrevious.generation,
            aliasSha256: previousDigest,
            status: "active",
            activeUntil: activePrevious.expiresAt,
            updatedAt: now,
          }).onConflictDoUpdate({
            target: [imapRecipientAliases.userId, imapRecipientAliases.generation],
            set: { aliasSha256: previousDigest, status: "active", activeUntil: activePrevious.expiresAt, updatedAt: now },
          });
        }

        const retainedGenerations = [authority.currentGeneration, ...(activePrevious ? [activePrevious.generation] : [])];
        await transaction.update(imapRecipientAliases).set({ status: "legacy_inactive", activeUntil: now, updatedAt: now })
          .where(and(
            eq(imapRecipientAliases.userId, candidate.id),
            eq(imapRecipientAliases.status, "active"),
            notInArray(imapRecipientAliases.generation, retainedGenerations),
          ));
      }
    });
    if (candidates.length < limit) break;
    lastUserId = candidates[candidates.length - 1].id;
  }
}

async function userForRecipientAlias(headers: Buffer | undefined, config: ImapIngestionConfig, now = new Date()): Promise<RecipientResolution> {
  const parsedHeader = parseTrustedRecipientHeader(headers, config.trustedRecipientHeader);
  const structuralFailure = trustedRecipientFailure(parsedHeader);
  if (structuralFailure || parsedHeader.kind !== "value") return { failureCode: structuralFailure ?? "recipient_missing" };
  const normalizedRecipient = normalizeImapRecipientAlias(parsedHeader.value, config.recipientDomain);
  if (!normalizedRecipient) {
    const domain = parsedHeader.value.slice(parsedHeader.value.lastIndexOf("@") + 1).toLowerCase();
    return { failureCode: domain && domain !== config.recipientDomain ? "recipient_wrong_domain" : "recipient_malformed" };
  }
  const aliasDigest = digestImapRecipientAlias(normalizedRecipient);
  const authority = await getDb().transaction(async (transaction) => ensureImapRotationAuthority(transaction, config, now));
  const activePrevious = authority.previousGeneration && authority.previousExpiresAt && config.aliasPrevious?.generation === authority.previousGeneration
    ? { ...config.aliasPrevious, expiresAt: authority.previousExpiresAt }
    : undefined;
  const generations = [authority.currentGeneration, ...(activePrevious ? [activePrevious.generation] : [])];
  const rows = await getDb().select({
    userId: imapRecipientAliases.userId,
    generation: imapRecipientAliases.generation,
    status: imapRecipientAliases.status,
    activeUntil: imapRecipientAliases.activeUntil,
    disabledAt: users.disabledAt,
  }).from(imapRecipientAliases).innerJoin(users, eq(users.id, imapRecipientAliases.userId)).where(and(
    eq(imapRecipientAliases.aliasSha256, aliasDigest),
    inArray(imapRecipientAliases.generation, generations),
  ));
  const disabled = rows.some((row) => row.disabledAt);
  const matches = rows.filter((row) => {
    if (row.disabledAt || row.status !== "active" || (row.activeUntil && row.activeUntil.getTime() <= now.getTime())) return false;
    const key = row.generation === authority.currentGeneration ? config.aliasCurrent : activePrevious;
    return Boolean(key && matchImapRecipientAliasGeneration(normalizedRecipient, row.userId, config.recipientDomain, key, now));
  });
  if (matches.length > 1) return { failureCode: "recipient_alias_ambiguous", digest: aliasDigest };
  if (matches.length === 1) return { userId: matches[0].userId, generation: matches[0].generation, digest: aliasDigest };
  if (disabled) return { failureCode: "recipient_disabled", digest: aliasDigest };
  if (activePrevious && rows.some((row) => row.generation === activePrevious.generation && row.activeUntil && row.activeUntil.getTime() <= now.getTime())) {
    return { failureCode: "recipient_alias_expired", digest: aliasDigest };
  }
  return { failureCode: "recipient_unverified", digest: aliasDigest };
}

type ImapReceiptValues = {
  mailbox: string;
  mailboxUidValidity: string;
  mailboxUid: number;
  contentSha256: string;
  recipientAliasSha256: string;
  recipientAliasGeneration: number | null;
  userId: string | null;
  householdId: string | null;
  expiresAt: Date;
  status: "processing" | "pending_review" | "failed" | "quarantined";
  failureCode: string | null;
  receiptStatus: "processing" | "cancelled";
  receivedAt: Date;
};

async function recordImapReceipt(config: ImapIngestionConfig, values: ImapReceiptValues) {
  return getDb().transaction(async (transaction) => {
    await ensureImapRotationAuthority(transaction, config, new Date());
    const inserted = await transaction.insert(imapIngestionMessages).values(values).onConflictDoNothing().returning({ id: imapIngestionMessages.id, userId: imapIngestionMessages.userId, status: imapIngestionMessages.status });
    if (inserted.length) return inserted;
    return transaction.select({ id: imapIngestionMessages.id, userId: imapIngestionMessages.userId, status: imapIngestionMessages.status })
      .from(imapIngestionMessages)
      .where(and(
        eq(imapIngestionMessages.mailbox, values.mailbox),
        eq(imapIngestionMessages.mailboxUidValidity, values.mailboxUidValidity),
        eq(imapIngestionMessages.mailboxUid, values.mailboxUid),
      )).limit(1);
  });
}

function safeAttachmentFailure(error: unknown): string {
  const code = error instanceof Error ? error.message : "attachment_processing_failed";
  return new Set([
    "attachment_count_exceeded", "attachment_total_too_large", "document_too_large",
    "mime_part_count_exceeded", "mime_nesting_too_deep", "mime_structure_invalid",
    "mime_type_mismatch", "document_type_unsupported", "malware_detected", "scanner_disabled",
    "scanner_unavailable", "message_too_large", "attachment_download_failed",
    "staging_lease_lost", "staging_purge_failed",
  ]).has(code) ? code : "attachment_processing_failed";
}

async function boundedDownloadedContent(content: unknown, maximumBytes: number): Promise<Buffer> {
  if (Buffer.isBuffer(content)) {
    if (content.length > maximumBytes) { content.fill(0); throw new Error("attachment_total_too_large"); }
    const copy = Buffer.from(content);
    content.fill(0);
    return copy;
  }
  if (content instanceof Uint8Array) {
    if (content.length > maximumBytes) { content.fill(0); throw new Error("attachment_total_too_large"); }
    const copy = Buffer.from(content);
    content.fill(0);
    return copy;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const append = (value: unknown) => {
    const chunk = Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : undefined;
    if (!chunk) throw new Error("attachment_download_failed");
    total += chunk.length;
    if (total > maximumBytes) throw new Error("attachment_total_too_large");
    chunks.push(chunk);
  };
  const finish = () => {
    const result = Buffer.concat(chunks);
    for (const chunk of chunks) chunk.fill(0);
    return result;
  };
  try {
    if (content && typeof (content as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
      for await (const chunk of content as AsyncIterable<unknown>) append(chunk);
      return finish();
    }
    if (content && typeof (content as ReadableStream<Uint8Array>).getReader === "function") {
      const reader = (content as ReadableStream<Uint8Array>).getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          append(next.value);
        }
        return finish();
      } finally {
        reader.releaseLock();
      }
    }
    throw new Error("attachment_download_failed");
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    throw error;
  }
}

async function downloadImapPart(client: ImapFlow, uid: number, part: string, maximumBytes: number): Promise<Buffer> {
  const downloader = (client as unknown as { download?: (uid: number, part: string, options: { uid: boolean }) => Promise<{ content: unknown }> }).download;
  if (typeof downloader !== "function") throw new Error("attachment_download_failed");
  const result = await downloader.call(client, uid, part, { uid: true });
  return boundedDownloadedContent(result?.content, maximumBytes);
}

type StagedObject = { id: string; storageKey: string };

function heldStorage() {
  const config = getDocumentConfig();
  return new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
}

/** Re-establishes durable ownership for a ciphertext written after its worker
 * ledger was reconciled, then purges only that uncommitted attempt object. */
async function recoverUncommittedStagingObject(messageId: string, leaseToken: string, object: StagedObject): Promise<boolean> {
  const [ledger] = await getDb().transaction(async (transaction) => {
    const [inserted] = await transaction.insert(imapIngestionStagingObjects).values({
      messageId, leaseToken, storageKey: object.storageKey, status: "purge_pending",
    }).onConflictDoNothing().returning({ id: imapIngestionStagingObjects.id });
    if (inserted) return [inserted] as const;
    const [existing] = await transaction.select({ id: imapIngestionStagingObjects.id }).from(imapIngestionStagingObjects)
      .where(and(
        eq(imapIngestionStagingObjects.messageId, messageId),
        eq(imapIngestionStagingObjects.leaseToken, leaseToken),
        eq(imapIngestionStagingObjects.storageKey, object.storageKey),
        inArray(imapIngestionStagingObjects.status, ["pending", "purge_pending"]),
      )).for("update").limit(1);
    if (!existing) return [] as const;
    const [marked] = await transaction.update(imapIngestionStagingObjects).set({ status: "purge_pending", purgeFailureCode: null, updatedAt: new Date() })
      .where(and(eq(imapIngestionStagingObjects.id, existing.id), eq(imapIngestionStagingObjects.messageId, messageId), eq(imapIngestionStagingObjects.leaseToken, leaseToken), eq(imapIngestionStagingObjects.storageKey, object.storageKey), inArray(imapIngestionStagingObjects.status, ["pending", "purge_pending"])))
      .returning({ id: imapIngestionStagingObjects.id });
    return marked ? [marked] as const : [] as const;
  });
  if (!ledger) return false;
  try {
    await purgeHeldImapAttachment(object.storageKey);
  } catch {
    await getDb().update(imapIngestionStagingObjects).set({ purgeAttempts: sql`${imapIngestionStagingObjects.purgeAttempts} + 1`, purgeFailureCode: "staging_purge_failed", updatedAt: new Date() })
      .where(and(eq(imapIngestionStagingObjects.id, ledger.id), eq(imapIngestionStagingObjects.messageId, messageId), eq(imapIngestionStagingObjects.leaseToken, leaseToken), eq(imapIngestionStagingObjects.storageKey, object.storageKey), eq(imapIngestionStagingObjects.status, "purge_pending"))).catch(() => undefined);
    return false;
  }
  try {
    await getDb().delete(imapIngestionStagingObjects).where(and(eq(imapIngestionStagingObjects.id, ledger.id), eq(imapIngestionStagingObjects.messageId, messageId), eq(imapIngestionStagingObjects.leaseToken, leaseToken), eq(imapIngestionStagingObjects.storageKey, object.storageKey), eq(imapIngestionStagingObjects.status, "purge_pending")));
  } catch {
    return false;
  }
  return true;
}

/** Registers the allocated storage key before writing ciphertext. A pending
 * row is safe if the subsequent write fails or the worker crashes. */
async function registerStagingObject(messageId: string, leaseToken: string, object: StagedObject): Promise<void> {
  const inserted = await getDb().transaction(async (transaction) => {
    const [active] = await transaction.select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
      .where(and(eq(imapIngestionMessages.id, messageId), eq(imapIngestionMessages.status, "processing"), eq(imapIngestionMessages.attachmentProcessingLeaseToken, leaseToken)))
      .for("update").limit(1);
    if (!active) return false;
    await transaction.insert(imapIngestionStagingObjects).values({ messageId, leaseToken, storageKey: object.storageKey, status: "pending" });
    return true;
  });
  if (!inserted) throw new Error("staging_lease_lost");
}

/** Commits the ledger and metadata together while holding the current lease row lock. */
export async function commitStagedAttachment(
  messageId: string,
  leaseToken: string,
  staged: Awaited<ReturnType<typeof scanAndHoldImapAttachment>>,
): Promise<"inserted" | "duplicate"> {
  try {
    return await getDb().transaction(async (transaction) => {
      const [active] = await transaction.select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
        .where(and(eq(imapIngestionMessages.id, messageId), eq(imapIngestionMessages.status, "processing"), eq(imapIngestionMessages.attachmentProcessingLeaseToken, leaseToken), gt(imapIngestionMessages.attachmentProcessingLockedAt, new Date(Date.now() - 10 * 60_000))))
        .for("update").limit(1);
      if (!active) throw new Error("staging_lease_lost");
      const [inserted] = await transaction.insert(imapIngestionAttachments).values({
        id: staged.id, messageId, displayName: staged.displayName, mediaType: staged.mediaType,
        sizeBytes: staged.sizeBytes, contentSha256: staged.contentSha256, storageKey: staged.storageKey,
        ciphertextSize: staged.ciphertextSize, ...staged.envelope,
      }).onConflictDoNothing().returning({ id: imapIngestionAttachments.id });
      if (!inserted) {
        const [purgePending] = await transaction.update(imapIngestionStagingObjects).set({ status: "purge_pending", purgeFailureCode: null, updatedAt: new Date() })
          .where(and(eq(imapIngestionStagingObjects.messageId, messageId), eq(imapIngestionStagingObjects.leaseToken, leaseToken), eq(imapIngestionStagingObjects.storageKey, staged.storageKey), eq(imapIngestionStagingObjects.status, "pending")))
          .returning({ id: imapIngestionStagingObjects.id });
        if (!purgePending) throw new Error("staging_lease_lost");
        return "duplicate";
      }
      const [committed] = await transaction.update(imapIngestionStagingObjects).set({ status: "committed", updatedAt: new Date() })
        .where(and(eq(imapIngestionStagingObjects.messageId, messageId), eq(imapIngestionStagingObjects.leaseToken, leaseToken), eq(imapIngestionStagingObjects.storageKey, staged.storageKey), eq(imapIngestionStagingObjects.status, "pending")))
        .returning({ id: imapIngestionStagingObjects.id });
      if (!committed) throw new Error("staging_lease_lost");
      return "inserted";
    });
  } catch (error) {
    await recoverUncommittedStagingObject(messageId, leaseToken, { id: staged.id, storageKey: staged.storageKey }).catch(() => undefined);
    throw error;
  }
}

async function markStagingPurgeIntent(messageId: string, leaseToken: string, objects: StagedObject[]): Promise<boolean> {
  if (!objects.length) return true;
  return getDb().transaction(async (transaction) => {
    const [active] = await transaction.select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
      .where(and(eq(imapIngestionMessages.id, messageId), eq(imapIngestionMessages.status, "processing"), eq(imapIngestionMessages.attachmentProcessingLeaseToken, leaseToken)))
      .for("update").limit(1);
    if (!active) return false;
    const ledgers = await Promise.all(objects.map((object) => transaction.select({ id: imapIngestionStagingObjects.id }).from(imapIngestionStagingObjects)
      .where(and(eq(imapIngestionStagingObjects.messageId, messageId), eq(imapIngestionStagingObjects.leaseToken, leaseToken), eq(imapIngestionStagingObjects.storageKey, object.storageKey)))
      .for("update").limit(1)));
    if (ledgers.some(([ledger]) => !ledger)) return false;
    for (const object of objects) {
      await transaction.update(imapIngestionStagingObjects).set({ status: "purge_pending", purgeFailureCode: null, updatedAt: new Date() })
        .where(and(eq(imapIngestionStagingObjects.messageId, messageId), eq(imapIngestionStagingObjects.leaseToken, leaseToken), eq(imapIngestionStagingObjects.storageKey, object.storageKey)));
      await transaction.update(imapIngestionAttachments).set({ purgePending: true, purgeFailureCode: null, updatedAt: new Date() })
        .where(and(eq(imapIngestionAttachments.messageId, messageId), eq(imapIngestionAttachments.id, object.id), eq(imapIngestionAttachments.storageKey, object.storageKey), eq(imapIngestionAttachments.status, "stored")));
    }
    return true;
  });
}

async function finalizeStagingPurge(messageId: string, leaseToken: string, object: StagedObject): Promise<boolean> {
  return getDb().transaction(async (transaction) => {
    const [active] = await transaction.select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
      .where(and(eq(imapIngestionMessages.id, messageId), eq(imapIngestionMessages.status, "processing"), eq(imapIngestionMessages.attachmentProcessingLeaseToken, leaseToken)))
      .for("update").limit(1);
    if (!active) return false;
    const [ledger] = await transaction.select({ id: imapIngestionStagingObjects.id }).from(imapIngestionStagingObjects)
      .where(and(eq(imapIngestionStagingObjects.messageId, messageId), eq(imapIngestionStagingObjects.leaseToken, leaseToken), eq(imapIngestionStagingObjects.storageKey, object.storageKey), eq(imapIngestionStagingObjects.status, "purge_pending")))
      .for("update").limit(1);
    if (!ledger) return false;
    await transaction.delete(imapIngestionAttachments).where(and(
      eq(imapIngestionAttachments.messageId, messageId),
      eq(imapIngestionAttachments.id, object.id),
      eq(imapIngestionAttachments.storageKey, object.storageKey),
      eq(imapIngestionAttachments.status, "stored"),
      eq(imapIngestionAttachments.purgePending, true),
    ));
    await transaction.delete(imapIngestionStagingObjects).where(eq(imapIngestionStagingObjects.id, ledger.id));
    return true;
  });
}

async function recordStagingPurgeFailure(messageId: string, leaseToken: string, object: StagedObject): Promise<void> {
  await getDb().transaction(async (transaction) => {
    const [active] = await transaction.select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
      .where(and(eq(imapIngestionMessages.id, messageId), eq(imapIngestionMessages.status, "processing"), eq(imapIngestionMessages.attachmentProcessingLeaseToken, leaseToken)))
      .for("update").limit(1);
    if (!active) return;
    await transaction.update(imapIngestionStagingObjects).set({ status: "purge_pending", purgeAttempts: sql`${imapIngestionStagingObjects.purgeAttempts} + 1`, purgeFailureCode: "staging_purge_failed", updatedAt: new Date() })
      .where(and(eq(imapIngestionStagingObjects.messageId, messageId), eq(imapIngestionStagingObjects.leaseToken, leaseToken), eq(imapIngestionStagingObjects.storageKey, object.storageKey)));
    await transaction.update(imapIngestionAttachments).set({ purgePending: true, purgeAttempts: sql`${imapIngestionAttachments.purgeAttempts} + 1`, purgeFailureCode: "staging_purge_failed", updatedAt: new Date() })
      .where(and(eq(imapIngestionAttachments.messageId, messageId), eq(imapIngestionAttachments.id, object.id), eq(imapIngestionAttachments.storageKey, object.storageKey), eq(imapIngestionAttachments.status, "stored")));
  });
}

async function purgeStagingObjectAfterIntent(messageId: string, leaseToken: string, object: StagedObject): Promise<boolean> {
  if (!await markStagingPurgeIntent(messageId, leaseToken, [object])) return false;
  try {
    await purgeHeldImapAttachment(object.storageKey);
  } catch {
    await recordStagingPurgeFailure(messageId, leaseToken, object);
    return false;
  }
  return finalizeStagingPurge(messageId, leaseToken, object);
}

export async function cleanupImapStagingAttempt(messageId: string, leaseToken: string, objects: StagedObject[]): Promise<boolean> {
  if (!await markStagingPurgeIntent(messageId, leaseToken, objects)) return false;
  let complete = true;
  for (const object of objects) {
    try {
      await purgeHeldImapAttachment(object.storageKey);
      if (!await finalizeStagingPurge(messageId, leaseToken, object)) complete = false;
    } catch {
      complete = false;
      await recordStagingPurgeFailure(messageId, leaseToken, object);
    }
  }
  return complete;
}

/** Reconciles pending/committed staging ledgers after crashes and stale leases. */
export async function reconcileImapStagingObjects(limit = 100): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("IMAP staging reconciliation limit is invalid");
  const rows = await getDb().select({
    id: imapIngestionStagingObjects.id,
    messageId: imapIngestionStagingObjects.messageId,
    leaseToken: imapIngestionStagingObjects.leaseToken,
    storageKey: imapIngestionStagingObjects.storageKey,
    status: imapIngestionStagingObjects.status,
    parentStatus: imapIngestionMessages.status,
    parentLeaseToken: imapIngestionMessages.attachmentProcessingLeaseToken,
    parentLockedAt: imapIngestionMessages.attachmentProcessingLockedAt,
  }).from(imapIngestionStagingObjects).innerJoin(imapIngestionMessages, eq(imapIngestionMessages.id, imapIngestionStagingObjects.messageId)).orderBy(asc(imapIngestionStagingObjects.createdAt)).limit(limit);
  const liveCutoff = Date.now() - 10 * 60_000;
  for (const row of rows) {
    if (row.parentStatus === "processing" && row.parentLeaseToken === row.leaseToken && row.parentLockedAt && row.parentLockedAt.getTime() > liveCutoff) continue;
    const [attachment] = await getDb().select({ id: imapIngestionAttachments.id, status: imapIngestionAttachments.status, purgePending: imapIngestionAttachments.purgePending })
      .from(imapIngestionAttachments).where(eq(imapIngestionAttachments.storageKey, row.storageKey)).limit(1);
    if (row.status === "committed" && attachment?.status === "assigned" && !attachment.purgePending) {
      await getDb().transaction(async (transaction) => {
        const [parent] = await transaction.select({ status: imapIngestionMessages.status, leaseToken: imapIngestionMessages.attachmentProcessingLeaseToken, lockedAt: imapIngestionMessages.attachmentProcessingLockedAt }).from(imapIngestionMessages)
          .where(eq(imapIngestionMessages.id, row.messageId)).for("update").limit(1);
        if (parent?.status === "processing" && parent.leaseToken === row.leaseToken && parent.lockedAt && parent.lockedAt.getTime() > Date.now() - 10 * 60_000) return;
        await transaction.delete(imapIngestionStagingObjects).where(and(eq(imapIngestionStagingObjects.id, row.id), eq(imapIngestionStagingObjects.leaseToken, row.leaseToken)));
      });
      continue;
    }
    if (row.status === "committed" && attachment?.status === "stored" && !attachment.purgePending && await heldStorage().ciphertextExists(row.storageKey)) {
      await getDb().transaction(async (transaction) => {
        const [parent] = await transaction.select({ status: imapIngestionMessages.status, leaseToken: imapIngestionMessages.attachmentProcessingLeaseToken, lockedAt: imapIngestionMessages.attachmentProcessingLockedAt }).from(imapIngestionMessages)
          .where(eq(imapIngestionMessages.id, row.messageId)).for("update").limit(1);
        if (parent?.status === "processing" && parent.leaseToken === row.leaseToken && parent.lockedAt && parent.lockedAt.getTime() > Date.now() - 10 * 60_000) return;
        await transaction.delete(imapIngestionStagingObjects).where(and(eq(imapIngestionStagingObjects.id, row.id), eq(imapIngestionStagingObjects.leaseToken, row.leaseToken)));
      });
      continue;
    }
    const marked = await getDb().transaction(async (transaction) => {
      const [parent] = await transaction.select({ status: imapIngestionMessages.status, leaseToken: imapIngestionMessages.attachmentProcessingLeaseToken, lockedAt: imapIngestionMessages.attachmentProcessingLockedAt }).from(imapIngestionMessages)
        .where(eq(imapIngestionMessages.id, row.messageId)).for("update").limit(1);
      if (!parent || (parent.status === "processing" && parent.leaseToken === row.leaseToken && parent.lockedAt && parent.lockedAt.getTime() > Date.now() - 10 * 60_000)) return false;
      await transaction.update(imapIngestionStagingObjects).set({ status: "purge_pending", updatedAt: new Date() })
        .where(eq(imapIngestionStagingObjects.id, row.id));
      if (attachment?.status === "stored") {
        await transaction.update(imapIngestionAttachments).set({ purgePending: true, purgeFailureCode: null, updatedAt: new Date() })
          .where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.purgePending, false)));
      }
      return true;
    });
    if (!marked) continue;
    try {
      await purgeHeldImapAttachment(row.storageKey);
      await getDb().transaction(async (transaction) => {
        const [parent] = await transaction.select({ status: imapIngestionMessages.status, leaseToken: imapIngestionMessages.attachmentProcessingLeaseToken, lockedAt: imapIngestionMessages.attachmentProcessingLockedAt }).from(imapIngestionMessages)
          .where(eq(imapIngestionMessages.id, row.messageId)).for("update").limit(1);
        if (!parent || (parent.status === "processing" && parent.leaseToken === row.leaseToken && parent.lockedAt && parent.lockedAt.getTime() > Date.now() - 10 * 60_000)) return;
        if (attachment?.status === "stored") {
          await transaction.delete(imapIngestionAttachments).where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.status, "stored"), eq(imapIngestionAttachments.purgePending, true)));
        } else if (attachment?.status === "assigned" && attachment.purgePending) {
          await transaction.update(imapIngestionAttachments).set({ purgePending: false, purgeFailureCode: null, updatedAt: new Date() })
            .where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.status, "assigned"), eq(imapIngestionAttachments.purgePending, true)));
        }
        await transaction.delete(imapIngestionStagingObjects).where(eq(imapIngestionStagingObjects.id, row.id));
      });
    } catch {
      await getDb().transaction(async (transaction) => {
        const [parent] = await transaction.select({ status: imapIngestionMessages.status, leaseToken: imapIngestionMessages.attachmentProcessingLeaseToken, lockedAt: imapIngestionMessages.attachmentProcessingLockedAt }).from(imapIngestionMessages)
          .where(eq(imapIngestionMessages.id, row.messageId)).for("update").limit(1);
        if (!parent || (parent.status === "processing" && parent.leaseToken === row.leaseToken && parent.lockedAt && parent.lockedAt.getTime() > Date.now() - 10 * 60_000)) return;
        await transaction.update(imapIngestionStagingObjects).set({ status: "purge_pending", purgeAttempts: sql`${imapIngestionStagingObjects.purgeAttempts} + 1`, purgeFailureCode: "staging_purge_failed", updatedAt: new Date() })
          .where(and(eq(imapIngestionStagingObjects.id, row.id), eq(imapIngestionStagingObjects.leaseToken, row.leaseToken)));
        if (attachment?.status === "stored") {
          await transaction.update(imapIngestionAttachments).set({ purgePending: true, purgeAttempts: sql`${imapIngestionAttachments.purgeAttempts} + 1`, purgeFailureCode: "staging_purge_failed", updatedAt: new Date() })
            .where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.storageKey, row.storageKey), eq(imapIngestionAttachments.status, "stored")));
        }
      });
    }
  }
}

type ImapAttachmentClaim = { id: string; leaseToken: string; attempts: number };

/** Bounded retry schedule shared by claim tests and the attachment worker. */
export function imapAttachmentRetryDelayMs(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("IMAP attachment attempt is invalid");
  return Math.min(15 * 60_000, 1_000 * 2 ** Math.min(attempts - 1, 10));
}

async function claimImapAttachmentProcessing(receiptId: string): Promise<ImapAttachmentClaim | undefined> {
  const now = new Date();
  await getDb().update(imapIngestionMessages).set({
    status: "recoverable", failureCode: "attachment_processing_exhausted", receiptStatus: "pending",
    attachmentProcessingLockedAt: null, attachmentProcessingLeaseToken: null, attachmentProcessingNextAttemptAt: null, updatedAt: now,
  }).where(and(
    eq(imapIngestionMessages.id, receiptId),
    eq(imapIngestionMessages.status, "processing"),
    sql`${imapIngestionMessages.attachmentProcessingAttempts} >= 5`,
    or(isNull(imapIngestionMessages.attachmentProcessingLockedAt), lt(imapIngestionMessages.attachmentProcessingLockedAt, new Date(now.getTime() - 10 * 60_000))),
  ));
  const token = randomUUID();
  const [claimed] = await getDb().update(imapIngestionMessages).set({
    attachmentProcessingAttempts: sql`${imapIngestionMessages.attachmentProcessingAttempts} + 1`,
    attachmentProcessingLockedAt: now,
    attachmentProcessingLeaseToken: token,
    updatedAt: now,
  }).where(and(
    eq(imapIngestionMessages.id, receiptId),
    eq(imapIngestionMessages.status, "processing"),
    lt(imapIngestionMessages.attachmentProcessingAttempts, 5),
    or(isNull(imapIngestionMessages.attachmentProcessingLockedAt), lt(imapIngestionMessages.attachmentProcessingLockedAt, new Date(now.getTime() - 10 * 60_000))),
    or(isNull(imapIngestionMessages.attachmentProcessingNextAttemptAt), lte(imapIngestionMessages.attachmentProcessingNextAttemptAt, now)),
  )).returning({ id: imapIngestionMessages.id, leaseToken: imapIngestionMessages.attachmentProcessingLeaseToken, attempts: imapIngestionMessages.attachmentProcessingAttempts });
  return claimed?.leaseToken ? { id: claimed.id, leaseToken: claimed.leaseToken, attempts: claimed.attempts } : undefined;
}

const permanentAttachmentFailures = new Set([
  "attachment_count_exceeded", "attachment_total_too_large", "document_too_large",
  "mime_part_count_exceeded", "mime_nesting_too_deep", "mime_structure_invalid",
  "mime_type_mismatch", "document_type_unsupported", "malware_detected", "scanner_disabled",
  "message_too_large",
]);

async function processImapAttachments(
  client: ImapFlow,
  message: { uid: number; bodyStructure?: MessageStructureObject },
  receipt: { id: string; leaseToken: string; attempts: number },
  userId: string,
): Promise<void> {
  const held: Array<{ storageKey: string; id: string }> = [];
  try {
    const classification = classifyImapBodyStructure(message.bodyStructure, { maxDocumentBytes: getDocumentConfig().maxBytes, mailboxPdfOnly: true });
    if (!classification.ok) throw new Error(classification.code ?? "mime_structure_invalid");
    if (classification.candidates.length === 0) {
      const [finished] = await getDb().update(imapIngestionMessages).set({ status: "failed", receiptStatus: "cancelled", failureCode: "no_supported_pdf", attachmentProcessingLockedAt: null, attachmentProcessingLeaseToken: null, attachmentProcessingNextAttemptAt: null, updatedAt: new Date() }).where(and(eq(imapIngestionMessages.id, receipt.id), eq(imapIngestionMessages.attachmentProcessingLeaseToken, receipt.leaseToken))).returning({ id: imapIngestionMessages.id });
      if (!finished) throw new Error("staging_lease_lost");
      return;
    }
    let aggregateBytes = 0;
    for (const candidate of classification.candidates as ImapAttachmentCandidate[]) {
      const content = await downloadImapPart(client, message.uid, candidate.part, IMAP_ATTACHMENT_LIMITS.aggregateAttachmentBytes - aggregateBytes);
      aggregateBytes += content.length;
      if (aggregateBytes > IMAP_ATTACHMENT_LIMITS.aggregateAttachmentBytes) throw new Error("attachment_total_too_large");
      let staged: Awaited<ReturnType<typeof scanAndHoldImapAttachment>>;
      try {
        staged = await scanAndHoldImapAttachment({
          bytes: content,
          filename: candidate.filename,
          declaredMediaType: candidate.declaredMediaType,
          recipientUserId: userId,
          receiptId: receipt.id,
          mailboxIngestion: true,
          onCiphertextAllocated: (object) => registerStagingObject(receipt.id, receipt.leaseToken, object),
        });
      } finally { content.fill(0); }
      const attemptObject = { storageKey: staged.storageKey, id: staged.id };
      held.push(attemptObject);
      let commit: "inserted" | "duplicate";
      try {
        commit = await commitStagedAttachment(receipt.id, receipt.leaseToken, staged);
      } catch (error) {
        // The commit helper handles this exact newly written key; keep it out
        // of broader attempt cleanup so no successor-owned key is touched.
        held.pop();
        throw error;
      }
      if (commit === "duplicate") {
        if (!await purgeStagingObjectAfterIntent(receipt.id, receipt.leaseToken, attemptObject)) throw new Error("staging_purge_failed");
        held.pop();
      }
    }
    const [finished] = await getDb().update(imapIngestionMessages).set({ status: "pending_review", receiptStatus: "pending", failureCode: null, attachmentProcessingLockedAt: null, attachmentProcessingLeaseToken: null, attachmentProcessingNextAttemptAt: null, updatedAt: new Date() }).where(and(eq(imapIngestionMessages.id, receipt.id), eq(imapIngestionMessages.attachmentProcessingLeaseToken, receipt.leaseToken))).returning({ id: imapIngestionMessages.id });
    if (!finished) {
      await cleanupImapStagingAttempt(receipt.id, receipt.leaseToken, held);
      return;
    }
  } catch (error) {
    const cleanupComplete = await cleanupImapStagingAttempt(receipt.id, receipt.leaseToken, held);
    const code = safeAttachmentFailure(error);
    const terminal = permanentAttachmentFailures.has(code) || receipt.attempts >= 5;
    const [remainingAttachment] = await getDb().select({ id: imapIngestionAttachments.id }).from(imapIngestionAttachments).where(and(
      eq(imapIngestionAttachments.messageId, receipt.id),
      inArray(imapIngestionAttachments.status, ["stored", "assigned"]),
    )).limit(1);
    const [remainingLedger] = await getDb().select({ id: imapIngestionStagingObjects.id }).from(imapIngestionStagingObjects).where(eq(imapIngestionStagingObjects.messageId, receipt.id)).limit(1);
    const terminalReady = terminal && cleanupComplete && !remainingAttachment && !remainingLedger;
    const cleanupToken = terminalReady || cleanupComplete ? null : randomUUID();
    await getDb().update(imapIngestionMessages).set({
      status: terminalReady ? "failed" : terminal ? "recoverable" : cleanupComplete ? "processing" : "recoverable",
      failureCode: terminalReady ? code : terminal ? "attachment_processing_exhausted" : code,
      receiptStatus: terminalReady ? "cancelled" : "processing",
      attachmentProcessingLockedAt: cleanupComplete ? null : new Date(),
      attachmentProcessingLeaseToken: cleanupToken,
      attachmentProcessingNextAttemptAt: terminal ? null : new Date(Date.now() + imapAttachmentRetryDelayMs(receipt.attempts)),
      attachmentProcessingFailureCode: code,
      updatedAt: new Date(),
    }).where(and(eq(imapIngestionMessages.id, receipt.id), eq(imapIngestionMessages.attachmentProcessingLeaseToken, receipt.leaseToken)));
  }
}

/**
 * Polls the dedicated mailbox and records only an idempotent receipt. It does
 * not parse, retain, attach, create, or merge household data; later review
 * work must explicitly choose a household and approve a document draft.
 */
export async function runImapIngestionCycle(config = getImapIngestionConfig()): Promise<void> {
  if (!config.enabled) return;
  await reconcileImapStagingObjects();
  await reconcileImapRecipientAliases(config);
  const client = createImapClient(config);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(config.mailbox, { readOnly: true });
    try {
      if (!client.mailbox) throw new Error("IMAP mailbox could not be opened");
      const uidValidity = client.mailbox.uidValidity.toString();
      const retryRows = await getDb().select({
        uid: imapIngestionMessages.mailboxUid,
      }).from(imapIngestionMessages).where(and(
        eq(imapIngestionMessages.mailbox, config.mailbox),
        eq(imapIngestionMessages.mailboxUidValidity, uidValidity),
        eq(imapIngestionMessages.status, "processing"),
        or(isNull(imapIngestionMessages.attachmentProcessingNextAttemptAt), lte(imapIngestionMessages.attachmentProcessingNextAttemptAt, new Date())),
        or(isNull(imapIngestionMessages.attachmentProcessingLockedAt), lt(imapIngestionMessages.attachmentProcessingLockedAt, new Date(Date.now() - 10 * 60_000))),
      )).orderBy(asc(imapIngestionMessages.mailboxUid)).limit(25);
      const [checkpoint] = await getDb().select({
        lastUid: sql<number | null>`max(${imapIngestionMessages.mailboxUid})`,
      }).from(imapIngestionMessages).where(and(
        eq(imapIngestionMessages.mailbox, config.mailbox),
        eq(imapIngestionMessages.mailboxUidValidity, uidValidity),
      ));
      const fetchOptions = { uid: true, headers: [config.trustedRecipientHeader], source: { maxLength: IMAP_ATTACHMENT_LIMITS.rawMessageBytes }, internalDate: true, size: true, bodyStructure: true };
      const processMessage = async (message: { uid: number; source?: Buffer; headers?: Buffer; size?: number; bodyStructure?: MessageStructureObject; internalDate?: Date | string }) => {
        try {
        const source = message.source;
        const oversized = !source || (message.size ?? 0) > IMAP_ATTACHMENT_LIMITS.rawMessageBytes || source.length > IMAP_ATTACHMENT_LIMITS.rawMessageBytes;
        const recipient = await userForRecipientAlias(message.headers, config);
        const userId = recipient.userId;
        const contentSha256 = oversized
          ? createHash("sha256").update(`oversized:${uidValidity}:${message.uid}`).digest("hex")
          : createHash("sha256").update(source!).digest("hex");
        const aliasSha256 = recipient.digest ?? createHash("sha256").update("").digest("hex");
        const [receipt] = await recordImapReceipt(config, {
          mailbox: config.mailbox, mailboxUidValidity: uidValidity, mailboxUid: message.uid,
          contentSha256, recipientAliasSha256: aliasSha256, recipientAliasGeneration: recipient.generation ?? null,
          userId: userId ?? null, householdId: null,
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
          status: oversized ? "failed" : userId ? "processing" : "quarantined",
          failureCode: oversized ? "message_too_large" : userId ? null : recipient.failureCode ?? "recipient_unverified",
          // A receipt is only meaningful once a verified recipient's attachments
          // have been held successfully. All other outcomes are terminal here.
          receiptStatus: userId && !oversized ? "processing" : "cancelled",
          receivedAt: message.internalDate instanceof Date ? message.internalDate : new Date(),
        });
        if (receipt && userId !== (receipt.userId ?? undefined) && receipt.status === "processing") {
          await getDb().update(imapIngestionMessages).set({ status: "quarantined", receiptStatus: "cancelled", failureCode: "recipient_mismatch", attachmentProcessingLockedAt: null, attachmentProcessingLeaseToken: null, attachmentProcessingNextAttemptAt: null, updatedAt: new Date() })
            .where(and(eq(imapIngestionMessages.id, receipt.id), eq(imapIngestionMessages.status, "processing")));
        }
        if (receipt && userId && receipt.userId === userId && !oversized) {
          const claim = await claimImapAttachmentProcessing(receipt.id);
          if (claim) await processImapAttachments(client, message, claim, receipt.userId);
        }
        } finally {
        message.source?.fill(0);
        if (Buffer.isBuffer(message.headers)) message.headers.fill(0);
        }
      };
      // Retries are fetched by exact UID in a bounded batch. A poison retry
      // therefore cannot force a mailbox-wide rescan or starve newer mail.
      for (const retry of retryRows) {
        for await (const message of client.fetch(`${retry.uid}:${retry.uid}`, fetchOptions, { uid: true })) await processMessage(message);
      }
      // New mail is a separate bounded pass from the highest durable UID.
      // Breaking the iterator bounds work even when the provider has a large
      // unseen tail; the next poll resumes at the next UID.
      const nextUid = (checkpoint?.lastUid ?? 0) + 1;
      let newMessages = 0;
      for await (const message of client.fetch(`${nextUid}:*`, fetchOptions, { uid: true })) {
        await processMessage(message);
        newMessages += 1;
        if (newMessages >= 25) break;
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
  __orbitImapWorkerLastErrorCode?: string;
};

export function getImapIngestionWorkerHealth() {
  return {
    started: workerState.__orbitImapWorkerStarted ?? false,
    running: workerState.__orbitImapWorkerRunning ?? false,
    lastSuccessAt: workerState.__orbitImapWorkerLastSuccessAt ?? null,
    lastErrorAt: workerState.__orbitImapWorkerLastErrorAt ?? null,
    lastErrorCode: workerState.__orbitImapWorkerLastErrorCode ?? null,
    preflightStatus: getImapProviderPreflightState().status,
  };
}

/** Starts one polling loop per process; provider preflight gates every poll. */
export function startImapIngestionWorker(config?: ImapIngestionConfig): void {
  if (workerState.__orbitImapWorkerStarted) return;
  workerState.__orbitImapWorkerStarted = true;
  const poll = async () => {
    workerState.__orbitImapWorkerRunning = true;
    try {
      let currentConfig = config;
      try {
        currentConfig ??= getImapIngestionConfig();
      } catch {
        workerState.__orbitImapWorkerLastErrorCode = "unsafe_input";
        return;
      }
      let smtp: NotificationWorkerConfig;
      try {
        smtp = getNotificationWorkerConfig();
      } catch {
        workerState.__orbitImapWorkerLastErrorCode = "unsafe_input";
        return;
      }
      const preflight = await verifyImapIngestionProviders(currentConfig, smtp);
      if (preflight.status === "available") {
        await runImapIngestionCycle(currentConfig);
        workerState.__orbitImapWorkerLastSuccessAt = new Date().toISOString();
        workerState.__orbitImapWorkerLastErrorCode = undefined;
      } else if (preflight.status !== "disabled" && preflight.status !== "not_configured") {
        workerState.__orbitImapWorkerLastErrorCode = preflight.status;
      }
    } catch {
      workerState.__orbitImapWorkerLastErrorAt = new Date().toISOString();
      workerState.__orbitImapWorkerLastErrorCode = "provider_unavailable";
      console.error("Orbit IMAP ingestion cycle failed");
    } finally {
      workerState.__orbitImapWorkerRunning = false;
      const pollMilliseconds = config?.pollMilliseconds ?? 60_000;
      setTimeout(poll, pollMilliseconds).unref();
    }
  };
  void poll();
}

/** Establishes a bounded TLS-only connection without listing or fetching mail. */
export async function verifyImapProvider(config = getImapIngestionConfig()): Promise<"ready" | "imap_unconfigured" | "imap_unavailable"> {
  if (!config.enabled) return "imap_unconfigured";
  const client = createImapClient(config, true);
  try {
    await client.connect();
    return "ready";
  } catch {
    return "imap_unavailable";
  } finally {
    try { await client.logout(); } catch { /* Connection may not have completed. */ }
  }
}
