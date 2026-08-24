import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import baselineFixture from "../fixtures/migration-baseline.json";
import { canonicalMigrationChecksum, readExpectedMigrationHashes as readProductionExpectedMigrationHashes } from "../../../src/db/migration-integrity";

export const BASELINE_MIGRATION_TAG = baselineFixture.finalMigrationTag;
export const EXPECTED_POSTGRES_MAJOR = baselineFixture.postgresMajor;
const MIGRATION_SCHEMA = "drizzle";
const MIGRATION_TABLE = "__drizzle_migrations";

type FixtureRow = Record<string, unknown>;
type MigrationJournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};
type MigrationJournal = {
  version: string;
  dialect: string;
  entries: MigrationJournalEntry[];
};

export const EXPECTED_ENUMS: Record<string, string[]> = {
  delivery_channel: ["email", "web_push"],
  delivery_status: ["pending", "processing", "sent", "retry", "failed", "cancelled"],
  document_draft_status: ["pending_review", "approved", "discarded"],
  document_job_kind: ["scan", "encrypt", "purge", "reconcile", "rewrap"],
  document_job_status: ["pending", "processing", "retry", "completed", "failed", "cancelled"],
  document_lifecycle: ["receiving", "validating", "quarantined", "scanning", "encrypting", "available", "pending_deletion", "deleted", "rejected"],
  document_scan_status: ["pending", "clean", "infected", "error", "skipped"],
  event_kind: ["renewal", "service"],
  imap_attachment_status: ["stored", "rejected", "assigned"],
  imap_recipient_alias_status: ["active", "legacy_inactive"],
  imap_ingestion_status: ["processing", "pending_review", "quarantined", "failed", "completed", "discarded", "approving", "recoverable", "expired"],
  imap_notification_kind: ["receipt", "review_ready"],
  item_status: ["active", "expired", "cancelled", "archived"],
  join_request_status: ["pending", "approved", "declined"],
  membership_role: ["owner", "member"],
  theme_mode: ["system", "light", "dark"],
  reviewed_intake_operation_status: ["processing", "pending_attachment", "completed", "recoverable", "failed"],
  reviewed_intake_operation_source: ["direct_upload", "mailbox_draft"],
  reviewed_intake_attachment_state: ["not_requested", "pending", "attached"],
};

export const EXPECTED_TABLE_COLUMNS: Record<string, string[]> = {
  audit_log: ["id", "household_id", "actor_user_id", "entity_type", "entity_id", "action", "changes", "created_at"],
  document_crypto: ["document_id", "storage_key", "ciphertext_size", "envelope_version", "content_iv", "content_auth_tag", "wrapped_dek", "wrap_iv", "wrap_auth_tag", "key_id", "created_at", "updated_at"],
  document_drafts: ["id", "document_id", "household_id", "requested_by_user_id", "status", "extracted_text_sha256", "evidence", "proposal", "approved_item_id", "created_at", "updated_at"],
  document_jobs: ["id", "document_id", "kind", "generation", "status", "attempts", "next_attempt_at", "locked_at", "lease_expires_at", "lease_token", "last_error", "completed_at", "created_at", "updated_at"],
  document_staging_objects: ["document_id", "storage_key", "purpose", "ciphertext_size", "envelope_version", "content_iv", "content_auth_tag", "wrapped_dek", "wrap_iv", "wrap_auth_tag", "key_id", "status", "recovery_expires_at", "purge_attempts", "purge_failure_code", "created_at", "updated_at"],
  documents: ["id", "household_id", "item_id", "uploaded_by_user_id", "display_name", "media_type", "size_bytes", "content_sha256", "lifecycle", "scan_status", "failure_code", "delete_after", "deleted_at", "available_at", "version", "created_at", "updated_at"],
  due_events: ["id", "household_id", "item_id", "kind", "due_date", "completed_at", "completed_by_user_id", "completion_key", "next_event_id", "created_at"],
  external_identities: ["id", "user_id", "issuer", "subject", "last_login_at", "created_at", "updated_at"],
  household_join_requests: ["id", "household_id", "user_id", "status", "created_at", "decided_at", "decided_by_user_id"],
  households: ["id", "name", "timezone", "default_currency", "setup_completed", "deletion_requested_at", "delete_after", "deletion_requested_by_user_id", "created_at", "updated_at"],
  imap_ingestion_attachments: ["id", "message_id", "display_name", "media_type", "size_bytes", "content_sha256", "storage_key", "ciphertext_size", "envelope_version", "content_iv", "content_auth_tag", "wrapped_dek", "wrap_iv", "wrap_auth_tag", "key_id", "status", "assigned_document_id", "transfer_claim_token", "transfer_claimed_at", "transfer_lease_expires_at", "purge_pending", "purge_attempts", "purge_failure_code", "created_at", "updated_at"],
  imap_ingestion_messages: ["id", "mailbox", "mailbox_uid_validity", "mailbox_uid", "content_sha256", "recipient_alias_sha256", "recipient_alias_generation", "user_id", "household_id", "review_item_id", "draft_version", "proposal", "field_evidence", "expires_at", "approval_operation_id", "approval_result_id", "approval_request_sha256", "approved_item_id", "approval_started_at", "approved_at", "discarded_at", "expired_at", "status", "attempts", "failure_code", "attachment_processing_attempts", "attachment_processing_locked_at", "attachment_processing_lease_token", "attachment_processing_next_attempt_at", "attachment_processing_failure_code", "receipt_status", "receipt_attempts", "receipt_locked_at", "receipt_lease_token", "receipt_sent_at", "receipt_failure_code", "received_at", "created_at", "updated_at"],
  items: ["id", "household_id", "section_id", "title", "subtype", "provider", "reference", "cost_minor", "currency", "start_date", "expiry_date", "renewal_date", "service_date", "recurrence_months", "snoozed_until", "notes", "external_document_url", "status", "requires_review", "version", "created_at", "updated_at"],
  memberships: ["household_id", "user_id", "role", "created_at"],
  notification_deliveries: ["id", "household_id", "event_id", "user_id", "channel", "scheduled_for", "status", "attempts", "locked_at", "lease_token", "last_error", "sent_at", "created_at", "updated_at"],
  notification_states: ["user_id", "household_id", "notification_id", "read_at", "dismissed_at", "updated_at"],
  portable_archives: ["id", "household_id", "requested_by_user_id", "storage_key", "content_sha256", "size_bytes", "includes_documents", "expires_at", "downloaded_at", "purged_at", "created_at"],
  push_subscriptions: ["id", "user_id", "endpoint", "p256dh", "auth", "user_agent", "expires_at", "revoked_at", "created_at"],
  reminder_rules: ["id", "item_id", "days_before", "email_enabled", "push_enabled"],
  sections: ["id", "household_id", "slug", "name", "icon", "accent", "position", "visible", "archived_at", "created_at", "updated_at"],
  sessions: ["id", "user_id", "token_hash", "active_household_id", "expires_at", "rotated_at", "created_at"],
  user_preferences: ["user_id", "theme_mode", "theme_id", "text_size", "urgency_palette", "email_notifications", "push_notifications", "first_warning_days", "final_warning_days", "updated_at"],
  users: ["id", "email", "email_verified", "display_name", "avatar_url", "is_instance_admin", "disabled_at", "created_at", "updated_at"],
  imap_recipient_aliases: ["id", "user_id", "generation", "alias_sha256", "status", "active_until", "created_at", "updated_at"],
  imap_recipient_rotation_state: ["id", "current_generation", "current_commitment", "previous_generation", "previous_expires_at", "previous_commitment", "created_at", "updated_at"],
  instance_authority: ["singleton", "primary_user_id", "updated_at"],
  instance_maintenance: ["singleton", "id", "active", "current_window_id", "expected_end_at", "version", "updated_at"],
  maintenance_windows: ["id", "status", "scheduled_start_at", "started_at", "expected_end_at", "ended_at", "cancelled_at", "absorbed_into_id", "created_at", "updated_at"],
  maintenance_updates: ["id", "window_id", "kind", "body", "published_at", "created_at", "edited_at"],
  reviewed_intake_operations: ["id", "actor_user_id", "source", "household_id", "section_id", "action", "target_item_id", "item_id", "request_sha256", "result_id", "expected_document", "attachment_state", "document_id", "status", "failure_code", "completed_at", "created_at", "updated_at"],
  imap_ingestion_staging_objects: ["id", "message_id", "lease_token", "storage_key", "status", "purge_attempts", "purge_failure_code", "created_at", "updated_at"],
  imap_notification_deliveries: ["id", "message_id", "user_id", "kind", "status", "attempts", "next_attempt_at", "locked_at", "lease_token", "sent_at", "failure_code", "created_at", "updated_at"],
};
for (const columns of Object.values(EXPECTED_TABLE_COLUMNS)) columns.sort();

