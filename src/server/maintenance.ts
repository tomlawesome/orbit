import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, instanceMaintenance, maintenanceUpdates, maintenanceWindows, users } from "@/db/schema";
// Direct from the framework-free module, not the re-export: this module is
// bundled into the operator CLI, which must not link Next (ADR-0015).
import { AppError, MaintenanceActiveError } from "@/lib/errors";
import { readSession } from "@/lib/auth/session";
import { getAuthConfig } from "@/lib/env";

const uuidSchema = z.uuid();

/**
 * Application-level bounds on published text (#522, ADR-0013 decision 1). The
 * 500 character bound is also a database CHECK (drizzle/0029); the line count
 * and control-character bounds are not, because they would need a
 * function-based constraint for no benefit a single writer path doesn't
 * already give them.
 */
const MESSAGE_MAX_LENGTH = 500;
const MESSAGE_MAX_LINES = 8;
// Every C0 control character and DEL except the newline itself, which the
// line-count bound already governs.
const FORBIDDEN_MESSAGE_CHARACTERS = /[\u0000-\u0009\u000B-\u001F\u007F]/u;
/** Bounds the administrator-facing listing; windows are retained forever. */
const SCHEDULED_WINDOW_READ_LIMIT = 500;

type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

export type MaintenanceWindowStatus = "scheduled" | "open" | "resolved" | "cancelled" | "absorbed";
export type MaintenanceUpdateKind = "scheduled" | "started" | "update" | "resolved";

export interface MaintenanceUpdateEntry {
  id: string;
  windowId: string;
  kind: MaintenanceUpdateKind;
  body: string;
  publishedAt: Date;
  createdAt: Date;
  editedAt: Date | null;
}

export interface MaintenanceWindowRecord {
  id: string;
  status: MaintenanceWindowStatus;
  scheduledStartAt: Date | null;
  startedAt: Date | null;
  expectedEndAt: Date | null;
  endedAt: Date | null;
  cancelledAt: Date | null;
  absorbedIntoId: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** The window's timeline, ordered `published_at ASC, id ASC`. */
  updates: MaintenanceUpdateEntry[];
}

export interface MaintenanceState {
  /** The stable id `audit_log.entity_id` points at (#522); not the row's key. */
  id: string;
  active: boolean;
  currentWindowId: string | null;
  /** Denormalised from `openWindow` so the guard read stays a single lookup. */
  expectedEndAt: Date | null;
  version: number;
  updatedAt: Date;
  /**
   * `active`, or a due scheduled window exists (ADR-0013 decision 5). The
   * clock is the trigger, not the worker tick: a scheduled window closes the
   * instance on every process the moment it falls due.
   */
  effectivelyActive: boolean;
  /** The one window that may be `open`, with its timeline. */
  openWindow: MaintenanceWindowRecord | null;
  /** Windows still `scheduled`, ordered `scheduled_start_at ASC, id ASC`. */
  scheduledWindows: MaintenanceWindowRecord[];
}

function requireUuid(value: string, label: string): string {
  if (!uuidSchema.safeParse(value).success) {
    throw new AppError("invalid_identifier", `${label} is not a valid identifier`, 422);
  }
  return value;
}

/** Trims and bounds published text; never logs or echoes the text itself. */
function requireMaintenanceBody(raw: string): string {
  const body = raw.trim();
  if (body.length < 1 || body.length > MESSAGE_MAX_LENGTH) {
    throw new AppError(
      "maintenance_message_invalid",
      `Message must be between 1 and ${MESSAGE_MAX_LENGTH} characters`,
      422,
    );
  }
  if (FORBIDDEN_MESSAGE_CHARACTERS.test(body)) {
    throw new AppError("maintenance_message_invalid", "Message must not contain control characters", 422);
  }
  if (body.split("\n").length > MESSAGE_MAX_LINES) {
    throw new AppError("maintenance_message_invalid", `Message must be at most ${MESSAGE_MAX_LINES} lines`, 422);
  }
  return body;
}

function requireVersion(expectedVersion: number): number {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new AppError("maintenance_version_invalid", "Version must be a positive integer", 422);
  }
  return expectedVersion;
}

/**
 * The later of two expected ends, where null means "no end stated".
 *
 * An unstated end is treated as the latest possible, because ADR-0013
 * decision 5 forbids `expected_end_at` shortening automatically under any
 * circumstance. Adopting a bounded end for a window that has none would
 * invent a `Retry-After` nobody promised; keeping a bounded end while
 * absorbing open-ended work would keep promising a time that is no longer
 * believed. Both are answered by "unstated wins".
 */
function laterExpectedEnd(first: Date | null, second: Date | null): Date | null {
  if (first === null || second === null) return null;
  return first.getTime() >= second.getTime() ? first : second;
}

