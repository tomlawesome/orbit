/**
 * Whether this process holds a usable encryption key (#1405, ADR-0024
 * amendment): a startup self-test with a fail-closed readiness gate.
 *
 * The verdict is taken once, at startup, by `probeEncryptionKey()` (called by
 * `registerNode`, after migrations and before any worker), and held in the
 * process the way `bootPhase` is. Every gate reads it with no I/O:
 * `web/src/hooks.server.js` for screens, the `api()` wrapper and
 * `createSession` for everything else. A verdict not yet taken (`unknown`) is
 * treated as unusable by every gate, so a gate never fails open.
 *
 * Why startup only: the key is read once and cached (`getDocumentConfig`),
 * and the instance key row changes only under the rewrap worker, which uses
 * held keys. So the verdict holds for the process's life, and leaving the
 * locked state is a restart with the key fixed on the host.
 *
 * Nothing here ever holds key material: only key ids, which are 24-hex
 * digests of the key and safe to log. The probe zeroes the key it unwraps.
 */
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { metadataKeys } from "@/db/schema";
import { KeyUnavailableError } from "@/lib/errors";
import { log, operationalDetail } from "@/lib/logger";
import { documentKeyProblem, getDocumentConfig, keyEncryptionKeyFor } from "@/server/documents/config";
import { unwrapMetadataKey } from "@/server/metadata/crypto";

export { KeyUnavailableError };

/**
 * The five ways an instance can hold no usable key, plus a damaged key row:
 * `missing`, `unreadable`, `malformed` and `both_forms` come from the
 * settings; `mismatch` is a key that is not the one the database was written
 * under; `key_row_damaged` is the held key's own row refusing to open.
 */
export type KeyFaultReason = "missing" | "unreadable" | "malformed" | "both_forms" | "mismatch" | "key_row_damaged";

export type KeyState =
  | { verdict: "unknown" }
  | { verdict: "usable"; heldKeyId: string }
  | { verdict: "unusable"; reason: KeyFaultReason; heldKeyId?: string; storedKeyId?: string };

const UNKNOWN: KeyState = { verdict: "unknown" };

/*
 * Held on the process, not the module: there is exactly one verdict per
 * process even if a bundler or test runner loads this module twice (the
 * hazard vitest.config.ts describes for the `orbit/*` specifiers).
 */
const STATE = Symbol.for("orbit.encryption-key-state");
type Holder = { [STATE]?: KeyState };

function holder(): Holder {
  return globalThis as Holder;
}

/** The process's verdict. A memory read; never throws. */
export function getKeyState(): KeyState {
  return holder()[STATE] ?? UNKNOWN;
}

/** Test-only: set the verdict directly; `undefined` puts it back to unknown. */
export function setKeyStateForTests(state: KeyState | undefined): void {
  holder()[STATE] = state;
}

/** Throws `KeyUnavailableError` unless the verdict is usable. Unknown is unusable. */
export function assertKeyUsable(): void {
  if (getKeyState().verdict !== "usable") throw new KeyUnavailableError();
}

/** How long the probe keeps asking a database that cannot answer, and how often. */
const KEY_PROBE_WINDOW_MS = 180_000;
const KEY_PROBE_RETRY_INTERVAL_MS = 5_000;

type InstanceKeyRow = { keyId: string; wrappedDek: string; wrapIv: string; wrapAuthTag: string };

async function readInstanceKeyRow(): Promise<InstanceKeyRow | undefined> {
  const rows = await getDb()
    .select({
      keyId: metadataKeys.keyId,
      wrappedDek: metadataKeys.wrappedDek,
      wrapIv: metadataKeys.wrapIv,
      wrapAuthTag: metadataKeys.wrapAuthTag,
    })
    .from(metadataKeys)
    .where(and(eq(metadataKeys.scope, "instance"), isNull(metadataKeys.householdId)))
    .limit(1);
  return rows[0];
}

/**
 * The startup self-test (#1405 section 1). Settles the process's verdict and
 * returns it.
 *
 * 1. A fault in the key settings is unusable at once; the database is not asked.
 * 2. Otherwise the instance-scope key row decides. No row: usable (nothing has
 *    been written under any key, so any key is the right one). A row whose
 *    key id neither held key owns: `mismatch`. A row that will not unwrap
 *    under the held key of its id: `key_row_damaged`. A row that unwraps:
 *    usable. Nothing is written and the unwrapped key is zeroed.
 * 3. A database that cannot answer is neither verdict (an outage is not this
 *    mode, ADR-0013 decision 6): asked again every five seconds inside the
 *    startup window, then the probe rejects and the verdict stays unknown.
 *
 * Household-scope rows are not probed: one wrapped under an unheld key is a
 * per-household lock the field UI already handles, not "no key".
 */
