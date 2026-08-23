import { bigint, boolean, check, date, foreignKey, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const membershipRole = pgEnum("membership_role", ["owner", "member"]);
export const itemStatus = pgEnum("item_status", ["active", "expired", "cancelled", "archived"]);
export const eventKind = pgEnum("event_kind", ["renewal", "service"]);
export const deliveryChannel = pgEnum("delivery_channel", ["email", "web_push"]);
export const deliveryStatus = pgEnum("delivery_status", ["pending", "processing", "sent", "retry", "failed", "cancelled"]);
export const themeMode = pgEnum("theme_mode", ["system", "light", "dark"]);
export const documentLifecycle = pgEnum("document_lifecycle", [
  "receiving",
  "validating",
  "quarantined",
  "scanning",
  "encrypting",
  "available",
  "pending_deletion",
  "deleted",
  "rejected",
]);
export const documentScanStatus = pgEnum("document_scan_status", ["pending", "clean", "infected", "error", "skipped"]);
export const documentJobKind = pgEnum("document_job_kind", ["scan", "encrypt", "purge", "reconcile", "rewrap"]);
export const documentJobStatus = pgEnum("document_job_status", [
  "pending",
  "processing",
  "retry",
  "completed",
  "failed",
  "cancelled",
]);
export const documentDraftStatus = pgEnum("document_draft_status", ["pending_review", "approved", "discarded"]);
export const imapIngestionStatus = pgEnum("imap_ingestion_status", [
  "processing",
  "pending_review",
  "approving",
  "recoverable",
  "completed",
  "discarded",
  "expired",
  "quarantined",
  "failed",
]);
export const imapAttachmentStatus = pgEnum("imap_attachment_status", ["stored", "rejected", "assigned"]);
export const imapRecipientAliasStatus = pgEnum("imap_recipient_alias_status", ["active", "legacy_inactive"]);
export const imapNotificationKind = pgEnum("imap_notification_kind", ["receipt", "review_ready"]);
export const reviewedIntakeOperationStatus = pgEnum("reviewed_intake_operation_status", ["processing", "pending_attachment", "completed", "recoverable", "failed"]);
export const reviewedIntakeOperationSource = pgEnum("reviewed_intake_operation_source", ["direct_upload", "mailbox_draft"]);
export const reviewedIntakeAttachmentState = pgEnum("reviewed_intake_attachment_state", ["not_requested", "pending", "attached"]);

const auditColumns = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  isInstanceAdmin: boolean("is_instance_admin").notNull().default(false),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  ...auditColumns,
}, (table) => [index("user_email_lookup_idx").on(table.email)]);

export const userPreferences = pgTable("user_preferences", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  themeMode: themeMode("theme_mode").notNull().default("system"),
  themeId: text("theme_id").notNull().default("after-dark"),
  textSize: text("text_size").notNull().default("comfortable"),
  urgencyPalette: text("urgency_palette").notNull().default("themed"),
  emailNotifications: boolean("email_notifications").notNull().default(true),
  pushNotifications: boolean("push_notifications").notNull().default(true),
  // The reader's own reminder timing (#468, settings §13): how far ahead the
  // first warning is raised, and how close in the final one lands. Stored per
  // user because the settings screen presents them as the reader's own
  // choice; per-item overrides remain in reminder_rules.
  firstWarningDays: integer("first_warning_days").notNull().default(14),
  finalWarningDays: integer("final_warning_days").notNull().default(3),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("user_preference_warning_days_bounded", sql`${table.firstWarningDays} BETWEEN 1 AND 365 AND ${table.finalWarningDays} BETWEEN 0 AND 365`),
  // The final warning is the closer one, so it is always the smaller offset.
  check("user_preference_final_warning_last", sql`${table.finalWarningDays} < ${table.firstWarningDays}`),
]);

/**
 * The instance's one primary administrator (#263): a single-row table whose
 * check constraint forbids a second row and whose ON DELETE RESTRICT foreign
 * key makes the database itself refuse to delete the current primary user —
 * a missed application check cannot orphan the instance. Empty only before
 * the first administrator exists; the #259 bootstrap and the 0027 migration
 * both seed it.
 */