/** Mirrors admin-repository.ts's inline actor checks: administrator, and not disabled. */
async function requireActiveAdministrator(transaction: Transaction, actorUserId: string): Promise<void> {
  const [actor] = await transaction
    .select({ administrator: users.isInstanceAdmin, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, actorUserId))
    .limit(1);
  if (!actor?.administrator || actor.disabledAt) {
    throw new AppError("administrator_required", "Orbit administrator access is required", 403);
  }
}

interface LockedSingleton {
  id: string;
  active: boolean;
  currentWindowId: string | null;
  expectedEndAt: Date | null;
  version: number;
}

/**
 * The singleton row lock every maintenance mutation takes first — including
 * the worker (ADR-0013 decision 5 as amended). Holding it before reading
 * whether a window is open is what makes "is one open?" and "claim this due
 * window as open or absorbed" a single consistent decision, so an absorbed
 * window never even momentarily contends the partial unique index.
 */
async function lockSingleton(transaction: Transaction): Promise<LockedSingleton> {
  const [row] = await transaction
    .select({
      id: instanceMaintenance.id,
      active: instanceMaintenance.active,
      currentWindowId: instanceMaintenance.currentWindowId,
      expectedEndAt: instanceMaintenance.expectedEndAt,
      version: instanceMaintenance.version,
    })
    .from(instanceMaintenance)
    .limit(1)
    .for("update");
  if (!row) {
    // The 0028 migration seeds this row unconditionally; its absence means
    // the database predates that migration or was tampered with, not a
    // caller error worth a 4xx.
    throw new AppError("maintenance_state_missing", "Maintenance state has not been initialized", 500);
  }
  return row;
}

const OPEN_WINDOW_COLUMNS = {
  id: maintenanceWindows.id,
  status: maintenanceWindows.status,
  scheduledStartAt: maintenanceWindows.scheduledStartAt,
  startedAt: maintenanceWindows.startedAt,
  expectedEndAt: maintenanceWindows.expectedEndAt,
  endedAt: maintenanceWindows.endedAt,
  cancelledAt: maintenanceWindows.cancelledAt,
  absorbedIntoId: maintenanceWindows.absorbedIntoId,
  createdAt: maintenanceWindows.createdAt,
  updatedAt: maintenanceWindows.updatedAt,
};