type ExpectedIndex = { table: string; columns: string[]; unique: boolean };
export const EXPECTED_INDEXES: Record<string, ExpectedIndex> = {
  audit_household_activity_idx: { table: "audit_log", columns: ["household_id", "entity_type", "created_at"], unique: false },
  audit_household_entity_idx: { table: "audit_log", columns: ["household_id", "entity_type", "entity_id"], unique: false },
  document_crypto_storage_key_unique: { table: "document_crypto", columns: ["storage_key"], unique: true },
  document_draft_document_unique: { table: "document_drafts", columns: ["document_id"], unique: true },
  document_draft_household_status_idx: { table: "document_drafts", columns: ["household_id", "status"], unique: false },
  document_household_item_created_idx: { table: "documents", columns: ["household_id", "item_id", "created_at"], unique: false },
  document_household_lifecycle_created_idx: { table: "documents", columns: ["household_id", "lifecycle", "created_at"], unique: false },
  document_job_claim_idx: { table: "document_jobs", columns: ["status", "next_attempt_at", "created_at"], unique: false },
  document_job_lease_idx: { table: "document_jobs", columns: ["status", "lease_expires_at"], unique: false },
  document_job_once: { table: "document_jobs", columns: ["document_id", "kind", "generation"], unique: true },
  document_staging_expiry_idx: { table: "document_staging_objects", columns: ["status", "recovery_expires_at"], unique: false },
  document_staging_objects_storage_key_unique: { table: "document_staging_objects", columns: ["storage_key"], unique: true },
  due_event_completion_key: { table: "due_events", columns: ["household_id", "completion_key"], unique: true },
  due_event_household_date_idx: { table: "due_events", columns: ["household_id", "due_date"], unique: false },
  external_identity_issuer_subject: { table: "external_identities", columns: ["issuer", "subject"], unique: true },
  household_deletion_due_idx: { table: "households", columns: ["delete_after"], unique: false },
  imap_attachment_message_hash_unique: { table: "imap_ingestion_attachments", columns: ["message_id", "content_sha256"], unique: true },
  imap_attachment_message_status_idx: { table: "imap_ingestion_attachments", columns: ["message_id", "status"], unique: false },
  imap_ingestion_attachments_storage_key_unique: { table: "imap_ingestion_attachments", columns: ["storage_key"], unique: true },
  imap_ingestion_review_item_idx: { table: "imap_ingestion_messages", columns: ["review_item_id"], unique: false },
  imap_message_recipient_content_idx: { table: "imap_ingestion_messages", columns: ["user_id", "content_sha256"], unique: false },
  imap_message_approval_operation_unique: { table: "imap_ingestion_messages", columns: ["approval_operation_id"], unique: true },
  imap_message_approval_result_unique: { table: "imap_ingestion_messages", columns: ["approval_result_id"], unique: true },
  imap_message_approved_item_idx: { table: "imap_ingestion_messages", columns: ["approved_item_id"], unique: false },
  imap_message_expiry_idx: { table: "imap_ingestion_messages", columns: ["status", "expires_at"], unique: false },
  imap_message_household_status_idx: { table: "imap_ingestion_messages", columns: ["household_id", "status", "received_at"], unique: false },
  imap_message_mailbox_uid_unique: { table: "imap_ingestion_messages", columns: ["mailbox", "mailbox_uid_validity", "mailbox_uid"], unique: true },
  imap_message_user_status_idx: { table: "imap_ingestion_messages", columns: ["user_id", "status", "received_at"], unique: false },
  imap_attachment_processing_claim_idx: { table: "imap_ingestion_messages", columns: ["status", "attachment_processing_locked_at", "created_at"], unique: false },
  imap_staging_object_message_status_idx: { table: "imap_ingestion_staging_objects", columns: ["message_id", "status"], unique: false },
  imap_staging_object_created_idx: { table: "imap_ingestion_staging_objects", columns: ["status", "created_at"], unique: false },
  imap_notification_message_kind_unique: { table: "imap_notification_deliveries", columns: ["message_id", "kind"], unique: true },
  imap_notification_claim_idx: { table: "imap_notification_deliveries", columns: ["status", "next_attempt_at", "locked_at"], unique: false },
  imap_ingestion_staging_objects_storage_key_unique: { table: "imap_ingestion_staging_objects", columns: ["storage_key"], unique: true },
  imap_receipt_claim_idx: { table: "imap_ingestion_messages", columns: ["receipt_status", "receipt_locked_at", "created_at"], unique: false },
  imap_receipt_delivery_idx: { table: "imap_ingestion_messages", columns: ["receipt_status", "created_at"], unique: false },
  imap_recipient_alias_active_digest_unique: { table: "imap_recipient_aliases", columns: ["generation", "alias_sha256"], unique: true },
  imap_recipient_alias_user_generation_unique: { table: "imap_recipient_aliases", columns: ["user_id", "generation"], unique: true },
  imap_recipient_alias_user_status_idx: { table: "imap_recipient_aliases", columns: ["user_id", "status"], unique: false },
  // Partial: at most one open window, enforced by the database (orbit#585).
  maintenance_window_open_unique: { table: "maintenance_windows", columns: ["status"], unique: true },
  // Partial: the effective-state probe the guard pays on every request.
  maintenance_window_scheduled_start_idx: { table: "maintenance_windows", columns: ["scheduled_start_at"], unique: false },
  maintenance_update_window_published_idx: { table: "maintenance_updates", columns: ["window_id", "published_at", "id"], unique: false },
  reviewed_intake_operation_result_unique: { table: "reviewed_intake_operations", columns: ["result_id"], unique: true },
  reviewed_intake_operation_actor_idx: { table: "reviewed_intake_operations", columns: ["actor_user_id", "created_at"], unique: false },
  reviewed_intake_operation_item_idx: { table: "reviewed_intake_operations", columns: ["item_id"], unique: false },
  join_request_household_idx: { table: "household_join_requests", columns: ["household_id", "status"], unique: false },
  join_request_pending_once: { table: "household_join_requests", columns: ["household_id", "user_id"], unique: true },
  join_request_user_idx: { table: "household_join_requests", columns: ["user_id", "status"], unique: false },
  item_household_section_idx: { table: "items", columns: ["household_id", "section_id"], unique: false },
  item_household_status_idx: { table: "items", columns: ["household_id", "status"], unique: false },
  membership_user_idx: { table: "memberships", columns: ["user_id"], unique: false },
  notification_claim_idx: { table: "notification_deliveries", columns: ["status", "scheduled_for"], unique: false },
  notification_delivery_once: { table: "notification_deliveries", columns: ["event_id", "user_id", "channel", "scheduled_for"], unique: true },
  notification_state_household_idx: { table: "notification_states", columns: ["household_id", "user_id"], unique: false },
  portable_archive_expiry_idx: { table: "portable_archives", columns: ["expires_at"], unique: false },
  portable_archive_household_created_idx: { table: "portable_archives", columns: ["household_id", "created_at"], unique: false },
  portable_archives_storage_key_unique: { table: "portable_archives", columns: ["storage_key"], unique: true },
  push_subscriptions_endpoint_unique: { table: "push_subscriptions", columns: ["endpoint"], unique: true },
  reminder_item_offset: { table: "reminder_rules", columns: ["item_id", "days_before"], unique: true },
  section_household_position: { table: "sections", columns: ["household_id", "position"], unique: false },
  section_household_slug: { table: "sections", columns: ["household_id", "slug"], unique: true },
  sessions_token_hash_unique: { table: "sessions", columns: ["token_hash"], unique: true },
  user_email_lookup_idx: { table: "users", columns: ["email"], unique: false },
};