export const instanceAuthority = pgTable("instance_authority", {
  singleton: boolean("singleton").primaryKey().default(true),
  primaryUserId: uuid("primary_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("instance_authority_singleton", sql`${table.singleton}`),
]);

/**
 * The instance's one maintenance configuration (#235, ADR-0013 decision 1):
 * the `instance_authority` singleton shape, but with no foreign key, so
 * unlike that table the 0028 migration seeds the inactive row
 * unconditionally and the guard read is always a plain primary-key lookup.
 * `id` exists solely to give `audit_log.entity_id` something stable to
 * point at. `version` versions the whole maintenance configuration —
 * this row and `maintenanceNotices` together — and every administrator
 * mutation is a single transaction gated on it (src/server/maintenance.ts).
 */
export const instanceMaintenance = pgTable("instance_maintenance", {
  singleton: boolean("singleton").primaryKey().default(true),
  id: uuid("id").notNull().defaultRandom(),
  active: boolean("active").notNull().default(false),
  message: text("message"),
  messagePublishedAt: timestamp("message_published_at", { withTimezone: true }),
  expectedEndAt: timestamp("expected_end_at", { withTimezone: true }),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  version: bigint("version", { mode: "number" }).notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("instance_maintenance_singleton", sql`${table.singleton}`),
  check("instance_maintenance_message_length", sql`${table.message} IS NULL OR char_length(${table.message}) <= 500`),
]);

/**
 * Scheduled future maintenance notices (#235, ADR-0013 decision 1). Rows are
 * retained, never deleted: cancellation sets `cancelledAt`. The partial index
 * matches the "due, unclaimed, uncancelled" predicate the effective-state
 * read and the future scheduled-activation worker (#525) both use.
 */
export const maintenanceNotices = pgTable("maintenance_notices", {
  id: uuid("id").primaryKey().defaultRandom(),
  message: text("message").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  expectedEndAt: timestamp("expected_end_at", { withTimezone: true }),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("maintenance_notice_message_length", sql`char_length(${table.message}) <= 500`),
  index("maintenance_notice_pending_starts_idx").on(table.startsAt).where(sql`${table.activatedAt} IS NULL AND ${table.cancelledAt} IS NULL`),
]);

export const externalIdentities = pgTable("external_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  issuer: text("issuer").notNull(),
  subject: text("subject").notNull(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }).notNull().defaultNow(),
  ...auditColumns,
}, (table) => [uniqueIndex("external_identity_issuer_subject").on(table.issuer, table.subject)]);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  activeHouseholdId: uuid("active_household_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const households = pgTable("households", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("Europe/London"),
  defaultCurrency: text("default_currency").notNull().default("GBP"),
  setupCompleted: boolean("setup_completed").notNull().default(false),
  deletionRequestedAt: timestamp("deletion_requested_at", { withTimezone: true }),
  deleteAfter: timestamp("delete_after", { withTimezone: true }),
  deletionRequestedByUserId: uuid("deletion_requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
  ...auditColumns,
});

export const sections = pgTable("sections", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  icon: text("icon").notNull().default("home"),
  accent: text("accent").notNull().default("sage"),
  position: integer("position").notNull().default(0),
  visible: boolean("visible").notNull().default(true),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  ...auditColumns,
}, (table) => [
  uniqueIndex("section_household_slug").on(table.householdId, table.slug),
  index("section_household_position").on(table.householdId, table.position),
]);