interface WindowRow {
  id: string;
  status: string;
  scheduledStartAt: Date | null;
  startedAt: Date | null;
  expectedEndAt: Date | null;
  endedAt: Date | null;
  cancelledAt: Date | null;
  absorbedIntoId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

async function readOpenWindow(transaction: Transaction): Promise<WindowRow | undefined> {
  const [row] = await transaction
    .select(OPEN_WINDOW_COLUMNS)
    .from(maintenanceWindows)
    .where(eq(maintenanceWindows.status, "open"))
    .limit(1);
  return row;
}

/** The window an administrator mutation is about, or a 409 if none is open. */
async function requireOpenWindow(transaction: Transaction): Promise<WindowRow> {
  const open = await readOpenWindow(transaction);
  if (!open) throw new AppError("maintenance_not_active", "Maintenance is not currently active", 409);
  return open;
}

/**
 * The compare-and-swap at the center of every mutation (ADR-0013 decision 1):
 * `version` gates the whole maintenance configuration - this singleton row,
 * every window and every update - so a zero-row update means the state moved
 * underneath the caller. The transaction that contains this call rolls back
 * on the thrown error, so a stale write never reaches the audit log.
 */
async function bumpSingleton(
  transaction: Transaction,
  expectedVersion: number,
  changes: Partial<{
    active: boolean;
    currentWindowId: string | null;
    expectedEndAt: Date | null;
  }>,
  now: Date,
): Promise<string> {
  const [updated] = await transaction.update(instanceMaintenance)
    .set({ ...changes, version: sql`${instanceMaintenance.version} + 1`, updatedAt: now })
    .where(and(eq(instanceMaintenance.singleton, true), eq(instanceMaintenance.version, expectedVersion)))
    .returning({ id: instanceMaintenance.id });
  if (!updated) {
    throw new AppError(
      "maintenance_state_stale",
      "Maintenance state changed since it was read; refresh and try again",
      409,
    );
  }
  return updated.id;
}

async function appendUpdate(
  transaction: Transaction,
  params: { windowId: string; kind: MaintenanceUpdateKind; body: string; publishedAt: Date },
): Promise<string> {
  const id = randomUUID();
  await transaction.insert(maintenanceUpdates).values({
    id,
    windowId: params.windowId,
    kind: params.kind,
    body: params.body,
    publishedAt: params.publishedAt,
  });
  return id;
}

/**
 * Window-level audit (ADR-0013 decision 1 as amended): opened, updated,
 * resolved and absorbed events carry `entity_type` `maintenance_window` and
 * the window's own id. Singleton-level events keep `instance_maintenance`
 * and the singleton's stable id.
 */
async function auditWindow(
  transaction: Transaction,
  params: { actorUserId: string | null; windowId: string; action: string; changes: Record<string, unknown> },
): Promise<void> {
  await transaction.insert(auditLog).values({
    householdId: null,
    actorUserId: params.actorUserId,
    entityType: "maintenance_window",
    entityId: params.windowId,
    action: params.action,
    changes: params.changes,
  });
}

/** Every scheduled window whose instant has passed and which nothing claimed. */
function dueScheduledWindows(now: Date) {
  return and(eq(maintenanceWindows.status, "scheduled"), lte(maintenanceWindows.scheduledStartAt, now));
}

export interface EffectiveMaintenance {
  effectivelyActive: boolean;
  /** Where Retry-After comes from: the singleton's end when active, the due window's otherwise. */
  expectedEndAt: Date | null;
}

/**
 * The per-request read the guard pays (ADR-0013 decision 2): the singleton
 * primary-key read plus the due-window probe on the partial index, and
 * nothing else. `expected_end_at` is denormalised onto the singleton for
 * exactly this reason — the open window is the source of truth, but the
 * guard never has to join to it. readMaintenanceState also loads timelines,
 * which a guard decision has no use for.
 */
export async function readEffectiveMaintenance(): Promise<EffectiveMaintenance> {
  const db = getDb();
  const [row] = await db
    .select({ active: instanceMaintenance.active, expectedEndAt: instanceMaintenance.expectedEndAt })
    .from(instanceMaintenance)
    .limit(1);
  if (!row) {
    throw new AppError("maintenance_state_missing", "Maintenance state has not been initialized", 500);
  }
  if (row.active) return { effectivelyActive: true, expectedEndAt: row.expectedEndAt };
  const [dueWindow] = await db
    .select({ expectedEndAt: maintenanceWindows.expectedEndAt })
    .from(maintenanceWindows)
    .where(dueScheduledWindows(new Date()))
    .orderBy(asc(maintenanceWindows.scheduledStartAt), asc(maintenanceWindows.id))
    .limit(1);
  if (dueWindow) return { effectivelyActive: true, expectedEndAt: dueWindow.expectedEndAt };
  return { effectivelyActive: false, expectedEndAt: null };
}

/**
 * The request guard (ADR-0013 decisions 2 and 3): a request passes if
 * maintenance is not effectively active, or if it carries a valid session
 * whose user is an active instance administrator. Uncached and per-request,
 * like the session read; the session itself is only read once maintenance is
 * active, so the quiet-path cost is the two reads above. Enforcement binds to
 * the route module that calls this — never to the URL — which is what leaves
 * prefix and normalisation tricks with no place to work.
 */
export async function assertOutsideMaintenance(request: NextRequest): Promise<void> {
  const { effectivelyActive, expectedEndAt } = await readEffectiveMaintenance();
  if (!effectivelyActive) return;
  // readSession answers null for a disabled user, so a surviving session with
  // the administrator flag is exactly "an active instance administrator".
  const session = await readSession(request, getAuthConfig());
  if (session?.user.isInstanceAdmin) return;
  throw new MaintenanceActiveError(expectedEndAt);
}

function toWindowRecord(row: WindowRow, updates: MaintenanceUpdateEntry[]): MaintenanceWindowRecord {
  return { ...row, status: row.status as MaintenanceWindowStatus, updates };
}

/** Loads timelines for the given windows in one query, in display order. */
async function readTimelines(windowIds: string[]): Promise<Map<string, MaintenanceUpdateEntry[]>> {
  const byWindow = new Map<string, MaintenanceUpdateEntry[]>();
  if (windowIds.length === 0) return byWindow;
  const rows = await getDb().select().from(maintenanceUpdates)
    .where(inArray(maintenanceUpdates.windowId, windowIds))
    .orderBy(asc(maintenanceUpdates.publishedAt), asc(maintenanceUpdates.id));
  for (const row of rows) {
    const entry: MaintenanceUpdateEntry = {
      id: row.id,
      windowId: row.windowId,
      kind: row.kind as MaintenanceUpdateKind,
      body: row.body,
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
      editedAt: row.editedAt,
    };
    const existing = byWindow.get(entry.windowId);
    if (existing) existing.push(entry);
    else byWindow.set(entry.windowId, [entry]);
  }
  return byWindow;
}

/** The effective-state read (ADR-0013 decisions 1 and 5). No actor required. */
export async function readMaintenanceState(): Promise<MaintenanceState> {
  const db = getDb();
  const [row] = await db
    .select({
      id: instanceMaintenance.id,
      active: instanceMaintenance.active,
      currentWindowId: instanceMaintenance.currentWindowId,
      expectedEndAt: instanceMaintenance.expectedEndAt,
      version: instanceMaintenance.version,
      updatedAt: instanceMaintenance.updatedAt,
    })
    .from(instanceMaintenance)
    .limit(1);
  if (!row) {
    throw new AppError("maintenance_state_missing", "Maintenance state has not been initialized", 500);
  }

  const [openRow] = await db.select(OPEN_WINDOW_COLUMNS).from(maintenanceWindows)
    .where(eq(maintenanceWindows.status, "open"))
    .limit(1);
  const scheduledRows = await db.select(OPEN_WINDOW_COLUMNS).from(maintenanceWindows)
    .where(eq(maintenanceWindows.status, "scheduled"))
    .orderBy(asc(maintenanceWindows.scheduledStartAt), asc(maintenanceWindows.id))
    .limit(SCHEDULED_WINDOW_READ_LIMIT);

  const listed: WindowRow[] = openRow ? [openRow, ...scheduledRows] : scheduledRows;
  const timelines = await readTimelines(listed.map((entry) => entry.id));
  const now = Date.now();
  const dueScheduled = scheduledRows.some((entry) => (entry.scheduledStartAt?.getTime() ?? Infinity) <= now);

  return {
    id: row.id,
    active: row.active,
    currentWindowId: row.currentWindowId,
    expectedEndAt: row.expectedEndAt,
    version: row.version,
    updatedAt: row.updatedAt,
    effectivelyActive: row.active || dueScheduled,
    openWindow: openRow ? toWindowRecord(openRow, timelines.get(openRow.id) ?? []) : null,
    scheduledWindows: scheduledRows.map((entry) => toWindowRecord(entry, timelines.get(entry.id) ?? [])),
  };
}

/**
 * Opens a maintenance window now, publishing its first entry.
 *
 * This replaces the retired `activateMaintenance`: where that overwrote the
 * one singleton message, this starts a timeline that later entries append to
 * (ADR-0013 decision 1 as amended).
 */
export async function openMaintenanceWindow(
  actorUserId: string,
  expectedVersion: number,
  params: { body: string; expectedEndAt: Date | null },
): Promise<MaintenanceState> {
  requireUuid(actorUserId, "Actor");
  requireVersion(expectedVersion);
  const body = requireMaintenanceBody(params.body);

  await getDb().transaction(async (transaction) => {
    await requireActiveAdministrator(transaction, actorUserId);
    await lockSingleton(transaction);
    if (await readOpenWindow(transaction)) {
      throw new AppError("maintenance_already_open", "A maintenance window is already open", 409);
    }
    const now = new Date();
    const windowId = randomUUID();
    await transaction.insert(maintenanceWindows).values({
      id: windowId,
      status: "open",
      startedAt: now,
      expectedEndAt: params.expectedEndAt,
      createdAt: now,
      updatedAt: now,
    });
    await appendUpdate(transaction, { windowId, kind: "started", body, publishedAt: now });
    await bumpSingleton(transaction, expectedVersion, {
      active: true,
      currentWindowId: windowId,
      expectedEndAt: params.expectedEndAt,
    }, now);
    await auditWindow(transaction, {
      actorUserId,
      windowId,
      action: "maintenance_window_opened",
      changes: { body, expectedEndAt: params.expectedEndAt?.toISOString() ?? null },
    });
  });

  return readMaintenanceState();
}

/**
 * Publishes a follow-on entry on the open window — the whole point of #585.
 * Nothing already published is touched: "we are running late, here is why"
 * accumulates after "starting now" rather than erasing it.
 */
export async function publishMaintenanceUpdate(
  actorUserId: string,
  expectedVersion: number,
  rawBody: string,
): Promise<MaintenanceState> {
  requireUuid(actorUserId, "Actor");
  requireVersion(expectedVersion);
  const body = requireMaintenanceBody(rawBody);

  await getDb().transaction(async (transaction) => {
    await requireActiveAdministrator(transaction, actorUserId);
    await lockSingleton(transaction);
    const open = await requireOpenWindow(transaction);
    const now = new Date();
    const updateId = await appendUpdate(transaction, {
      windowId: open.id, kind: "update", body, publishedAt: now,
    });
    await bumpSingleton(transaction, expectedVersion, {}, now);
    await auditWindow(transaction, {
      actorUserId,
      windowId: open.id,
      action: "maintenance_window_updated",
      changes: { updateId, kind: "update", body },
    });
  });

  return readMaintenanceState();
}

/**
 * Corrects the text of a published entry (ADR-0013 decision 8).
 *
 * The timeline is public product surface, so a typo in it should be fixable;
 * `published_at`, `kind` and `window_id` stay immutable, because re-dating an
 * entry or re-stating what kind of entry it was would falsify the narrative
 * it exists to record. The prior text goes to the audit log, which is the
 * private, append-only record — nothing is lost by the correction.
 */
export async function editMaintenanceUpdate(
  actorUserId: string,
  expectedVersion: number,
  updateId: string,
  rawBody: string,
): Promise<MaintenanceState> {
  requireUuid(actorUserId, "Actor");
  requireUuid(updateId, "Update");
  requireVersion(expectedVersion);
  const body = requireMaintenanceBody(rawBody);

  await getDb().transaction(async (transaction) => {
    await requireActiveAdministrator(transaction, actorUserId);
    await lockSingleton(transaction);
    const [existing] = await transaction
      .select({ id: maintenanceUpdates.id, windowId: maintenanceUpdates.windowId, body: maintenanceUpdates.body })
      .from(maintenanceUpdates)
      .where(eq(maintenanceUpdates.id, updateId))
      .limit(1);
    if (!existing) {
      throw new AppError("maintenance_update_not_found", "That timeline entry does not exist", 404);
    }
    const now = new Date();
    // Only `body` and `edited_at` are in the SET list, and that is the
    // decision-8 boundary expressed where it is enforced.
    await transaction.update(maintenanceUpdates)
      .set({ body, editedAt: now })
      .where(eq(maintenanceUpdates.id, updateId));
    await bumpSingleton(transaction, expectedVersion, {}, now);
    await auditWindow(transaction, {
      actorUserId,
      windowId: existing.windowId,
      action: "maintenance_window_updated",
      changes: { updateId, edited: true, previousBody: existing.body, body },
    });
  });

  return readMaintenanceState();
}

/**
 * Revises the open window's expected end (ADR-0013 decision 8): the single
 * most common action in a real window. An administrator saying so may shorten
 * it; what may never shorten it is the machinery, which is decision 5's
 * absorb rule, not this.
 */
export async function reviseMaintenanceExpectedEnd(
  actorUserId: string,
  expectedVersion: number,
  expectedEndAt: Date | null,
): Promise<MaintenanceState> {
  requireUuid(actorUserId, "Actor");
  requireVersion(expectedVersion);

  await getDb().transaction(async (transaction) => {
    await requireActiveAdministrator(transaction, actorUserId);
    await lockSingleton(transaction);
    const open = await requireOpenWindow(transaction);
    const now = new Date();
    await transaction.update(maintenanceWindows)
      .set({ expectedEndAt, updatedAt: now })
      .where(eq(maintenanceWindows.id, open.id));
    // Same transaction as the window write: the guard's denormalised copy is
    // never observably out of step with its source.
    await bumpSingleton(transaction, expectedVersion, { expectedEndAt }, now);
    await auditWindow(transaction, {
      actorUserId,
      windowId: open.id,
      action: "maintenance_window_updated",
      changes: {
        previousExpectedEndAt: open.expectedEndAt?.toISOString() ?? null,
        expectedEndAt: expectedEndAt?.toISOString() ?? null,
      },
    });
  });

  return readMaintenanceState();
}

/**
 * Ends maintenance, resolving the open window.
 *
 * "Ends" means effective maintenance (ADR-0015 decision 5), so this both
 * clears the singleton and cancels every due scheduled window in the same
 * transaction, and it succeeds when either of those is what holds the
 * instance closed. Clearing the singleton alone would not reopen anything a
 * due scheduled window was pinning, and the worker would claim that stale
 * window and re-close the instance seconds after an administrator ended it.
 *
 * A window that is not yet due survives: ending today's window is not a
 * decision about next week's. Resolved and cancelled rows are retained.
 */
export async function endMaintenance(
  actorUserId: string,
  expectedVersion: number,
  params: { body?: string | null } = {},
): Promise<MaintenanceState> {
  requireUuid(actorUserId, "Actor");
  requireVersion(expectedVersion);
  const closingBody = params.body == null || params.body.trim() === ""
    ? null
    : requireMaintenanceBody(params.body);

  await getDb().transaction(async (transaction) => {
    await requireActiveAdministrator(transaction, actorUserId);
    const singleton = await lockSingleton(transaction);
    const now = new Date();
    const open = await readOpenWindow(transaction);
    const [pinnedBySchedule] = await transaction
      .select({ id: maintenanceWindows.id })
      .from(maintenanceWindows)
      .where(dueScheduledWindows(now))
      .limit(1);
    if (!singleton.active && !open && !pinnedBySchedule) {
      throw new AppError("maintenance_not_active", "Maintenance is not currently active", 409);
    }

    // The version gate first, so a stale token cancels nothing, resolves
    // nothing and writes no audit row — the transaction never reaches the
    // statements below.
    const entityId = await bumpSingleton(transaction, expectedVersion, {
      active: false,
      currentWindowId: null,
      expectedEndAt: null,
    }, now);
    const cancelled = await transaction.update(maintenanceWindows)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(dueScheduledWindows(now))
      .returning({ id: maintenanceWindows.id });

    if (open) {
      if (closingBody) {
        await appendUpdate(transaction, {
          windowId: open.id, kind: "resolved", body: closingBody, publishedAt: now,
        });
      }
      await transaction.update(maintenanceWindows)
        .set({ status: "resolved", endedAt: now, updatedAt: now })
        .where(eq(maintenanceWindows.id, open.id));
      await auditWindow(transaction, {
        actorUserId,
        windowId: open.id,
        action: "maintenance_window_resolved",
        changes: { active: false, cancelledWindows: cancelled.length, closingBody },
      });
      return;
    }

    // Nothing was open: only due scheduled windows held the instance closed,
    // so this is a singleton-level change and keeps the singleton's entity id.
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId,
      entityType: "instance_maintenance",
      entityId,
      action: "maintenance_ended",
      changes: { active: false, cancelledWindows: cancelled.length },
    });
  });

  return readMaintenanceState();
}

