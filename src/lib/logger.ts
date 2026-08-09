import { z } from "zod";

/**
 * Orbit's ordinary operational log is deliberately a small protocol.  The
 * same record is rendered as operator-friendly text or machine-readable JSON;
 * callers cannot add arbitrary fields, private values, or provider text.
 */
export const logLevels = ["error", "warn", "info", "debug"] as const;
export type LogLevel = typeof logLevels[number];

export const logFormats = ["text", "json"] as const;
export type LogFormat = typeof logFormats[number];

export const operationalStates = [
  "starting",
  "ready",
  "degraded",
  "retrying",
  "recovered",
  "exhausted",
  "stopping",
  "disabled",
  "invalid",
  "blocked",
  "completed",
] as const;
export type OperationalState = typeof operationalStates[number];

export const operationalReasons = [
  "configuration_invalid",
  "configuration_optional",
  "configuration_version",
  "dependency_unavailable",
  "dependency_timeout",
  "migration_failed",
  "migration_integrity",
  "provider_unavailable",
  "provider_rejected",
  "provider_invalid_response",
  "unreachable",
  "invalid_response",
  "rejected",
  "unexpected_content_type",
  "oversized_response",
  "undecodable_response",
  "discovery_failed",
  "token_exchange_failed",
  "invalid_request",
  "invalid_state",
  "account_disabled",
  "provider_error",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "scan_mode_disabled",
  "scanner_unavailable",
  "scanner_timeout",
  "scanner_protocol",
  "scanner_failed",
  "malware_detected",
  "supported_structure",
  "prohibited_content",
  "unsupported_structure",
  "infected",
  "parser_disabled",
  "parser_output_invalid",
  "processing_interrupted",
  "crypto_metadata_missing",
  "storage_object_invalid",
  "storage_object_missing",
  "key_unavailable",
  "purge_failed",
  "stage_purge_failed",
  "scan_recovery_expired",
  "staging_object_invalid",
  "smtp_unconfigured",
  "smtp_unavailable",
  "smtp_rejected",
  "push_unconfigured",
  "push_unsubscribed",
  "push_unavailable",
  "recipient_preferences_disabled",
  "household_pending_deletion",
  "worker_cycle_failed",
  "unexpected_failure",
  "server_notice",
  "signal_received",
  "shutdown_requested",
  "retry_scheduled",
  "retry_exhausted",
  "not_configured",
  "disabled",
  "invalid_event",
] as const;
export type OperationalReason = typeof operationalReasons[number];

export const operationalActions = [
  "none",
  "check_configuration",
  "repair_configuration",
  "check_database",
  "check_migrations",
  "check_scanner",
  "check_parser",
  "check_provider",
  "retry",
  "retry_job",
  "discard_job",
  "inspect_admin_diagnostics",
  "restore_backup",
  "run_recovery",
  "contact_operator",
] as const;
export type OperationalAction = typeof operationalActions[number];

export const operationalImpacts = [
  "none",
  "sign_in_blocked",
  "application_unavailable",
  "application_degraded",
  "database_unavailable",
  "migration_blocked",
  "document_upload_blocked",
  "document_processing_blocked",
  "notification_delivery_delayed",
  "mail_receipt_delayed",
  "mail_delivery_delayed",
  "backup_unavailable",
  "recovery_blocked",
  "worker_degraded",
] as const;
export type OperationalImpact = typeof operationalImpacts[number];

export const configurationSettings = [
  "ORBIT_CONFIG_SCHEMA_VERSION",
  "authentication",
  "database",
  "documents",
  "logging",
  "mail",
  "imap",
  "push",
  "processing",
  "ai",
] as const;
export type ConfigurationSetting = typeof configurationSettings[number];

export const configurationProblemCodes = ["configuration_version", "configuration_core", "configuration_optional"] as const;
export type ConfigurationProblemCode = typeof configurationProblemCodes[number];

export const configurationFallbacks = ["startup_blocked", "feature_disabled"] as const;
export type ConfigurationFallback = typeof configurationFallbacks[number];

