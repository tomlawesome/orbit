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
  /* Startup refusals that a restart cannot fix (#437). Named separately from
     the generic migration_integrity so an operator - and repair.sh - can tell
     "this database belongs to a different build" from "this database is older
     than we support", which have different remedies. */
  "database_mismatch",
  "database_below_floor",
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
  /* Neither of these is "restart": both sides of the disagreement survive a
     restart, so restarting loops forever (#437). */
  "attach_matching_database",
  "upgrade_from_supported_version",
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
  /* The fixture harness, refused in a production build (#773). */
  "fixtures",
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
  "document.preview": "document",
  "document.parse": "parser",
  "imap.ingestion": "ingestion",
  "imap.receipt": "mail",
  "delivery.smtp": "delivery",
  "delivery.push": "delivery",
  "backup.operation": "backup",
  "recovery.operation": "recovery",
  "maintenance.worker": "maintenance",
  "configuration.problem": "configuration",
} as const;
export type OperationalEventName = keyof typeof operationalEvents;
export type OperationalComponent = typeof operationalEvents[OperationalEventName];

declare const operationalDetailBrand: unique symbol;

/**
 * The one pass-through field the closed schema allows (#718): a short,
 * bounded description of what happened, for cases the enums cannot express
 * ("applied 17 of 18 does not match 0018_x").
 *
 * It is a branded string with exactly one constructor, the `operationalDetail`
 * tagged template below, so a plain string never typechecks as a detail. The
 * words therefore always come from a source literal - a reviewable act -
 * while interpolated values are restricted to numbers and bounded tokens.
 * That is what keeps the log free of SQL, credentials and provider text
 * without relying on every future caller remembering the rule.
 */
export type OperationalDetail = string & { readonly [operationalDetailBrand]: true };

/** Migration tags, setting names, counts: identifiers, never values. */
const detailTokenPattern = /^[0-9A-Za-z_.-]{1,64}$/u;
const detailMaxLength = 256;
const detailRedaction = "[unavailable]";

/** One line, printable characters only: a log record is not a place a caller
 *  gets to forge extra records from, so control and formatting characters go. */
function boundedDetailText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, detailMaxLength);
}

function renderDetailValue(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : detailRedaction;
  if (typeof value === "string" && detailTokenPattern.test(value)) return value;
  return detailRedaction;
}

/**
 * The only way to build an `OperationalDetail`:
 * `` operationalDetail`applied ${applied} of ${expected} from ${tag}` ``.
 * Anything interpolated that is not a finite number or a bounded token is
 * rendered `[unavailable]` rather than dropped, so the operator can see that
 * something was withheld instead of reading a sentence with a hole in it.
 */
export function operationalDetail(literals: TemplateStringsArray, ...values: unknown[]): OperationalDetail {
  const text = literals.reduce(
    (accumulator, literal, index) => accumulator + literal + (index < values.length ? renderDetailValue(values[index]) : ""),
    "",
  );
  return boundedDetailText(text) as OperationalDetail;
}

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
  detail?: OperationalDetail;
};

/* The runtime half of the closed schema. Written as a full record of the
   event type so that adding a field to `OperationalEvent` without deciding
   what happens to it here is a compilation error, not a silent drop (#718). */
const operationalEventKeys: Record<keyof Required<OperationalEvent>, true> = {
  event: true,
  state: true,
  reason: true,
  action: true,
  impact: true,
  durationMs: true,
  setting: true,
  problemCode: true,
  fallback: true,
  detail: true,
};
const knownEventKeys = new Set<string>(Object.keys(operationalEventKeys));

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
  detail: string | null;
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

/**
 * A field that is not in the schema used to be dropped between the call site
 * and the output, so a green test could sit on top of a log line that never
 * carried it (#718). Outside production that is now a crash: the type system
 * already refuses it, so reaching here means something bypassed the types and
 * the next person deserves to find out at their desk rather than in an
 * incident. Production keeps serving - `normalizeEvent` rebuilds the record
 * from the allowlist below, so the unknown key is stripped either way.
 */
function rejectUnknownKeys(event: OperationalEvent): void {
  const unknown = Object.keys(event).filter((key) => !knownEventKeys.has(key));
  if (unknown.length === 0 || process.env.NODE_ENV === "production") return;
  throw new Error(`operational log event carries fields outside its schema: ${boundedDetailText(unknown.join(", "))}`);
}

function normalizeEvent(event: OperationalEvent): OperationalEvent {
  rejectUnknownKeys(event);
  const safeEvent = event.event in operationalEvents ? event.event : "application.error";
  const safeState = operationalStates.includes(event.state) ? event.state : "degraded";
  const safeReason = event.reason && operationalReasons.includes(event.reason) ? event.reason : undefined;
  const safeAction = event.action && operationalActions.includes(event.action) ? event.action : undefined;
  const safeImpact = event.impact && operationalImpacts.includes(event.impact) ? event.impact : undefined;
  const safeSetting = event.setting && configurationSettings.includes(event.setting) ? event.setting : undefined;
  const safeProblemCode = event.problemCode && configurationProblemCodes.includes(event.problemCode) ? event.problemCode : undefined;
  const safeFallback = event.fallback && configurationFallbacks.includes(event.fallback) ? event.fallback : undefined;
  /* Re-bounded here as well as in the tagged template: the brand is a
     compile-time guarantee, and a record must stay one printable line even
     when a caller has cast its way past the types. */
  const detailText = typeof event.detail === "string" ? boundedDetailText(event.detail) : "";
  const safeDetail = detailText.length > 0 ? (detailText as OperationalDetail) : undefined;
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
    ...(safeDetail ? { detail: safeDetail } : {}),
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
    detail: normalized.detail ?? null,
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
    /* Last, and the only quoted column: it is the one field that may contain
       spaces, so quoting keeps the stable columns ahead of it parseable. */
    `detail=${record.detail === null ? "-" : JSON.stringify(record.detail)}`,
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

/**
 * An object literal's excess-property check does not survive a spread, so
 * `{ ...verdict, detail: x }` used to compile and then lose `detail` at
 * runtime (#718). Requiring every key outside the schema to be `never` closes
 * that: the extra key is part of the inferred type however it got there, and
 * nothing is assignable to `never`.
 */
type ExactOperationalEvent<T extends OperationalEvent> = T & Record<Exclude<keyof T, keyof OperationalEvent>, never>;

export const log = {
  error: <T extends OperationalEvent>(event: ExactOperationalEvent<T>) => emit("error", event),
  warn: <T extends OperationalEvent>(event: ExactOperationalEvent<T>) => emit("warn", event),
  info: <T extends OperationalEvent>(event: ExactOperationalEvent<T>) => emit("info", event),
  debug: <T extends OperationalEvent>(event: ExactOperationalEvent<T>) => emit("debug", event),
};