/**
 * The operator-shell recovery path (ADR-0013 decision 4, #524): the way back
 * in when OIDC itself is down and no administrator can sign in.
 *
 * It takes no actor and no expected version, and that is deliberate. There is
 * no session to name an actor, and an operator reading a shell has no version
 * token to carry; the audit row records `origin: operator_shell` with a null
 * actor instead, which is what the ADR asks for. The write is still versioned
 * in the sense that matters: it increments `version` inside one transaction,
 * so every administrator token in flight goes stale rather than silently
 * overwriting this recovery.
 *
 * It also cancels every due scheduled window. Effective maintenance is
 * `active` OR such a window existing (decision 5), so clearing the singleton
 * alone would leave the instance closed and the operator still locked out —
 * the one outcome this path exists to prevent. Cancellation retains the rows.
 *
 * Idempotent: running it against an already-open instance changes nothing and
 * writes no audit row, so an operator may safely run it twice.
 */
export async function endMaintenanceFromOperatorShell(): Promise<{
  changed: boolean;
  cancelledWindows: number;
}> {
  return getDb().transaction(async (transaction) => {
    const singleton = await lockSingleton(transaction);
    const now = new Date();
    const open = await readOpenWindow(transaction);

    const cancelled = await transaction.update(maintenanceWindows)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(dueScheduledWindows(now))
      .returning({ id: maintenanceWindows.id });

    if (!singleton.active && !open && cancelled.length === 0) {
      return { changed: false, cancelledWindows: 0 };
    }

    if (open) {
      await transaction.update(maintenanceWindows)
        .set({ status: "resolved", endedAt: now, updatedAt: now })
        .where(eq(maintenanceWindows.id, open.id));
    }

    await transaction.update(instanceMaintenance)
      .set({
        active: false,
        currentWindowId: null,
        expectedEndAt: null,
        version: sql`${instanceMaintenance.version} + 1`,
        updatedAt: now,
      })
      .where(eq(instanceMaintenance.singleton, true));

    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId: null,
      entityType: "instance_maintenance",
      entityId: singleton.id,
      action: "maintenance_ended",
      changes: {
        active: false,
        origin: "operator_shell",
        cancelledWindows: cancelled.length,
        resolvedWindowId: open ? open.id : null,
      },
    });

    return { changed: true, cancelledWindows: cancelled.length };
  });
}