export async function probeEncryptionKey(): Promise<KeyState> {
  const problem = documentKeyProblem(process.env);
  if (problem) return settle({ verdict: "unusable", reason: problem });

  const config = getDocumentConfig();
  const deadline = Date.now() + KEY_PROBE_WINDOW_MS;
  let row: InstanceKeyRow | undefined;
  for (;;) {
    try {
      row = await readInstanceKeyRow();
      break;
    } catch {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("key_probe_database_unavailable");
      await new Promise((resolve) => setTimeout(resolve, Math.min(KEY_PROBE_RETRY_INTERVAL_MS, remainingMs)));
    }
  }

  if (!row) return settle({ verdict: "usable", heldKeyId: config.keyId });
  const keyEncryptionKey = keyEncryptionKeyFor(config, row.keyId);
  if (!keyEncryptionKey) {
    return settle({ verdict: "unusable", reason: "mismatch", heldKeyId: config.keyId, storedKeyId: row.keyId });
  }
  let dataKey: Buffer;
  try {
    dataKey = unwrapMetadataKey(row, keyEncryptionKey, { scope: "instance", householdId: null, keyId: row.keyId });
  } catch {
    return settle({ verdict: "unusable", reason: "key_row_damaged", heldKeyId: config.keyId, storedKeyId: row.keyId });
  }
  dataKey.fill(0);
  return settle({ verdict: "usable", heldKeyId: config.keyId });
}

function settle(state: KeyState): KeyState {
  holder()[STATE] = state;
  return state;
}

/**
 * The one startup line that states the verdict (#1405 section 4). Key ids
 * only; the reason word names which setting is at fault, never a path.
 */
export function logKeyVerdict(state: KeyState): void {
  if (state.verdict === "usable") {
    log.info({
      event: "encryption.key",
      state: "ready",
      action: "none",
      detail: operationalDetail`holding encryption key ${state.heldKeyId}`,
    });
    return;
  }
  if (state.verdict !== "unusable") return;
  if (state.reason === "mismatch") {
    log.error({
      event: "encryption.key",
      state: "blocked",
      reason: "key_unavailable",
      action: "check_configuration",
      impact: "application_unavailable",
      detail: operationalDetail`encryption key mismatch: holding ${state.heldKeyId} but this database was written under ${state.storedKeyId}; restore that key on the host and restart`,
    });
    return;
  }
  if (state.reason === "key_row_damaged") {
    log.error({
      event: "encryption.key",
      state: "blocked",
      reason: "key_unavailable",
      action: "restore_backup",
      impact: "application_unavailable",
      detail: operationalDetail`encryption key row damaged: key ${state.storedKeyId} will not open under the held key; restore a backup and restart`,
    });
    return;
  }
  log.error({
    event: "encryption.key",
    state: "blocked",
    reason: "key_unavailable",
    action: "check_configuration",
    impact: "application_unavailable",
    detail: operationalDetail`encryption key ${state.reason}: Orbit is closed to everyone until DOCUMENT_KEK is fixed on the host and the container restarted`,
  });
}

/*
 * Refused sign-ins, in the log (#1405 section 4): each one is a line, so an
 * operator watching the log sees people being turned away, but at most ten a
 * minute per process; past that, one line at the end of the minute says how
 * many more. Other refused API calls are not logged: they are not sign-ins,
 * and would drown the fault.
 */
const REFUSAL_LINES_PER_MINUTE = 10;
const REFUSAL_WINDOW_MS = 60_000;
let refusalWindowStartedAt = Number.NEGATIVE_INFINITY;
let refusalLinesInWindow = 0;
let refusalsSuppressed = 0;
let refusalSummaryTimer: ReturnType<typeof setTimeout> | undefined;

function refusalLine(detail?: ReturnType<typeof operationalDetail>): void {
  log.warn({
    event: "encryption.key",
    state: "blocked",
    reason: "key_unavailable",
    action: "check_configuration",
    impact: "sign_in_blocked",
    ...(detail ? { detail } : {}),
  });
}

function flushRefusalSummary(): void {
  refusalSummaryTimer = undefined;
  if (refusalsSuppressed === 0) return;
  const more = refusalsSuppressed;
  refusalsSuppressed = 0;
  refusalLine(operationalDetail`${more} more sign-in attempts refused in the last minute`);
}

/** Records one sign-in refused for want of a key. */
export function noteRefusedSignIn(): void {
  const now = Date.now();
  if (now - refusalWindowStartedAt >= REFUSAL_WINDOW_MS) {
    if (refusalSummaryTimer) clearTimeout(refusalSummaryTimer);
    flushRefusalSummary();
    refusalWindowStartedAt = now;
    refusalLinesInWindow = 0;
  }
  if (refusalLinesInWindow < REFUSAL_LINES_PER_MINUTE) {
    refusalLinesInWindow += 1;
    refusalLine();
    return;
  }
  refusalsSuppressed += 1;
  if (!refusalSummaryTimer) {
    refusalSummaryTimer = setTimeout(flushRefusalSummary, refusalWindowStartedAt + REFUSAL_WINDOW_MS - now);
    refusalSummaryTimer.unref?.();
  }
}
