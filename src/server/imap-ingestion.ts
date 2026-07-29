import { createHash } from "node:crypto";
import { ImapFlow, type MessageStructureObject } from "imapflow";
import { and, asc, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { imapIngestionAttachments, imapIngestionMessages, imapRecipientAliases, imapRecipientRotationState, users } from "@/db/schema";
import { readRuntimeSecret } from "@/lib/runtime-secret";
import { scanAndHoldImapAttachment } from "@/server/imap-attachment-holding";
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

export type ImapClientFactory = (config: ImapIngestionConfig) => ImapFlow;
let imapClientFactoryForTests: ImapClientFactory | undefined;

/** Injects a deterministic provider adapter for receipt/restart contract tests. */
export function setImapClientFactoryForTests(factory: ImapClientFactory | undefined): void {
  imapClientFactoryForTests = factory;
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
  if (configuredValues === 3 && !parsed.SMTP_URL && !parsed.SMTP_HOST) {
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
    enabled: configuredValues === 3,
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
  status: "pending_review" | "failed" | "quarantined";
  failureCode: string | null;
  receiptStatus: "processing" | "cancelled";
  receivedAt: Date;
};

async function recordImapReceipt(config: ImapIngestionConfig, values: ImapReceiptValues) {
  return getDb().transaction(async (transaction) => {
    await ensureImapRotationAuthority(transaction, config, new Date());
    return transaction.insert(imapIngestionMessages).values(values).onConflictDoNothing().returning({ id: imapIngestionMessages.id });
  });
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
  await reconcileImapRecipientAliases(config);
  const client = imapClientFactoryForTests?.(config) ?? new ImapFlow({
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
      const [checkpoint] = await getDb().select({ lastUid: sql<number | null>`max(${imapIngestionMessages.mailboxUid})` })
        .from(imapIngestionMessages)
        .where(and(
          eq(imapIngestionMessages.mailbox, config.mailbox),
          eq(imapIngestionMessages.mailboxUidValidity, uidValidity),
        ));
      // IMAP UIDs are monotonic within UIDVALIDITY. This keeps a dedicated
      // mailbox read-only while avoiding a full rescan of all unseen mail.
      const uidRange = `${(checkpoint?.lastUid ?? 0) + 1}:*`;
      for await (const message of client.fetch(uidRange, { uid: true, headers: [config.trustedRecipientHeader], source: { maxLength: 25 * 1024 * 1024 }, internalDate: true, size: true, bodyStructure: true }, { uid: true })) {
        const source = message.source;
        const oversized = !source || (message.size ?? 0) > 25 * 1024 * 1024 || source.length > 25 * 1024 * 1024;
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
          status: oversized ? "failed" : userId ? "pending_review" : "quarantined",
          failureCode: oversized ? "message_too_large" : userId ? null : recipient.failureCode ?? "recipient_unverified",
          // A receipt is only meaningful once a verified recipient's attachments
          // have been held successfully. All other outcomes are terminal here.
          receiptStatus: userId && !oversized ? "processing" : "cancelled",
          receivedAt: message.internalDate instanceof Date ? message.internalDate : new Date(),
        });
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
            await getDb().update(imapIngestionMessages).set({ receiptStatus: "pending", updatedAt: new Date() }).where(eq(imapIngestionMessages.id, receipt.id));
          } catch {
            await getDb().update(imapIngestionMessages).set({ status: "failed", failureCode: "attachment_processing_failed", receiptStatus: "cancelled", updatedAt: new Date() }).where(eq(imapIngestionMessages.id, receipt.id));
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