/**
 * Schedules a future window with its opening text.
 *
 * There is no cap. The retired 12-notice bound and its "which message wins"
 * arbitration defended a queue that no longer occurs: a due window arriving
 * during an open one is absorbed (decision 5), not queued behind it.
 */
export async function scheduleMaintenanceWindow(
  actorUserId: string,
  expectedVersion: number,
  params: { body: string; scheduledStartAt: Date; expectedEndAt: Date | null },
): Promise<MaintenanceState> {
  requireUuid(actorUserId, "Actor");
  requireVersion(expectedVersion);
  const body = requireMaintenanceBody(params.body);

  await getDb().transaction(async (transaction) => {
    await requireActiveAdministrator(transaction, actorUserId);
    await lockSingleton(transaction);
    const now = new Date();
    const windowId = randomUUID();
    await transaction.insert(maintenanceWindows).values({
      id: windowId,
      status: "scheduled",
      scheduledStartAt: params.scheduledStartAt,
      expectedEndAt: params.expectedEndAt,
      createdAt: now,
      updatedAt: now,
    });
    await appendUpdate(transaction, { windowId, kind: "scheduled", body, publishedAt: now });
    await bumpSingleton(transaction, expectedVersion, {}, now);
    await auditWindow(transaction, {
      actorUserId,
      windowId,
      action: "maintenance_window_scheduled",
      changes: {
        body,
        scheduledStartAt: params.scheduledStartAt.toISOString(),
        expectedEndAt: params.expectedEndAt?.toISOString() ?? null,
      },
    });
  });

  return readMaintenanceState();
}