export const operationalEvents = {
  "application.startup": "application",
  "application.error": "application",
  "shutdown.signal": "shutdown",
  "startup.configuration": "configuration",
  "startup.migration": "migrations",
  "database.connection": "database",
  "database.notice": "database",
  "database.migration": "migrations",
  "auth.configuration": "authentication",
  "auth.provider": "authentication",
  "notification.worker": "notification",
  "document.worker": "document",
  "document.job": "document",
  "document.lifecycle": "document",
  "document.scanner": "scanner",
  "document.scan": "scanner",
  "document.inspection": "document",
  "document.parse": "parser",
  "imap.ingestion": "ingestion",
  "imap.receipt": "mail",
  "delivery.smtp": "delivery",
  "delivery.push": "delivery",
  "backup.operation": "backup",
  "recovery.operation": "recovery",
  "configuration.problem": "configuration",
} as const;
export type OperationalEventName = keyof typeof operationalEvents;
export type OperationalComponent = typeof operationalEvents[OperationalEventName];

export type OperationalEvent = {
  event: OperationalEventName;
  state: OperationalState;
  reason?: OperationalReason;
  action?: OperationalAction;
  impact?: OperationalImpact;
  durationMs?: number;
  setting?: ConfigurationSetting;
  problemCode?: ConfigurationProblemCode;
  fallback?: ConfigurationFallback;
};

export type OperationalRecord = {
  timestamp: string;
  level: LogLevel;
  component: OperationalComponent;
  event: OperationalEventName;
  state: OperationalState;
  reason: OperationalReason | null;
  action: OperationalAction | null;
  impact: OperationalImpact | null;
  duration_ms: number | null;
  setting: ConfigurationSetting | null;
  problem_code: ConfigurationProblemCode | null;
  fallback: ConfigurationFallback | null;
};

const levelRank: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
let cachedLevel: LogLevel | undefined;
let cachedFormat: LogFormat | undefined;
const LOG_DEDUP_COOLDOWN_MS = 60_000;
let loggerClock = (): number => Date.now();
const repeatableFailureStates = new Set<OperationalState>(["degraded", "retrying", "exhausted", "blocked", "invalid"]);
const lastTransitions = new Map<string, { inputState: string; emittedAt: number }>();

export function getLogLevel(environment: NodeJS.ProcessEnv = process.env): LogLevel {
  if (environment === process.env && cachedLevel) return cachedLevel;
  const parsed = z.enum(logLevels).safeParse(environment.ORBIT_LOG_LEVEL);
  const level = parsed.success ? parsed.data : "info";
  if (environment === process.env) cachedLevel = level;
  return level;
}

export function getLogFormat(environment: NodeJS.ProcessEnv = process.env): LogFormat {
  if (environment === process.env && cachedFormat) return cachedFormat;
  const parsed = z.enum(logFormats).safeParse(environment.ORBIT_LOG_FORMAT);
  const format = parsed.success ? parsed.data : "text";
  if (environment === process.env) cachedFormat = format;
  return format;
}

export function resetLogLevelForTests(): void {
  cachedLevel = undefined;
  cachedFormat = undefined;
  lastTransitions.clear();
}

export function resetLoggerForTests(): void {
  resetLogLevelForTests();
  loggerClock = () => Date.now();
}

export function setLoggerClockForTests(clock: (() => number) | undefined): void {
  loggerClock = clock ?? (() => Date.now());
}

function boundedDuration(durationMs: number | undefined): number | null {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return null;
  return Math.min(Math.floor(durationMs), 86_400_000);
}

function normalizeEvent(event: OperationalEvent): OperationalEvent {
  const safeEvent = event.event in operationalEvents ? event.event : "application.error";
  const safeState = operationalStates.includes(event.state) ? event.state : "degraded";
  const safeReason = event.reason && operationalReasons.includes(event.reason) ? event.reason : undefined;
  const safeAction = event.action && operationalActions.includes(event.action) ? event.action : undefined;
  const safeImpact = event.impact && operationalImpacts.includes(event.impact) ? event.impact : undefined;
  const safeSetting = event.setting && configurationSettings.includes(event.setting) ? event.setting : undefined;
  const safeProblemCode = event.problemCode && configurationProblemCodes.includes(event.problemCode) ? event.problemCode : undefined;
  const safeFallback = event.fallback && configurationFallbacks.includes(event.fallback) ? event.fallback : undefined;
  return {
    event: safeEvent,
    state: safeState,
    ...(safeReason ? { reason: safeReason } : {}),
    ...(safeAction ? { action: safeAction } : {}),
    ...(safeImpact ? { impact: safeImpact } : {}),
    durationMs: boundedDuration(event.durationMs) ?? undefined,
    ...(safeSetting ? { setting: safeSetting } : {}),
    ...(safeProblemCode ? { problemCode: safeProblemCode } : {}),
    ...(safeFallback ? { fallback: safeFallback } : {}),
  };
}

