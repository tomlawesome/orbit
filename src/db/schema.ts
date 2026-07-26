import { boolean, date, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
export const imapIngestionStatus = pgEnum("imap_ingestion_status", ["pending_review", "quarantined", "failed"]);

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
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  leaseToken: uuid("lease_token"),
  lastError: text("last_error"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...auditColumns,
}, (table) => [
  uniqueIndex("document_job_once").on(table.documentId, table.kind, table.generation),
  index("document_job_claim_idx").on(table.status, table.createdAt),
  index("document_job_lease_idx").on(table.status, table.leaseExpiresAt),
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
}, (table) => [index("audit_household_entity_idx").on(table.householdId, table.entityType, table.entityId)]);

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
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  status: imapIngestionStatus("status").notNull(),
  attempts: integer("attempts").notNull().default(1),
  failureCode: text("failure_code"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("imap_message_mailbox_uid_unique").on(table.mailbox, table.mailboxUidValidity, table.mailboxUid),
  uniqueIndex("imap_message_content_unique").on(table.contentSha256),
  index("imap_message_user_status_idx").on(table.userId, table.status, table.receivedAt),
]);