export const memberships = pgTable("memberships", {
  householdId: uuid("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: membershipRole("role").notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.householdId, table.userId] }), index("membership_user_idx").on(table.userId)]);

export const joinRequestStatus = pgEnum("join_request_status", ["pending", "approved", "declined"]);

/** §11 (#453): a no-household user's signal to a household's owners. One
 * pending request per (household, user) — enforced by a partial unique index
 * — makes creation idempotent; decisions keep the row as an audit trail. */
export const householdJoinRequests = pgTable("household_join_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: joinRequestStatus("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
}, (table) => [
  uniqueIndex("join_request_pending_once").on(table.householdId, table.userId).where(sql`${table.status} = 'pending'`),
  index("join_request_household_idx").on(table.householdId, table.status),
  index("join_request_user_idx").on(table.userId, table.status),
]);

export const items = pgTable("items", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  sectionId: uuid("section_id").notNull().references(() => sections.id, { onDelete: "restrict" }),
  title: text("title").notNull(),
  subtype: text("subtype"),
  provider: text("provider"),
  reference: text("reference"),
  costMinor: integer("cost_minor"),
  currency: text("currency").notNull(),
  startDate: date("start_date"),
  expiryDate: date("expiry_date"),
  renewalDate: date("renewal_date"),
  serviceDate: date("service_date"),
  recurrenceMonths: integer("recurrence_months"),
  snoozedUntil: date("snoozed_until"),
  notes: text("notes"),
  externalDocumentUrl: text("external_document_url"),
  status: itemStatus("status").notNull().default("active"),
  /** Inbound documents are deliberately invisible until a member reviews them. */
  requiresReview: boolean("requires_review").notNull().default(false),
  version: integer("version").notNull().default(1),
  ...auditColumns,
}, (table) => [
  index("item_household_status_idx").on(table.householdId, table.status),
  index("item_household_section_idx").on(table.householdId, table.sectionId),
]);

/** Metadata for an encrypted document; ciphertext and key material live in documentCrypto. */
export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").references(() => items.id, { onDelete: "set null" }),
  uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
  displayName: text("display_name").notNull(),
  mediaType: text("media_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  contentSha256: text("content_sha256").notNull(),
  lifecycle: documentLifecycle("lifecycle").notNull().default("receiving"),
  scanStatus: documentScanStatus("scan_status").notNull().default("pending"),
  failureCode: text("failure_code"),
  deleteAfter: timestamp("delete_after", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  availableAt: timestamp("available_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  ...auditColumns,
}, (table) => [
  index("document_household_item_created_idx").on(table.householdId, table.itemId, table.createdAt),
  index("document_household_lifecycle_created_idx").on(table.householdId, table.lifecycle, table.createdAt),
  check("document_openable_scan_status_valid", sql`${table.lifecycle} NOT IN ('available', 'pending_deletion') OR ${table.scanStatus} IN ('clean', 'skipped')`),
]);

/** Envelope-encryption metadata for one document; no plaintext key is persisted. */
export const documentCrypto = pgTable("document_crypto", {
  documentId: uuid("document_id").primaryKey().references(() => documents.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull(),
  ciphertextSize: integer("ciphertext_size").notNull(),
  envelopeVersion: integer("envelope_version").notNull(),
  contentIv: text("content_iv").notNull(),
  contentAuthTag: text("content_auth_tag").notNull(),
  wrappedDek: text("wrapped_dek").notNull(),
  wrapIv: text("wrap_iv").notNull(),
  wrapAuthTag: text("wrap_auth_tag").notNull(),
  keyId: text("key_id").notNull(),
  ...auditColumns,
}, (table) => [uniqueIndex("document_crypto_storage_key_unique").on(table.storageKey)]);

/** Durable, idempotent worker jobs for document lifecycle operations. */
export const documentJobs = pgTable("document_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  kind: documentJobKind("kind").notNull(),
  generation: integer("generation").notNull().default(1),
  status: documentJobStatus("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  leaseToken: uuid("lease_token"),
  lastError: text("last_error"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...auditColumns,
}, (table) => [
  uniqueIndex("document_job_once").on(table.documentId, table.kind, table.generation),
  index("document_job_claim_idx").on(table.status, table.nextAttemptAt, table.createdAt),
  index("document_job_lease_idx").on(table.status, table.leaseExpiresAt),
]);

/** Encrypted, non-downloadable bytes held only while a retryable scanner
 * outage is recoverable. This is deliberately separate from document_crypto. */
export const documentStagingObjects = pgTable("document_staging_objects", {
  documentId: uuid("document_id").primaryKey().references(() => documents.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull().unique(),
  purpose: text("purpose").notNull().default("scanner_recovery"),
  ciphertextSize: integer("ciphertext_size").notNull(),
  envelopeVersion: integer("envelope_version").notNull(),
  contentIv: text("content_iv").notNull(),
  contentAuthTag: text("content_auth_tag").notNull(),
  wrappedDek: text("wrapped_dek").notNull(),
  wrapIv: text("wrap_iv").notNull(),
  wrapAuthTag: text("wrap_auth_tag").notNull(),
  keyId: text("key_id").notNull(),
  status: text("status").notNull().default("pending"),
  recoveryExpiresAt: timestamp("recovery_expires_at", { withTimezone: true }).notNull(),
  purgeAttempts: integer("purge_attempts").notNull().default(0),
  purgeFailureCode: text("purge_failure_code"),
  ...auditColumns,
}, (table) => [
  check("document_staging_purpose_valid", sql`${table.purpose} = 'scanner_recovery'`),
  check("document_staging_status_valid", sql`${table.status} IN ('pending', 'purge_pending')`),
  index("document_staging_expiry_idx").on(table.status, table.recoveryExpiresAt),
]);

export const dueEvents = pgTable("due_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  kind: eventKind("kind").notNull(),
  dueDate: date("due_date").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedByUserId: uuid("completed_by_user_id").references(() => users.id),
  completionKey: text("completion_key"),
  nextEventId: uuid("next_event_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("due_event_household_date_idx").on(table.householdId, table.dueDate),
  uniqueIndex("due_event_completion_key").on(table.householdId, table.completionKey),
]);

export const reminderRules = pgTable("reminder_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  daysBefore: integer("days_before").notNull(),
  emailEnabled: boolean("email_enabled").notNull().default(true),
  pushEnabled: boolean("push_enabled").notNull().default(true),
}, (table) => [uniqueIndex("reminder_item_offset").on(table.itemId, table.daysBefore)]);

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Parser evidence and proposed item fields; never applied without approval. */
export const documentDrafts = pgTable("document_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  householdId: uuid("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: documentDraftStatus("status").notNull().default("pending_review"),
  extractedTextSha256: text("extracted_text_sha256").notNull(),
  evidence: jsonb("evidence").notNull(),
  proposal: jsonb("proposal").notNull(),
  approvedItemId: uuid("approved_item_id").references(() => items.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("document_draft_document_unique").on(table.documentId), index("document_draft_household_status_idx").on(table.householdId, table.status)]);

export const notificationStates = pgTable("notification_states", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  householdId: uuid("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  notificationId: text("notification_id").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.householdId, table.notificationId] }),
  index("notification_state_household_idx").on(table.householdId, table.userId),
]);

export const notificationDeliveries = pgTable("notification_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  eventId: uuid("event_id").notNull().references(() => dueEvents.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  channel: deliveryChannel("channel").notNull(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  status: deliveryStatus("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  leaseToken: uuid("lease_token"),
  lastError: text("last_error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  ...auditColumns,
}, (table) => [
  uniqueIndex("notification_delivery_once").on(table.eventId, table.userId, table.channel, table.scheduledFor),
  index("notification_claim_idx").on(table.status, table.scheduledFor),
]);

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").references(() => households.id, { onDelete: "set null" }),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  action: text("action").notNull(),
  changes: jsonb("changes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("audit_household_entity_idx").on(table.householdId, table.entityType, table.entityId),
  // Supports readWorkspace's item-activity feed query (entityType filter +
  // createdAt-descending scan), the only remaining unbounded audit_log read.
  index("audit_household_activity_idx").on(table.householdId, table.entityType, table.createdAt),
]);

/** A private, passphrase-encrypted household portability export. */
export const portableArchives = pgTable("portable_archives", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull().unique(),
  contentSha256: text("content_sha256").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  includesDocuments: boolean("includes_documents").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  downloadedAt: timestamp("downloaded_at", { withTimezone: true }),
  purgedAt: timestamp("purged_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("portable_archive_expiry_idx").on(table.expiresAt),
  index("portable_archive_household_created_idx").on(table.householdId, table.createdAt),
]);

/** Durable, content-free receipts for messages observed in the dedicated IMAP mailbox. */
export const imapIngestionMessages = pgTable("imap_ingestion_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  mailbox: text("mailbox").notNull(),
  mailboxUidValidity: text("mailbox_uid_validity").notNull(),
  mailboxUid: integer("mailbox_uid").notNull(),
  contentSha256: text("content_sha256").notNull(),
  recipientAliasSha256: text("recipient_alias_sha256").notNull(),
  recipientAliasGeneration: integer("recipient_alias_generation"),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  householdId: uuid("household_id").references(() => households.id, { onDelete: "set null" }),
  /** Legacy prototype link. New receipt and approval code must never use it. */
  reviewItemId: uuid("review_item_id").references(() => items.id, { onDelete: "set null" }),
  draftVersion: integer("draft_version").notNull().default(1),
  proposal: jsonb("proposal").notNull().default({}),
  fieldEvidence: jsonb("field_evidence").notNull().default({}),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  approvalOperationId: uuid("approval_operation_id"),
  approvalResultId: uuid("approval_result_id"),
  approvalRequestSha256: text("approval_request_sha256"),
  approvedItemId: uuid("approved_item_id").references(() => items.id, { onDelete: "set null" }),
  approvalStartedAt: timestamp("approval_started_at", { withTimezone: true }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  discardedAt: timestamp("discarded_at", { withTimezone: true }),
  expiredAt: timestamp("expired_at", { withTimezone: true }),
  status: imapIngestionStatus("status").notNull(),
  attempts: integer("attempts").notNull().default(1),
  failureCode: text("failure_code"),
  attachmentProcessingAttempts: integer("attachment_processing_attempts").notNull().default(0),
  attachmentProcessingLockedAt: timestamp("attachment_processing_locked_at", { withTimezone: true }),
  attachmentProcessingLeaseToken: uuid("attachment_processing_lease_token"),
  attachmentProcessingNextAttemptAt: timestamp("attachment_processing_next_attempt_at", { withTimezone: true }),
  attachmentProcessingFailureCode: text("attachment_processing_failure_code"),
  receiptStatus: deliveryStatus("receipt_status").notNull().default("processing"),
  receiptAttempts: integer("receipt_attempts").notNull().default(0),
  receiptLockedAt: timestamp("receipt_locked_at", { withTimezone: true }),
  receiptLeaseToken: uuid("receipt_lease_token"),
  receiptSentAt: timestamp("receipt_sent_at", { withTimezone: true }),
  receiptFailureCode: text("receipt_failure_code"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("imap_message_mailbox_uid_unique").on(table.mailbox, table.mailboxUidValidity, table.mailboxUid),
  uniqueIndex("imap_message_approval_operation_unique").on(table.approvalOperationId),
  uniqueIndex("imap_message_approval_result_unique").on(table.approvalResultId),
  index("imap_message_user_status_idx").on(table.userId, table.status, table.receivedAt),
  index("imap_message_household_status_idx").on(table.householdId, table.status, table.receivedAt),
  index("imap_message_expiry_idx").on(table.status, table.expiresAt),
  index("imap_message_approved_item_idx").on(table.approvedItemId),
  index("imap_receipt_claim_idx").on(table.receiptStatus, table.receiptLockedAt, table.createdAt),
  index("imap_message_recipient_content_idx").on(table.userId, table.contentSha256),
  index("imap_attachment_processing_claim_idx").on(table.status, table.attachmentProcessingLockedAt, table.createdAt),
]);

/** Content-free, leased notification operations for private mailbox receipts. */
export const imapNotificationDeliveries = pgTable("imap_notification_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id").notNull().references(() => imapIngestionMessages.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: imapNotificationKind("kind").notNull(),
  status: deliveryStatus("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  leaseToken: uuid("lease_token"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  failureCode: text("failure_code"),
  ...auditColumns,
}, (table) => [
  uniqueIndex("imap_notification_message_kind_unique").on(table.messageId, table.kind),
  index("imap_notification_claim_idx").on(table.status, table.nextAttemptAt, table.lockedAt),
]);

/** Generation-aware per-user aliases. Legacy prototype digests are retained
 * only as explicitly inactive rows and are never eligible for lookup. */
export const imapRecipientAliases = pgTable("imap_recipient_aliases", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  generation: integer("generation").notNull(),
  aliasSha256: text("alias_sha256").notNull(),
  status: imapRecipientAliasStatus("status").notNull().default("active"),
  activeUntil: timestamp("active_until", { withTimezone: true }),
  ...auditColumns,
}, (table) => [
  uniqueIndex("imap_recipient_alias_user_generation_unique").on(table.userId, table.generation),
  uniqueIndex("imap_recipient_alias_active_digest_unique").on(table.generation, table.aliasSha256).where(sql`${table.status} = 'active'`),
  index("imap_recipient_alias_user_status_idx").on(table.userId, table.status),
  check("imap_recipient_alias_generation_valid", sql`${table.generation} > 0 OR ${table.status} = 'legacy_inactive'`),
]);

/** Database-authoritative singleton for monotonic alias rotation handover. */
export const imapRecipientRotationState = pgTable("imap_recipient_rotation_state", {
  id: integer("id").primaryKey().default(1),
  currentGeneration: integer("current_generation").notNull(),
  currentCommitment: text("current_commitment").notNull(),
  previousGeneration: integer("previous_generation"),
  previousExpiresAt: timestamp("previous_expires_at", { withTimezone: true }),
  previousCommitment: text("previous_commitment"),
  ...auditColumns,
}, (table) => [
  check("imap_recipient_rotation_state_singleton", sql`${table.id} = 1`),
  check("imap_recipient_rotation_state_current_valid", sql`${table.currentGeneration} > 0`),
  check("imap_recipient_rotation_state_previous_valid", sql`${table.previousGeneration} IS NULL OR (${table.previousGeneration} > 0 AND ${table.previousGeneration} <> ${table.currentGeneration})`),
  check("imap_recipient_rotation_state_previous_pair", sql`(${table.previousGeneration} IS NULL) = (${table.previousExpiresAt} IS NULL) AND (${table.previousGeneration} IS NULL) = (${table.previousCommitment} IS NULL)`),
]);

/** Durable idempotency/result state for an explicit reviewed approval. This is
 * an operation ledger, not a private mailbox draft aggregate. */
export const reviewedIntakeOperations = pgTable("reviewed_intake_operations", {
  id: uuid("id").primaryKey(),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  source: reviewedIntakeOperationSource("source").notNull(),
  householdId: uuid("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  // Retained reviewed section UUID is audit metadata; section lifecycle must
  // remain independently replaceable after an operation completes.
  sectionId: uuid("section_id").notNull(),
  action: text("action").notNull(),
  targetItemId: uuid("target_item_id").references(() => items.id, { onDelete: "set null" }),
  itemId: uuid("item_id").notNull(),
  requestSha256: text("request_sha256").notNull(),
  resultId: uuid("result_id").notNull(),
  expectedDocument: boolean("expected_document").notNull().default(false),
  attachmentState: reviewedIntakeAttachmentState("attachment_state").notNull().default("not_requested"),
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
  status: reviewedIntakeOperationStatus("status").notNull(),
  failureCode: text("failure_code"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("reviewed_intake_operation_result_unique").on(table.resultId),
  index("reviewed_intake_operation_actor_idx").on(table.actorUserId, table.createdAt),
  index("reviewed_intake_operation_item_idx").on(table.itemId),
]);

/** Encrypted attachment bytes held until the recipient chooses a household, if needed. */
export const imapIngestionAttachments = pgTable("imap_ingestion_attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id").notNull().references(() => imapIngestionMessages.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  mediaType: text("media_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  contentSha256: text("content_sha256").notNull(),
  storageKey: text("storage_key").notNull().unique(),
  ciphertextSize: integer("ciphertext_size").notNull(),
  envelopeVersion: integer("envelope_version").notNull(),
  contentIv: text("content_iv").notNull(),
  contentAuthTag: text("content_auth_tag").notNull(),
  wrappedDek: text("wrapped_dek").notNull(),
  wrapIv: text("wrap_iv").notNull(),
  wrapAuthTag: text("wrap_auth_tag").notNull(),
  keyId: text("key_id").notNull(),
  status: imapAttachmentStatus("status").notNull().default("stored"),
  assignedDocumentId: uuid("assigned_document_id").references(() => documents.id, { onDelete: "set null" }),
  transferClaimToken: uuid("transfer_claim_token"),
  transferClaimedAt: timestamp("transfer_claimed_at", { withTimezone: true }),
  transferLeaseExpiresAt: timestamp("transfer_lease_expires_at", { withTimezone: true }),
  purgePending: boolean("purge_pending").notNull().default(false),
  purgeAttempts: integer("purge_attempts").notNull().default(0),
  purgeFailureCode: text("purge_failure_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("imap_attachment_message_hash_unique").on(table.messageId, table.contentSha256),
  index("imap_attachment_message_status_idx").on(table.messageId, table.status),
]);

/** Durable bridge for the crash window after ciphertext is durable and before
 * its attachment metadata row commits. It contains no plaintext or mail. */
export const imapIngestionStagingObjects = pgTable("imap_ingestion_staging_objects", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id").notNull(),
  leaseToken: uuid("lease_token").notNull(),
  storageKey: text("storage_key").notNull().unique(),
  status: text("status").notNull().default("pending"),
  purgeAttempts: integer("purge_attempts").notNull().default(0),
  purgeFailureCode: text("purge_failure_code"),
  ...auditColumns,
}, (table) => [
  foreignKey({
    name: "imap_staging_objects_message_id_fk",
    columns: [table.messageId],
    foreignColumns: [imapIngestionMessages.id],
  }).onDelete("cascade"),
  index("imap_staging_object_message_status_idx").on(table.messageId, table.status),
  index("imap_staging_object_created_idx").on(table.status, table.createdAt),
  check("imap_staging_object_status_valid", sql`${table.status} IN ('pending', 'committed', 'purge_pending')`),
]);