function createRecord(level: LogLevel, event: OperationalEvent, timestamp = new Date().toISOString()): OperationalRecord {
  const normalized = normalizeEvent(event);
  return {
    timestamp,
    level,
    component: operationalEvents[normalized.event],
    event: normalized.event,
    state: normalized.state,
    reason: normalized.reason ?? null,
    action: normalized.action ?? null,
    impact: normalized.impact ?? null,
    duration_ms: normalized.durationMs ?? null,
    setting: normalized.setting ?? null,
    problem_code: normalized.problemCode ?? null,
    fallback: normalized.fallback ?? null,
  };
}

function renderText(record: OperationalRecord, color = shouldUseColor()): string {
  const level = record.level.toUpperCase();
  const levelText = color ? `\u001b[${record.level === "error" ? 31 : record.level === "warn" ? 33 : 36}m${level}\u001b[0m` : level;
  return [
    record.timestamp,
    levelText,
    "orbit",
    record.component,
    record.event,
    `state=${record.state}`,
    `reason=${record.reason ?? "-"}`,
    `action=${record.action ?? "-"}`,
    `impact=${record.impact ?? "-"}`,
    `duration_ms=${record.duration_ms ?? "-"}`,
    `setting=${record.setting ?? "-"}`,
    `problem_code=${record.problem_code ?? "-"}`,
    `fallback=${record.fallback ?? "-"}`,
  ].join(" ");
}

export function shouldUseColor(environment: NodeJS.ProcessEnv = process.env, stream: NodeJS.WriteStream = process.stdout): boolean {
  return environment.NO_COLOR === undefined && stream.isTTY === true;
}

export function formatRecord(level: LogLevel, event: OperationalEvent, timestamp?: string): string {
  const record = createRecord(level, event, timestamp);
  return getLogFormat() === "json" ? JSON.stringify(record) : renderText(record);
}

export function formatJsonRecord(level: LogLevel, event: OperationalEvent, timestamp?: string): string {
  return JSON.stringify(createRecord(level, event, timestamp));
}

function transitionSource(record: OperationalRecord): string {
  return [record.component, record.event, record.setting, record.problem_code, record.fallback].join("|");
}

function transitionState(record: OperationalRecord): string {
  return [record.state, record.reason, record.action, record.impact].join("|");
}

function recoveryRecord(record: OperationalRecord, previous: { inputState: string } | undefined): OperationalRecord {
  if (record.state !== "ready" || previous === undefined) return record;
  const previousState = previous.inputState.split("|", 1)[0] as OperationalState;
  if (!repeatableFailureStates.has(previousState)) return record;
  return { ...record, state: "recovered" };
}

function emit(level: LogLevel, event: OperationalEvent): void {
  if (levelRank[level] > levelRank[getLogLevel()]) return;
  const inputRecord = createRecord(level, event);
  const source = transitionSource(inputRecord);
  const previous = lastTransitions.get(source);
  const record = recoveryRecord(inputRecord, previous);
  const inputState = transitionState(inputRecord);
  const now = loggerClock();
  if (previous?.inputState === inputState) {
    if (!repeatableFailureStates.has(inputRecord.state)) return;
    if (now >= previous.emittedAt && now - previous.emittedAt < LOG_DEDUP_COOLDOWN_MS) return;
  }
  lastTransitions.set(source, { inputState, emittedAt: now });
  const outputStream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  const rendered = getLogFormat() === "json"
    ? JSON.stringify(record)
    : renderText(record, shouldUseColor(process.env, outputStream));
  if (level === "error") console.error(rendered);
  else if (level === "warn") console.warn(rendered);
  else console.log(rendered);
}

export const log = {
  error: (event: OperationalEvent) => emit("error", event),
  warn: (event: OperationalEvent) => emit("warn", event),
  info: (event: OperationalEvent) => emit("info", event),
  debug: (event: OperationalEvent) => emit("debug", event),
};