type ExpectedConstraint = {
  table: string;
  type: "p" | "u" | "f";
  columns: string[];
  referencedTable?: string;
  referencedColumns?: string[];
  deleteAction?: string;
};
const primary = (table: string, columns: string[]): ExpectedConstraint => ({ table, type: "p", columns });
const unique = (table: string, columns: string[]): ExpectedConstraint => ({ table, type: "u", columns });
const foreign = (table: string, columns: string[], referencedTable: string, referencedColumns: string[], deleteAction: string): ExpectedConstraint => ({
  table,
  type: "f",
  columns,
  referencedTable,
  referencedColumns,
  deleteAction,
});

export const EXPECTED_CONSTRAINTS: Record<string, ExpectedConstraint> = {
  audit_log_actor_user_id_users_id_fk: foreign("audit_log", ["actor_user_id"], "users", ["id"], "no_action"),
  audit_log_household_id_households_id_fk: foreign("audit_log", ["household_id"], "households", ["id"], "set_null"),
  audit_log_pkey: primary("audit_log", ["id"]),
  document_crypto_document_id_documents_id_fk: foreign("document_crypto", ["document_id"], "documents", ["id"], "cascade"),
  document_crypto_pkey: primary("document_crypto", ["document_id"]),
  document_draft_document_unique: unique("document_drafts", ["document_id"]),
  document_drafts_approved_item_id_items_id_fk: foreign("document_drafts", ["approved_item_id"], "items", ["id"], "set_null"),
  document_drafts_document_id_documents_id_fk: foreign("document_drafts", ["document_id"], "documents", ["id"], "cascade"),
  document_drafts_household_id_households_id_fk: foreign("document_drafts", ["household_id"], "households", ["id"], "cascade"),
  document_drafts_pkey: primary("document_drafts", ["id"]),
  document_drafts_requested_by_user_id_users_id_fk: foreign("document_drafts", ["requested_by_user_id"], "users", ["id"], "cascade"),
  document_jobs_document_id_documents_id_fk: foreign("document_jobs", ["document_id"], "documents", ["id"], "cascade"),
  document_jobs_pkey: primary("document_jobs", ["id"]),
  document_staging_objects_document_id_documents_id_fk: foreign("document_staging_objects", ["document_id"], "documents", ["id"], "cascade"),
  document_staging_objects_pkey: primary("document_staging_objects", ["document_id"]),
  document_staging_objects_storage_key_unique: unique("document_staging_objects", ["storage_key"]),
  documents_household_id_households_id_fk: foreign("documents", ["household_id"], "households", ["id"], "cascade"),
  documents_pkey: primary("documents", ["id"]),
  documents_item_id_items_id_fk: foreign("documents", ["item_id"], "items", ["id"], "set_null"),
  documents_uploaded_by_user_id_users_id_fk: foreign("documents", ["uploaded_by_user_id"], "users", ["id"], "set_null"),
  due_events_completed_by_user_id_users_id_fk: foreign("due_events", ["completed_by_user_id"], "users", ["id"], "no_action"),
  due_events_household_id_households_id_fk: foreign("due_events", ["household_id"], "households", ["id"], "cascade"),
  due_events_item_id_items_id_fk: foreign("due_events", ["item_id"], "items", ["id"], "cascade"),
  due_events_pkey: primary("due_events", ["id"]),
  external_identities_pkey: primary("external_identities", ["id"]),
  external_identities_user_id_users_id_fk: foreign("external_identities", ["user_id"], "users", ["id"], "cascade"),
  household_join_requests_decided_by_user_id_users_id_fk: foreign("household_join_requests", ["decided_by_user_id"], "users", ["id"], "set_null"),
  instance_authority_pkey: primary("instance_authority", ["singleton"]),
  instance_authority_primary_user_id_users_id_fk: foreign("instance_authority", ["primary_user_id"], "users", ["id"], "restrict"),
  instance_maintenance_pkey: primary("instance_maintenance", ["singleton"]),
  instance_maintenance_current_window_id_fk: foreign("instance_maintenance", ["current_window_id"], "maintenance_windows", ["id"], "no_action"),
  maintenance_windows_pkey: primary("maintenance_windows", ["id"]),
  maintenance_window_absorbed_into_id_fk: foreign("maintenance_windows", ["absorbed_into_id"], "maintenance_windows", ["id"], "no_action"),
  maintenance_updates_pkey: primary("maintenance_updates", ["id"]),
  maintenance_updates_window_id_fk: foreign("maintenance_updates", ["window_id"], "maintenance_windows", ["id"], "cascade"),
  household_join_requests_household_id_households_id_fk: foreign("household_join_requests", ["household_id"], "households", ["id"], "cascade"),
  household_join_requests_pkey: primary("household_join_requests", ["id"]),
  household_join_requests_user_id_users_id_fk: foreign("household_join_requests", ["user_id"], "users", ["id"], "cascade"),
  households_deletion_requested_by_user_id_users_id_fk: foreign("households", ["deletion_requested_by_user_id"], "users", ["id"], "set_null"),
  households_pkey: primary("households", ["id"]),
  imap_ingestion_attachments_assigned_document_id_documents_id_fk: foreign("imap_ingestion_attachments", ["assigned_document_id"], "documents", ["id"], "set_null"),
  imap_ingestion_attachments_message_id_imap_ingestion_messages_i: foreign("imap_ingestion_attachments", ["message_id"], "imap_ingestion_messages", ["id"], "cascade"),
  imap_ingestion_attachments_pkey: primary("imap_ingestion_attachments", ["id"]),
  imap_ingestion_attachments_storage_key_unique: unique("imap_ingestion_attachments", ["storage_key"]),
  imap_ingestion_messages_household_id_households_id_fk: foreign("imap_ingestion_messages", ["household_id"], "households", ["id"], "set_null"),
  imap_ingestion_messages_pkey: primary("imap_ingestion_messages", ["id"]),
  imap_ingestion_messages_review_item_id_items_id_fk: foreign("imap_ingestion_messages", ["review_item_id"], "items", ["id"], "set_null"),
  imap_ingestion_messages_approved_item_id_items_id_fk: foreign("imap_ingestion_messages", ["approved_item_id"], "items", ["id"], "set_null"),
  imap_ingestion_messages_user_id_users_id_fk: foreign("imap_ingestion_messages", ["user_id"], "users", ["id"], "set_null"),
  imap_staging_objects_message_id_fk: foreign("imap_ingestion_staging_objects", ["message_id"], "imap_ingestion_messages", ["id"], "cascade"),
  imap_ingestion_staging_objects_pkey: primary("imap_ingestion_staging_objects", ["id"]),
  imap_ingestion_staging_objects_storage_key_unique: unique("imap_ingestion_staging_objects", ["storage_key"]),
  imap_notification_deliveries_pkey: primary("imap_notification_deliveries", ["id"]),
  imap_notification_deliveries_message_id_fk: foreign("imap_notification_deliveries", ["message_id"], "imap_ingestion_messages", ["id"], "cascade"),
  imap_notification_deliveries_user_id_users_id_fk: foreign("imap_notification_deliveries", ["user_id"], "users", ["id"], "cascade"),
  imap_recipient_aliases_pkey: primary("imap_recipient_aliases", ["id"]),
  imap_recipient_aliases_user_id_users_id_fk: foreign("imap_recipient_aliases", ["user_id"], "users", ["id"], "cascade"),
  imap_recipient_rotation_state_pkey: primary("imap_recipient_rotation_state", ["id"]),
  imap_attachment_message_hash_unique: unique("imap_ingestion_attachments", ["message_id", "content_sha256"]),
  items_household_id_households_id_fk: foreign("items", ["household_id"], "households", ["id"], "cascade"),
  items_section_id_sections_id_fk: foreign("items", ["section_id"], "sections", ["id"], "restrict"),
  items_pkey: primary("items", ["id"]),
  memberships_household_id_households_id_fk: foreign("memberships", ["household_id"], "households", ["id"], "cascade"),
  memberships_household_id_user_id_pk: primary("memberships", ["household_id", "user_id"]),
  memberships_user_id_users_id_fk: foreign("memberships", ["user_id"], "users", ["id"], "cascade"),
  notification_deliveries_event_id_due_events_id_fk: foreign("notification_deliveries", ["event_id"], "due_events", ["id"], "cascade"),
  notification_deliveries_household_id_households_id_fk: foreign("notification_deliveries", ["household_id"], "households", ["id"], "cascade"),
  notification_deliveries_pkey: primary("notification_deliveries", ["id"]),
  notification_deliveries_user_id_users_id_fk: foreign("notification_deliveries", ["user_id"], "users", ["id"], "cascade"),
  notification_states_household_id_households_id_fk: foreign("notification_states", ["household_id"], "households", ["id"], "cascade"),
  notification_states_user_id_household_id_notification_id_pk: primary("notification_states", ["user_id", "household_id", "notification_id"]),
  notification_states_user_id_users_id_fk: foreign("notification_states", ["user_id"], "users", ["id"], "cascade"),
  portable_archives_household_id_households_id_fk: foreign("portable_archives", ["household_id"], "households", ["id"], "cascade"),
  portable_archives_pkey: primary("portable_archives", ["id"]),
  portable_archives_requested_by_user_id_users_id_fk: foreign("portable_archives", ["requested_by_user_id"], "users", ["id"], "cascade"),
  portable_archives_storage_key_unique: unique("portable_archives", ["storage_key"]),
  push_subscriptions_endpoint_unique: unique("push_subscriptions", ["endpoint"]),
  push_subscriptions_pkey: primary("push_subscriptions", ["id"]),
  push_subscriptions_user_id_users_id_fk: foreign("push_subscriptions", ["user_id"], "users", ["id"], "cascade"),
  reminder_rules_item_id_items_id_fk: foreign("reminder_rules", ["item_id"], "items", ["id"], "cascade"),
  reminder_rules_pkey: primary("reminder_rules", ["id"]),
  sections_household_id_households_id_fk: foreign("sections", ["household_id"], "households", ["id"], "cascade"),
  sections_pkey: primary("sections", ["id"]),
  sessions_pkey: primary("sessions", ["id"]),
  sessions_token_hash_unique: unique("sessions", ["token_hash"]),
  sessions_user_id_users_id_fk: foreign("sessions", ["user_id"], "users", ["id"], "cascade"),
  user_preferences_pkey: primary("user_preferences", ["user_id"]),
  user_preferences_user_id_users_id_fk: foreign("user_preferences", ["user_id"], "users", ["id"], "cascade"),
  users_pkey: primary("users", ["id"]),
  reviewed_intake_operations_pkey: primary("reviewed_intake_operations", ["id"]),
  reviewed_intake_operations_actor_user_id_users_id_fk: foreign("reviewed_intake_operations", ["actor_user_id"], "users", ["id"], "cascade"),
  reviewed_intake_operations_household_id_households_id_fk: foreign("reviewed_intake_operations", ["household_id"], "households", ["id"], "cascade"),
  reviewed_intake_operations_target_item_id_items_id_fk: foreign("reviewed_intake_operations", ["target_item_id"], "items", ["id"], "set_null"),
  reviewed_intake_operations_document_id_documents_id_fk: foreign("reviewed_intake_operations", ["document_id"], "documents", ["id"], "set_null"),
};