/** Moves a scheduled window. Only before it opens (ADR-0013 decision 8). */
export async function rescheduleMaintenanceWindow(
  actorUserId: string,
  expectedVersion: number,
  windowId: string,
  params: { scheduledStartAt: Date; expectedEndAt: Date | null },
): Promise<MaintenanceState> {
  requireUuid(actorUserId, "Actor");
  requireUuid(windowId, "Window");
  requireVersion(expectedVersion);

  await getDb().transaction(async (transaction) => {
    await requireActiveAdministrator(transaction, actorUserId);
    await lockSingleton(transaction);
    const now = new Date();
    await bumpSingleton(transaction, expectedVersion, {}, now);
    const [moved] = await transaction.update(maintenanceWindows)
      .set({
        scheduledStartAt: params.scheduledStartAt,
        expectedEndAt: params.expectedEndAt,
        updatedAt: now,
      })
      .where(and(eq(maintenanceWindows.id, windowId), eq(maintenanceWindows.status, "scheduled")))
      .returning({ id: maintenanceWindows.id });
    if (!moved) {
      throw new AppError("maintenance_window_not_scheduled", "That window is not available to change", 404);
    }
    await auditWindow(transaction, {
      actorUserId,
      windowId,
      action: "maintenance_window_rescheduled",
      changes: {
        scheduledStartAt: params.scheduledStartAt.toISOString(),
        expectedEndAt: params.expectedEndAt?.toISOString() ?? null,
      },
    });
  });

  return readMaintenanceState();
}

