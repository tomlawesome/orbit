import { z } from "zod";

/**
 * Bounded operational logging.
 *
 * Orbit stores private household data, and `SECURITY.md` treats diagnostics that
 * leak private data as a reportable vulnerability. This module is therefore
 * deliberately narrow: callers supply a fixed event name, a fixed outcome
 * vocabulary, and a small set of scalar fields. Free-form provider text, caught
 * error messages, filenames and document content must never be passed in.
 */

export const logLevels = ["error", "warn", "info", "debug"] as const;
export type LogLevel = typeof logLevels[number];

const levelRank: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const logEnvironmentSchema = z.object({
  ORBIT_LOG_LEVEL: z.enum(logLevels).default("info"),
});

/** Scalars only. Objects and arrays cannot be rendered on one bounded line. */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

let cachedLevel: LogLevel | undefined;

export function getLogLevel(environment: NodeJS.ProcessEnv = process.env): LogLevel {
  if (environment === process.env && cachedLevel) return cachedLevel;
  const parsed = logEnvironmentSchema.safeParse(environment);
  // An unreadable level must never prevent logging; fall back to the default.
  const level = parsed.success ? parsed.data.ORBIT_LOG_LEVEL : "info";
  if (environment === process.env) cachedLevel = level;
  return level;
}

export function resetLogLevelForTests(): void {
  cachedLevel = undefined;
}

const UNSAFE_VALUE = /[\r\n\t]/gu;
const MAXIMUM_VALUE_LENGTH = 120;

/**
 * Renders one field value. Newlines and tabs are stripped so a single record
 * always occupies exactly one line and cannot forge additional records.
 */
function renderValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "-";
  if (typeof value === "boolean") return value ? "true" : "false";
  const flattened = value.replace(UNSAFE_VALUE, " ").trim();
  const bounded = flattened.length > MAXIMUM_VALUE_LENGTH
    ? `${flattened.slice(0, MAXIMUM_VALUE_LENGTH)}...`
    : flattened;
  return bounded.length === 0 ? "-" : bounded;
}

export function formatRecord(level: LogLevel, event: string, fields: LogFields = {}): string {
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${key}=${renderValue(value)}`)
    .join(" ");
  const prefix = `${new Date().toISOString()} ${level.toUpperCase()} orbit ${event}`;
  return rendered.length > 0 ? `${prefix} ${rendered}` : prefix;
}

function emit(level: LogLevel, event: string, fields: LogFields): void {
  if (levelRank[level] > levelRank[getLogLevel()]) return;
  const record = formatRecord(level, event, fields);
  if (level === "error") console.error(record);
  else if (level === "warn") console.warn(record);
  else console.log(record);
}

export const log = {
  error: (event: string, fields?: LogFields) => emit("error", event, fields ?? {}),
  warn: (event: string, fields?: LogFields) => emit("warn", event, fields ?? {}),
  info: (event: string, fields?: LogFields) => emit("info", event, fields ?? {}),
  debug: (event: string, fields?: LogFields) => emit("debug", event, fields ?? {}),
};