type PostgresClient = ReturnType<typeof postgres>;

export interface MigrationTestDatabase {
  name: string;
  url: string;
  client: PostgresClient;
  cleanup(): Promise<void>;
}

export interface TemporaryMigrationDirectory {
  path: string;
  cleanup(): Promise<void>;
}

type MigrationDefinition = { tag: string; hash: string };

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error(`Unsafe migration test identifier: ${value}`);
  return `"${value}"`;
}

function databaseNameFor(label: string): string {
  const safeLabel = label.replace(/[^a-z0-9_]/giu, "_").toLowerCase();
  return `orbit_migration_${safeLabel}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function databaseUrlFor(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function adminDatabaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

export async function createMigrationTestDatabase(label: string): Promise<MigrationTestDatabase> {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl) throw new Error("DATABASE_URL is required for migration evidence");

  const name = databaseNameFor(label);
  const url = databaseUrlFor(configuredUrl, name);
  const admin = postgres(adminDatabaseUrl(configuredUrl), { max: 1, prepare: false });
  try {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(name)}`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const client = postgres(url, { max: 2, prepare: false });
  let cleanedUp = false;
  return {
    name,
    url,
    client,
    async cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      await client.end({ timeout: 5 });
      const cleanupAdmin = postgres(adminDatabaseUrl(configuredUrl), { max: 1, prepare: false });
      try {
        await cleanupAdmin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
      } finally {
        await cleanupAdmin.end({ timeout: 5 });
      }
    },
  };
}