/**
 * Cancels a scheduled window. Only before it opens, and the row is retained:
 * cancellation never deletes (ADR-0013 decision 8).
 */
export async function cancelMaintenanceWindow(
  actorUserId: string,
  expectedVersion: number,
  windowId: string,
): Promise<MaintenanceState> {
  requireUuid(actorUserId, "Actor");
  requireUuid(windowId, "Window");
  requireVersion(expectedVersion);

  await getDb().transaction(async (transaction) => {
    await requireActiveAdministrator(transaction, actorUserId);
    await lockSingleton(transaction);
    const now = new Date();
    await bumpSingleton(transaction, expectedVersion, {}, now);
    const [cancelled] = await transaction.update(maintenanceWindows)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(and(eq(maintenanceWindows.id, windowId), eq(maintenanceWindows.status, "scheduled")))
      .returning({ id: maintenanceWindows.id });
    if (!cancelled) {
      throw new AppError("maintenance_window_not_scheduled", "That window is not available to cancel", 404);
    }
    await auditWindow(transaction, {
      actorUserId,
      windowId,
      action: "maintenance_window_cancelled",
      changes: { cancelledAt: now.toISOString() },
    });
  });

  return readMaintenanceState();
}

export interface MaintenanceTickResult {
  /** The window this call opened, or null when it opened nothing. */
  openedWindowId: string | null;
  /** The window this call absorbed into an already-open one, or null. */
  absorbedWindowId: string | null;
}

export interface MaintenanceTickDependencies {
  /**
   * Test seam for the crash-before-commit contract: runs inside the
   * transaction, after every write and before the commit. Precedent is the
   * notification worker's `beforeProviderDispatch`.
   */
  beforeCommit?: () => Promise<void>;
  /**
   * Test seam for the exactly-once contract: runs after this transaction has
   * chosen a due window but before it tries to claim it, which is the only
   * window in which two ticks can genuinely race. Holding one tick here while
   * another completes is what proves the conditional claim — rather than the
   * select's own filter — is what excludes the duplicate.
   */
  beforeClaim?: () => Promise<void>;
}

/**
 * The durable half of scheduled activation (ADR-0013 decision 5 as amended,
 * #585).
 *
 * Effective state already treats a due scheduled window as active from the
 * scheduled instant, on every process at once — the clock is the trigger, not
 * this tick. What this adds is the durable transition behind it.
 *
 * The transaction takes the singleton row lock every administrator mutation
 * takes, reads whether a window is open, and only then claims the due window
 * *conditionally* into `open` or `absorbed`. A claim that unconditionally set
 * `status = 'open'` would contend the partial unique index; deciding the
 * target status under the same lock that made the open-window read means an
 * absorbed window never enters `open` even momentarily.
 *
 * If nothing is open, the claimed window opens. If something is open, the due
 * window is absorbed: its text is appended to the open window as an `update`
 * entry, its own row moves to `absorbed` with `absorbed_into_id` set, and the
 * open window's expected end becomes the later of the two — never the
 * earlier. An operator's stated `Retry-After` is never silently cut short by
 * a scheduled window coming due.
 *
 * Exclusion is the conditional claim alone. The house worker pattern of an
 * owner token and a lease expiry earns its complexity on long-running work;
 * here the claim and the completion are the same transaction, so a crash
 * before commit leaves nothing durable and the next tick simply retries.
 *
 * Deliberately no expected-version gate: the worker's authority is the claim.
 * A concurrent administrator mutation either serialises behind the singleton
 * row lock or finds its own token stale and re-reads.
 */