async function readJournalDefinition(migrationsFolder: string): Promise<MigrationJournal> {
  const folder = resolve(process.cwd(), migrationsFolder);
  const raw = await readFile(join(folder, "meta", "_journal.json"), "utf8");
  return JSON.parse(raw) as MigrationJournal;
}

async function migrationDefinitions(migrationsFolder: string): Promise<MigrationDefinition[]> {
  const folder = resolve(process.cwd(), migrationsFolder);
  const journal = await readJournalDefinition(folder);
  return Promise.all(journal.entries.map(async (entry) => ({
    tag: entry.tag,
    hash: canonicalMigrationChecksum(await readFile(join(folder, `${entry.tag}.sql`))),
  })));
}

export async function verifyMigrationPrefix(migrationsFolder: string): Promise<void> {
  const folder = resolve(process.cwd(), migrationsFolder);
  const journal = await readJournalDefinition(folder);
  const expectedTags = baselineFixture.migrationPrefix.map((migration) => migration.tag);
  const actualTags = journal.entries.slice(0, expectedTags.length).map((entry) => entry.tag);
  if (JSON.stringify(actualTags) !== JSON.stringify(expectedTags)) {
    throw new Error("The checked-in migration journal no longer contains the supported immutable prefix");
  }

  for (const migration of baselineFixture.migrationPrefix) {
    const content = await readFile(join(folder, `${migration.tag}.sql`));
    const actualHash = canonicalMigrationChecksum(content);
    if (actualHash !== migration.sha256) {
      throw new Error(`Migration checksum mismatch for ${migration.tag}`);
    }
  }
}

export async function readExpectedMigrationHashes(migrationsFolder: string): Promise<string[]> {
  return (await readProductionExpectedMigrationHashes(resolve(process.cwd(), migrationsFolder))).map((migration) => migration.hash);
}

export async function createBaselineMigrationDirectory(migrationsFolder: string): Promise<TemporaryMigrationDirectory> {
  await verifyMigrationPrefix(migrationsFolder);
  const sourceFolder = resolve(process.cwd(), migrationsFolder);
  const targetFolder = await mkdtemp(join(tmpdir(), "orbit-baseline-migrations-"));
  await mkdir(join(targetFolder, "meta"), { recursive: true });
  const sourceJournal = await readJournalDefinition(sourceFolder);
  const baselineTags = new Set(baselineFixture.migrationPrefix.map((migration) => migration.tag));
  for (const migration of baselineFixture.migrationPrefix) {
    await cp(join(sourceFolder, `${migration.tag}.sql`), join(targetFolder, `${migration.tag}.sql`));
  }
  await writeFile(join(targetFolder, "meta", "_journal.json"), JSON.stringify({
    ...sourceJournal,
    entries: sourceJournal.entries.filter((entry) => baselineTags.has(entry.tag)),
  }, null, 2) + "\n");
  return {
    path: targetFolder,
    cleanup: () => rm(targetFolder, { recursive: true, force: true }),
  };
}

export async function createMigrationDirectoryThroughTag(migrationsFolder: string, tag: string): Promise<TemporaryMigrationDirectory> {
  const sourceFolder = resolve(process.cwd(), migrationsFolder);
  const sourceJournal = await readJournalDefinition(sourceFolder);
  const cutoffIndex = sourceJournal.entries.findIndex((entry) => entry.tag === tag);
  if (cutoffIndex === -1) throw new Error(`Migration tag not found in journal: ${tag}`);
  const includedEntries = sourceJournal.entries.slice(0, cutoffIndex + 1);

  const targetFolder = await mkdtemp(join(tmpdir(), "orbit-through-tag-migrations-"));
  await mkdir(join(targetFolder, "meta"), { recursive: true });
  for (const entry of includedEntries) {
    await cp(join(sourceFolder, `${entry.tag}.sql`), join(targetFolder, `${entry.tag}.sql`));
  }
  await writeFile(join(targetFolder, "meta", "_journal.json"), JSON.stringify({
    ...sourceJournal,
    entries: includedEntries,
  }, null, 2) + "\n");
  return {
    path: targetFolder,
    cleanup: () => rm(targetFolder, { recursive: true, force: true }),
  };
}

export async function createInvalidMigrationDirectory(migrationsFolder: string): Promise<TemporaryMigrationDirectory & { failedTag: string }> {
  const sourceFolder = resolve(process.cwd(), migrationsFolder);
  const targetFolder = await mkdtemp(join(tmpdir(), "orbit-invalid-migrations-"));
  await cp(sourceFolder, targetFolder, { recursive: true, force: true });
  const journalPath = join(targetFolder, "meta", "_journal.json");
  const journal = await readJournalDefinition(targetFolder);
  const failedTag = `${String(journal.entries.length).padStart(4, "0")}_invalid_test_migration`;
  await writeFile(join(targetFolder, `${failedTag}.sql`), "CREATE TABLE (\n");
  // Drizzle applies a migration only when its journal stamp is later than the
  // newest one already recorded (pg-core/dialect.js: `created_at <
  // folderMillis`). The checked-in stamps are hand-written, so a wall clock
  // that happens to sit behind the newest of them would make this appended
  // migration silently skipped and the test vacuously green. Stamping it past
  // the newest entry keeps the failure it exists to prove independent of when
  // the suite is run.
  const newestStamp = journal.entries.reduce((latest, entry) => Math.max(latest, entry.when), 0);
  journal.entries.push({
    idx: journal.entries.length,
    version: journal.version,
    when: Math.max(Date.now(), newestStamp + 1),
    tag: failedTag,
    breakpoints: true,
  });
  await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n");
  return {
    path: targetFolder,
    failedTag,
    cleanup: () => rm(targetFolder, { recursive: true, force: true }),
  };
}

/** The last migration before the window/update model (orbit#585). */
export const PRE_WINDOW_MIGRATION_TAG = "0028_instance_maintenance";

export interface PreWindowNoticeSeed {
  id: string;
  message: string;
  startsAt: string;
  expectedEndAt: string | null;
  /** Set by the #525 worker when it claimed the notice. */
  activatedAt?: string | null;
  /** Set by cancelMaintenanceNotice, which retained rather than deleted. */
  cancelledAt?: string | null;
}

export interface PreWindowMaintenanceSeed {
  active: { message: string; expectedEndAt: string | null; activatedAt: string } | null;
  notices: PreWindowNoticeSeed[];
}

/**
 * Writes the maintenance state a 0028 database actually holds, in the exact
 * shape the retired writers in src/server/maintenance.ts produced: the
 * singleton carrying one overwritable message with `message_published_at` and
 * `activated_at` set together, notices inserted with their scheduled instant,
 * `version` incremented once per mutation, and an audit row per mutation
 * against the singleton's stable id (notices against their own).
 *
 * The shape matters more than the values. A fixture that invents a row the
 * application could never have written proves nothing about the upgrade
 * (#529 in this same session), so this reproduces the writers rather than
 * describing them.
 */