export async function activateDueMaintenanceWindow(
  dependencies: MaintenanceTickDependencies = {},
): Promise<MaintenanceTickResult> {
  const idle: MaintenanceTickResult = { openedWindowId: null, absorbedWindowId: null };
  return getDb().transaction(async (transaction) => {
    await lockSingleton(transaction);
    const open = await readOpenWindow(transaction);

    // Database time throughout, so processes with skewed clocks cannot
    // disagree about whether a window is due.
    const [due] = await transaction
      .select({ id: maintenanceWindows.id })
      .from(maintenanceWindows)
      .where(and(
        eq(maintenanceWindows.status, "scheduled"),
        lte(maintenanceWindows.scheduledStartAt, sql`now()`),
      ))
      .orderBy(asc(maintenanceWindows.scheduledStartAt), asc(maintenanceWindows.id))
      .limit(1);
    if (!due) return idle;

    await dependencies.beforeClaim?.();

    // Whether the claim targets `open` or `absorbed` is decided from the read
    // above, under the same lock. Setting `open` unconditionally and sorting
    // it out afterwards is exactly what would contend the unique index.
    const absorbedInto = open ? open.id : null;
    const [claimed] = await transaction.update(maintenanceWindows)
      .set({
        status: absorbedInto ? "absorbed" : "open",
        startedAt: absorbedInto ? null : sql`now()`,
        absorbedIntoId: absorbedInto,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(maintenanceWindows.id, due.id),
        eq(maintenanceWindows.status, "scheduled"),
        lte(maintenanceWindows.scheduledStartAt, sql`now()`),
      ))
      .returning({
        id: maintenanceWindows.id,
        scheduledStartAt: maintenanceWindows.scheduledStartAt,
        startedAt: maintenanceWindows.startedAt,
        expectedEndAt: maintenanceWindows.expectedEndAt,
      });
    // Zero rows means another process claimed it between the read and the
    // update. Stop: no singleton write, no audit row, no duplicate.
    if (!claimed) return idle;

    // Its own `scheduled` entry is retained — decision 8 makes an entry's
    // kind immutable — so the text is carried forward as a new entry, not
    // rewritten in place.
    const [source] = await transaction
      .select({ body: maintenanceUpdates.body })
      .from(maintenanceUpdates)
      .where(eq(maintenanceUpdates.windowId, claimed.id))
      .orderBy(asc(maintenanceUpdates.publishedAt), asc(maintenanceUpdates.id))
      .limit(1);
    const body = source?.body ?? "Scheduled maintenance has started.";
    const now = claimed.startedAt ?? new Date();

    if (open && absorbedInto) {
      const combinedEnd = laterExpectedEnd(open.expectedEndAt, claimed.expectedEndAt);
      await appendUpdate(transaction, {
        windowId: absorbedInto, kind: "update", body, publishedAt: new Date(),
      });
      await transaction.update(maintenanceWindows)
        .set({ expectedEndAt: combinedEnd, updatedAt: sql`now()` })
        .where(eq(maintenanceWindows.id, absorbedInto));
      const [updated] = await transaction.update(instanceMaintenance)
        .set({
          expectedEndAt: combinedEnd,
          version: sql`${instanceMaintenance.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(instanceMaintenance.singleton, true))
        .returning({ id: instanceMaintenance.id });
      if (!updated) {
        throw new AppError("maintenance_state_missing", "Maintenance state has not been initialized", 500);
      }
      await auditWindow(transaction, {
        actorUserId: null,
        windowId: absorbedInto,
        action: "maintenance_window_absorbed",
        changes: {
          absorbedWindowId: claimed.id,
          scheduledStartAt: claimed.scheduledStartAt?.toISOString() ?? null,
          previousExpectedEndAt: open.expectedEndAt?.toISOString() ?? null,
          expectedEndAt: combinedEnd?.toISOString() ?? null,
        },
      });
      await dependencies.beforeCommit?.();
      return { openedWindowId: null, absorbedWindowId: claimed.id };
    }

    await appendUpdate(transaction, { windowId: claimed.id, kind: "started", body, publishedAt: now });
    const [updated] = await transaction.update(instanceMaintenance)
      .set({
        active: true,
        currentWindowId: claimed.id,
        expectedEndAt: claimed.expectedEndAt,
        version: sql`${instanceMaintenance.version} + 1`,
        updatedAt: now,
      })
      .where(eq(instanceMaintenance.singleton, true))
      .returning({ id: instanceMaintenance.id });
    if (!updated) {
      throw new AppError("maintenance_state_missing", "Maintenance state has not been initialized", 500);
    }

    await auditWindow(transaction, {
      actorUserId: null,
      windowId: claimed.id,
      action: "maintenance_activated_scheduled",
      changes: {
        active: true,
        body,
        scheduledStartAt: claimed.scheduledStartAt?.toISOString() ?? null,
        expectedEndAt: claimed.expectedEndAt?.toISOString() ?? null,
      },
    });

    await dependencies.beforeCommit?.();

    return { openedWindowId: claimed.id, absorbedWindowId: null };
  });
}