export async function seedPreWindowMaintenance(
  client: PostgresClient,
  seed: PreWindowMaintenanceSeed,
): Promise<void> {
  const [singleton] = await client.unsafe(`SELECT "id" FROM "instance_maintenance" WHERE "singleton"`);
  if (!singleton) throw new Error("0028 must have seeded the maintenance singleton before this fixture runs");
  const singletonId = String(singleton.id);
  let version = 1;

  for (const notice of seed.notices) {
    version += 1;
    await client.unsafe(
      `INSERT INTO "maintenance_notices" ("id", "message", "starts_at", "expected_end_at", "activated_at", "cancelled_at")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [notice.id, notice.message, notice.startsAt, notice.expectedEndAt, notice.activatedAt ?? null, notice.cancelledAt ?? null],
    );
    await client.unsafe(
      `INSERT INTO "audit_log" ("entity_type", "entity_id", "action", "changes")
       VALUES ('instance_maintenance', $1, 'maintenance_notice_scheduled', $2)`,
      [notice.id, JSON.stringify({
        message: notice.message,
        startsAt: notice.startsAt,
        expectedEndAt: notice.expectedEndAt,
      })],
    );
  }

  if (seed.active) {
    version += 1;
    await client.unsafe(
      `UPDATE "instance_maintenance"
          SET "active" = true, "message" = $1, "message_published_at" = $2,
              "expected_end_at" = $3, "activated_at" = $2, "version" = $4, "updated_at" = $2
        WHERE "singleton"`,
      [seed.active.message, seed.active.activatedAt, seed.active.expectedEndAt, version],
    );
    await client.unsafe(
      `INSERT INTO "audit_log" ("entity_type", "entity_id", "action", "changes")
       VALUES ('instance_maintenance', $1, 'maintenance_activated', $2)`,
      [singletonId, JSON.stringify({
        active: true,
        message: seed.active.message,
        expectedEndAt: seed.active.expectedEndAt,
      })],
    );
  } else if (seed.notices.length > 0) {
    await client.unsafe(`UPDATE "instance_maintenance" SET "version" = $1 WHERE "singleton"`, [version]);
  }
}

export async function runMigrations(databaseUrl: string, migrationsFolder: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 2, prepare: false });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end({ timeout: 5 });
  }
}

export async function runMigrationsWithActionableError(databaseUrl: string, migrationsFolder: string): Promise<void> {
  try {
    await runMigrations(databaseUrl, migrationsFolder);
  } catch (error) {
    const applied = new Set(await readAppliedMigrationHashesForUrl(databaseUrl));
    const failed = (await migrationDefinitions(migrationsFolder)).find((migration) => !applied.has(migration.hash));
    const cause = error instanceof Error && "cause" in error ? error.cause : undefined;
    const detailSource = cause instanceof Error ? cause.message : error instanceof Error ? error.message : "unknown migration error";
    const detail = detailSource.split(/\r?\n/u, 1)[0].slice(0, 300);
    throw new Error(`Migration ${failed?.tag ?? "unknown"} failed: ${detail}`);
  }
}

async function readAppliedMigrationHashesForUrl(databaseUrl: string): Promise<string[]> {
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const rows = await client.unsafe(`SELECT "hash" FROM ${quoteIdentifier(MIGRATION_SCHEMA)}.${quoteIdentifier(MIGRATION_TABLE)} ORDER BY "id"`);
    return rows.map((row) => String(row.hash));
  } finally {
    await client.end({ timeout: 5 });
  }
}

export async function readAppliedMigrationHashes(client: PostgresClient): Promise<string[]> {
  const rows = await client.unsafe(`SELECT "hash" FROM ${quoteIdentifier(MIGRATION_SCHEMA)}.${quoteIdentifier(MIGRATION_TABLE)} ORDER BY "id"`);
  return rows.map((row) => String(row.hash));
}

export async function readPostgresMajor(client: PostgresClient): Promise<number> {
  const [row] = await client.unsafe("SHOW server_version");
  const match = String(row.server_version).match(/^(\d+)/u);
  if (!match) throw new Error("PostgreSQL did not report a numeric server version");
  return Number(match[1]);
}

export interface SchemaContract {
  enums: Record<string, string[]>;
  tables: Record<string, string[]>;
  constraints: Record<string, ExpectedConstraint & { referencedTable?: string; referencedColumns?: string[]; deleteAction?: string }>;
  indexes: Record<string, ExpectedIndex>;
}

export async function readSchemaContract(client: PostgresClient): Promise<SchemaContract> {
  const [enumRows, columnRows, constraintRows, indexRows] = await Promise.all([
    client.unsafe(`
      SELECT t.typname AS enum_name, e.enumlabel AS enum_label
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = 'public'
      ORDER BY t.typname, e.enumsortorder
    `),
    client.unsafe(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `),
    client.unsafe(`
      SELECT
        n.nspname AS schema_name,
        table_class.relname AS table_name,
        c.conname AS constraint_name,
        c.contype AS constraint_type,
        ARRAY_AGG(column_attribute.attname ORDER BY column_key.ordinality) AS columns,
        referenced_namespace.nspname AS referenced_schema_name,
        referenced_class.relname AS referenced_table_name,
        ARRAY_AGG(referenced_attribute.attname ORDER BY column_key.ordinality)
          FILTER (WHERE referenced_attribute.attname IS NOT NULL) AS referenced_columns,
        CASE c.confdeltype
          WHEN 'a' THEN 'no_action'
          WHEN 'r' THEN 'restrict'
          WHEN 'c' THEN 'cascade'
          WHEN 'n' THEN 'set_null'
          WHEN 'd' THEN 'set_default'
        END AS delete_action
      FROM pg_constraint c
      JOIN pg_class table_class ON table_class.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = table_class.relnamespace
      JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS column_key(attnum, ordinality) ON true
      JOIN pg_attribute column_attribute
        ON column_attribute.attrelid = c.conrelid
       AND column_attribute.attnum = column_key.attnum
      LEFT JOIN pg_class referenced_class ON referenced_class.oid = c.confrelid
      LEFT JOIN pg_namespace referenced_namespace ON referenced_namespace.oid = referenced_class.relnamespace
      LEFT JOIN LATERAL unnest(c.confkey) WITH ORDINALITY AS referenced_key(attnum, ordinality)
        ON referenced_key.ordinality = column_key.ordinality
      LEFT JOIN pg_attribute referenced_attribute
        ON referenced_attribute.attrelid = c.confrelid
       AND referenced_attribute.attnum = referenced_key.attnum
      WHERE n.nspname = 'public'
        AND c.contype IN ('p', 'u', 'f')
      GROUP BY n.nspname, table_class.relname, c.conname, c.contype,
        referenced_namespace.nspname, referenced_class.relname, c.confdeltype
      ORDER BY c.conname
    `),
    client.unsafe(`
      SELECT
        table_class.relname AS table_name,
        index_class.relname AS index_name,
        index_data.indisunique AS is_unique,
        ARRAY_AGG(attribute.attname ORDER BY index_key.ordinality) AS columns
      FROM pg_index index_data
      JOIN pg_class index_class ON index_class.oid = index_data.indexrelid
      JOIN pg_class table_class ON table_class.oid = index_data.indrelid
      JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
      JOIN LATERAL unnest(index_data.indkey) WITH ORDINALITY AS index_key(attnum, ordinality) ON true
      JOIN pg_attribute attribute
        ON attribute.attrelid = table_class.oid
       AND attribute.attnum = index_key.attnum
      WHERE table_namespace.nspname = 'public'
      GROUP BY table_class.relname, index_class.relname, index_data.indisunique
      ORDER BY index_class.relname
    `),
  ]);

  const enums: Record<string, string[]> = {};
  for (const row of enumRows) {
    const enumName = String(row.enum_name);
    (enums[enumName] ??= []).push(String(row.enum_label));
  }

  const tables: Record<string, string[]> = {};
  for (const row of columnRows) {
    const tableName = String(row.table_name);
    (tables[tableName] ??= []).push(String(row.column_name));
  }
  for (const columns of Object.values(tables)) columns.sort();

  const constraints: SchemaContract["constraints"] = {};
  for (const row of constraintRows) {
    const constraint = {
      table: String(row.table_name),
      type: String(row.constraint_type) as ExpectedConstraint["type"],
      columns: (row.columns as string[]).map(String),
    } as ExpectedConstraint & { referencedTable?: string; referencedColumns?: string[]; deleteAction?: string };
    if (constraint.type === "f") {
      constraint.referencedTable = String(row.referenced_table_name);
      constraint.referencedColumns = (row.referenced_columns as string[]).map(String);
      constraint.deleteAction = String(row.delete_action);
    }
    constraints[String(row.constraint_name)] = constraint;
  }

  const indexes: Record<string, ExpectedIndex> = {};
  for (const row of indexRows) {
    const name = String(row.index_name);
    if (name in EXPECTED_INDEXES) {
      indexes[name] = {
        table: String(row.table_name),
        columns: (row.columns as string[]).map(String),
        unique: Boolean(row.is_unique),
      };
    }
  }

  return { enums, tables, constraints, indexes };
}

const fixtureTableOrder = [
  "users",
  "user_preferences",
  "external_identities",
  "sessions",
  "households",
  "memberships",
  "sections",
  "items",
  "documents",
  "document_crypto",
  "document_jobs",
  "due_events",
  "reminder_rules",
  "push_subscriptions",
  "document_drafts",
  "notification_states",
  "notification_deliveries",
  "audit_log",
  "portable_archives",
  "imap_ingestion_messages",
  "imap_ingestion_attachments",
] as const;

const fixtureOrderColumns: Record<string, string[]> = {
  audit_log: ["id"],
  document_crypto: ["document_id"],
  document_drafts: ["id"],
  document_jobs: ["id"],
  documents: ["id"],
  due_events: ["id"],
  external_identities: ["id"],
  households: ["id"],
  imap_ingestion_attachments: ["id"],
  imap_ingestion_messages: ["id"],
  imap_notification_deliveries: ["id"],
  items: ["id"],
  memberships: ["household_id", "user_id"],
  notification_deliveries: ["id"],
  notification_states: ["user_id", "household_id", "notification_id"],
  portable_archives: ["id"],
  push_subscriptions: ["id"],
  reminder_rules: ["id"],
  sections: ["id"],
  sessions: ["id"],
  user_preferences: ["user_id"],
  users: ["id"],
};

function fixtureRows(tableName: string): FixtureRow[] {
  const rows = (baselineFixture.rows as Record<string, FixtureRow[]>)[tableName];
  if (!rows) throw new Error(`Missing migration fixture table ${tableName}`);
  return rows;
}

function fixtureColumns(tableName: string): string[] {
  const rows = fixtureRows(tableName);
  const columns = Object.keys(rows[0] ?? {});
  if (columns.length === 0) throw new Error(`Migration fixture table ${tableName} has no columns`);
  columns.forEach(quoteIdentifier);
  return columns;
}

function snapshotColumns(tableName: string): string[] {
  // The supported baseline intentionally predates the receipt identity
  // migration. Snapshot only columns present on both sides so migration data
  // comparisons remain stable while explicit migration assertions cover the
  // transformed legacy rows and newly added columns.
  if (tableName === "users") return EXPECTED_TABLE_COLUMNS.users;
  if (tableName === "imap_ingestion_messages") return fixtureColumns(tableName).filter((column) => column !== "recipient_alias_generation");
  return fixtureColumns(tableName);
}

function fixtureParameter(value: unknown): postgres.JSONValue {
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new Error("Unsupported value in synthetic migration fixture");
}

async function insertFixtureRows(client: PostgresClient, tableName: string): Promise<void> {
  const columns = fixtureColumns(tableName);
  const rows = fixtureRows(tableName);
  const parameters: postgres.JSONValue[] = [];
  const values = rows.map((row) => `(${columns.map((column) => {
    parameters.push(fixtureParameter(row[column]));
    return `$${parameters.length}`;
  }).join(", ")})`).join(", ");
  await client.unsafe(
    `INSERT INTO ${quoteIdentifier(tableName)} (${columns.map(quoteIdentifier).join(", ")}) VALUES ${values}`,
    parameters,
  );
}

export async function loadMigrationFixture(client: PostgresClient): Promise<void> {
  for (const tableName of fixtureTableOrder) await insertFixtureRows(client, tableName);
}

function normaliseFixtureValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(normaliseFixtureValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normaliseFixtureValue(nested)]));
  }
  return value;
}

export async function readFixtureSnapshot(client: PostgresClient): Promise<Record<string, FixtureRow[]>> {
  const snapshot: Record<string, FixtureRow[]> = {};
  for (const tableName of fixtureTableOrder) {
    const columns = snapshotColumns(tableName);
    const orderBy = fixtureOrderColumns[tableName].map(quoteIdentifier).join(", ");
    const rows = await client.unsafe(
      `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(tableName)} ORDER BY ${orderBy}`,
    );
    snapshot[tableName] = rows.map((row) => Object.fromEntries(columns.map((column) => [column, normaliseFixtureValue(row[column])]))) as FixtureRow[];
  }
  return snapshot;
}
