import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, instanceMaintenance, maintenanceNotices, users } from "@/db/schema";
// Direct from the framework-free module, not the re-export: this module is
// bundled into the operator CLI, which must not link Next (ADR-0015).
import { AppError, MaintenanceActiveError } from "@/lib/errors";
import { readSession } from "@/lib/auth/session";
import { getAuthConfig } from "@/lib/env";

const uuidSchema = z.uuid();

/**
 * Application-level message bounds (#522, ADR-0013 decision 1). The 500
 * character bound is also a database CHECK (drizzle/0028); the line count and
 * control-character bounds are not, because they would need a function-based
 * constraint for no benefit a single writer path doesn't already give them.
 */
const MESSAGE_MAX_LENGTH = 500;
const MESSAGE_MAX_LINES = 8;
const MAX_PENDING_NOTICES = 12;
// Every C0 control character and DEL except the newline itself, which the
// line-count bound already governs.
const FORBIDDEN_MESSAGE_CHARACTERS = /[\u0000-\u0009\u000B-\u001F\u007F]/u;

type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

export interface MaintenanceNotice {
  id: string;
  message: string;
  startsAt: Date;
  expectedEndAt: Date | null;
  activatedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
}

export interface MaintenanceState {
  /** The stable id `audit_log.entity_id` points at (#522); not the row's key. */
  id: string;
  active: boolean;
  message: string | null;
  messagePublishedAt: Date | null;
  expectedEndAt: Date | null;
  activatedAt: Date | null;
  version: number;
  updatedAt: Date;
  /**
   * `active`, or a due, unclaimed, uncancelled notice exists (ADR-0013
   * decision 5). This slice computes it on every read; the scheduled-worker
   * tick that also copies a due notice into the singleton is #525.
   */
  effectivelyActive: boolean;
  /** All notices, retained rows and all, ordered `starts_at ASC, id ASC`. */
  notices: MaintenanceNotice[];
}

function requireUuid(value: string, label: string): string {
  if (!uuidSchema.safeParse(value).success) {
    throw new AppError("invalid_identifier", `${label} is not a valid identifier`, 422);
  }
  return value;
}

/** Trims and bounds a maintenance message; never logs or echoes the text itself. */
function requireMaintenanceMessage(raw: string): string {
  const message = raw.trim();
  if (message.length < 1 || message.length > MESSAGE_MAX_LENGTH) {
    throw new AppError(
      "maintenance_message_invalid",
      `Message must be between 1 and ${MESSAGE_MAX_LENGTH} characters`,
      422,
    );
  }
  if (FORBIDDEN_MESSAGE_CHARACTERS.test(message)) {
    throw new AppError("maintenance_message_invalid", "Message must not contain control characters", 422);
  }
  if (message.split("\n").length > MESSAGE_MAX_LINES) {
    throw new AppError("maintenance_message_invalid", `Message must be at most ${MESSAGE_MAX_LINES} lines`, 422);
  }
  return message;
}

function requireVersion(expectedVersion: number): number {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new AppError("maintenance_version_invalid", "Version must be a positive integer", 422);
  }
  return expectedVersion;
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

/**
 * The compare-and-swap at the center of every mutation (ADR-0013 decision 1):
 * `version` gates the whole maintenance configuration - this singleton row
 * and every notice - so a zero-row update means the state moved underneath
 * the caller. The transaction that contains this call rolls back on the
 * thrown error, so a stale write never reaches the audit log.
 */
async function updateSingletonVersion(
  transaction: Transaction,
  expectedVersion: number,
  changes: Partial<{
    active: boolean;
    message: string | null;
    messagePublishedAt: Date | null;
    expectedEndAt: Date | null;
    activatedAt: Date | null;
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

export interface EffectiveMaintenance {
  effectivelyActive: boolean;
  /** Where Retry-After comes from: the singleton's end when active, the due notice's otherwise. */
  expectedEndAt: Date | null;
}

/**
 * The per-request read the guard pays (ADR-0013 decision 2): the singleton
 * primary-key read plus the due-notice probe on the partial index, and
 * nothing else. readMaintenanceState also lists every notice, which a guard
 * decision has no use for.
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
  const [dueNotice] = await db
    .select({ expectedEndAt: maintenanceNotices.expectedEndAt })
    .from(maintenanceNotices)
    .where(and(
      isNull(maintenanceNotices.activatedAt),
      isNull(maintenanceNotices.cancelledAt),
      lte(maintenanceNotices.startsAt, new Date()),
    ))
    .orderBy(asc(maintenanceNotices.startsAt), asc(maintenanceNotices.id))
    .limit(1);
  if (dueNotice) return { effectivelyActive: true, expectedEndAt: dueNotice.expectedEndAt };
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

/** The effective-state read (ADR-0013 decisions 1 and 5). No actor required. */
export async function readMaintenanceState(): Promise<MaintenanceState> {
  const db = getDb();
  const [row] = await db.select().from(instanceMaintenance).limit(1);
  if (!row) {
    // The 0028 migration seeds this row unconditionally; its absence means
    // the database predates that migration or was tampered with, not a
    // caller error worth a 4xx.
    throw new AppError("maintenance_state_missing", "Maintenance state has not been initialized", 500);
  }
  const notices = await db.select().from(maintenanceNotices)
    .orderBy(asc(maintenanceNotices.startsAt), asc(maintenanceNotices.id))
    .limit(500);
  const [dueNotice] = await db.select({ id: maintenanceNotices.id }).from(maintenanceNotices)
    .where(and(
      isNull(maintenanceNotices.activatedAt),
      isNull(maintenanceNotices.cancelledAt),
      lte(maintenanceNotices.startsAt, new Date()),
    ))
    .limit(1);
  return {
    id: row.id,
    active: row.active,
    message: row.message,
    messagePublishedAt: row.messagePublishedAt,
    expectedEndAt: row.expectedEndAt,
    activatedAt: row.activatedAt,
    version: row.version,
    updatedAt: row.updatedAt,
    effectivelyActive: row.active || Boolean(dueNotice),
    notices,
  };
}

/** Activates maintenance immediately with a published message. */
export async function activateMaintenance(
  actorUserId: string,
  expectedVersion: number,
  params: { message: string; expectedEndAt: Date | null },
): Promise<MaintenanceState> {
  requireUuid(actorUserId, "Actor");
  requireVersion(expectedVersion);
  const message = requireMaintenanceMessage(params.message);

  await getDb().transaction(async (transaction) => {
    await requireActiveAdministrator(transaction, actorUserId);
    const now = new Date();
    const entityId = await updateSingletonVersion(transaction, expectedVersion, {
      active: true,
      message,
      messagePublishedAt: now,
      expectedEndAt: params.expectedEndAt,
      activatedAt: now,
    }, now);
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId,
      entityType: "instance_maintenance",
      entityId,
      action: "maintenance_activated",
      changes: { active: true, message, expectedEndAt: params.expectedEndAt?.toISOString() ?? null },
    });
  });

  return readMaintenanceState();
}

/** Replaces the published message of currently active maintenance. */
export async function editMaintenanceMessage(
  actorUserId: string,
  expectedVersion: number,
  rawMessage: string,
): Promise<MaintenanceState> {
  requireUuid(actorUserId, "Actor");
  requireVersion(expectedVersion);
  const message = requireMaintenanceMessage(rawMessage);

  await getDb().transaction(async (transaction) => {
    await requireActiveAdministrator(transaction, actorUserId);
    const [current] = await transaction.select({ active: instanceMaintenance.active }).from(instanceMaintenance).limit(1);
    if (!current?.active) {
      throw new AppError("maintenance_not_active", "Maintenance is not currently active", 409);
    }
    const now = new Date();
    const entityId = await updateSingletonVersion(transaction, expectedVersion, {
      message,
      messagePublishedAt: now,
    }, now);
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId,
      entityType: "instance_maintenance",
      entityId,
      action: "maintenance_message_edited",
      changes: { message },
    });
  });

  return readMaintenanceState();
}

/**
 * Ends maintenance, clearing the published message.
 *
 * "Ends" means effective maintenance (ADR-0015 decision 5), so this both
 * clears the singleton and cancels every due, unclaimed notice in the same
 * transaction, and it succeeds when either of those is what holds the
 * instance closed. Clearing the singleton alone would not reopen anything a
 * due notice was pinning, and once #525's worker exists it would claim that
 * stale notice and re-activate maintenance seconds after an administrator
 * ended it.
 *
 * A notice that is not yet due survives: ending today's window is not a
 * decision about next week's.
 */
export async function endMaintenance(actorUserId: string, expectedVersion: number): Promise<MaintenanceState> {
  requireUuid(actorUserId, "Actor");
  requireVersion(expectedVersion);

  await getDb().transaction(async (transaction) => {
    await requireActiveAdministrator(transaction, actorUserId);
    const now = new Date();
    const dueNotices = and(
      isNull(maintenanceNotices.activatedAt),
      isNull(maintenanceNotices.cancelledAt),
      lte(maintenanceNotices.startsAt, now),
    );

    const [current] = await transaction.select({ active: instanceMaintenance.active }).from(instanceMaintenance).limit(1);
    const [pinnedByNotice] = await transaction
      .select({ id: maintenanceNotices.id })
      .from(maintenanceNotices)
      .where(dueNotices)
      .limit(1);
    if (!current?.active && !pinnedByNotice) {
      throw new AppError("maintenance_not_active", "Maintenance is not currently active", 409);
    }

    // The version gate first, so a stale token cancels nothing and writes no
    // audit row — the transaction never reaches the statements below.
    const entityId = await updateSingletonVersion(transaction, expectedVersion, {
      active: false,
      message: null,
      messagePublishedAt: null,
      expectedEndAt: null,
      activatedAt: null,
    }, now);
    const cancelled = await transaction.update(maintenanceNotices)
      .set({ cancelledAt: now })
      .where(dueNotices)
      .returning({ id: maintenanceNotices.id });

    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId,
      entityType: "instance_maintenance",
      entityId,
      action: "maintenance_ended",
      changes: { active: false, cancelledNotices: cancelled.length },
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
 * It also cancels every due, unclaimed notice. Effective maintenance is
 * `active` OR such a notice existing (decision 5), so clearing the singleton
 * alone would leave the instance closed and the operator still locked out —
 * the one outcome this path exists to prevent. Cancellation retains the rows.
 *
 * Idempotent: running it against an already-open instance changes nothing and
 * writes no audit row, so an operator may safely run it twice.
 */
export async function endMaintenanceFromOperatorShell(): Promise<{
  changed: boolean;
  cancelledNotices: number;
}> {
  return getDb().transaction(async (transaction) => {
    const now = new Date();
    const [current] = await transaction
      .select({ id: instanceMaintenance.id, active: instanceMaintenance.active })
      .from(instanceMaintenance)
      .limit(1);
    if (!current) {
      throw new AppError("maintenance_state_missing", "Maintenance state has not been initialized", 500);
    }

    const cancelled = await transaction.update(maintenanceNotices)
      .set({ cancelledAt: now })
      .where(and(
        isNull(maintenanceNotices.activatedAt),
        isNull(maintenanceNotices.cancelledAt),
        lte(maintenanceNotices.startsAt, now),
      ))
      .returning({ id: maintenanceNotices.id });

    if (!current.active && cancelled.length === 0) {
      return { changed: false, cancelledNotices: 0 };
    }

    await transaction.update(instanceMaintenance)
      .set({
        active: false,
        message: null,
        messagePublishedAt: null,
        expectedEndAt: null,
        activatedAt: null,
        version: sql`${instanceMaintenance.version} + 1`,
        updatedAt: now,
      })
      .where(eq(instanceMaintenance.singleton, true));

    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId: null,
      entityType: "instance_maintenance",
      entityId: current.id,
      action: "maintenance_ended",
      changes: { active: false, origin: "operator_shell", cancelledNotices: cancelled.length },
    });

    return { changed: true, cancelledNotices: cancelled.length };
  });
}

/** Schedules a future notice. Bounded to 12 pending notices (#522). */
export async function scheduleMaintenanceNotice(
  actorUserId: string,
  expectedVersion: number,
  params: { message: string; startsAt: Date; expectedEndAt: Date | null },
): Promise<MaintenanceState> {
  requireUuid(actorUserId, "Actor");
  requireVersion(expectedVersion);
  const message = requireMaintenanceMessage(params.message);

  await getDb().transaction(async (transaction) => {
    await requireActiveAdministrator(transaction, actorUserId);
    const now = new Date();
    // The version gate above locks the singleton row, so this count is
    // consistent with every other concurrent mutation: a second scheduling
    // transaction blocks on that row lock and re-reads a version that no
    // longer matches, and is rejected before it ever counts notices.
    await updateSingletonVersion(transaction, expectedVersion, {}, now);
    const [{ pending }] = await transaction
      .select({ pending: sql<number>`count(*)::int` })
      .from(maintenanceNotices)
      .where(and(isNull(maintenanceNotices.activatedAt), isNull(maintenanceNotices.cancelledAt)));
    if (pending >= MAX_PENDING_NOTICES) {
      throw new AppError(
        "maintenance_notice_limit_reached",
        "Cancel an existing notice before scheduling another",
        409,
      );
    }
    const noticeId = randomUUID();
    await transaction.insert(maintenanceNotices).values({
      id: noticeId,
      message,
      startsAt: params.startsAt,
      expectedEndAt: params.expectedEndAt,
    });
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId,
      entityType: "instance_maintenance",
      entityId: noticeId,
      action: "maintenance_notice_scheduled",
      changes: {
        message,
        startsAt: params.startsAt.toISOString(),
        expectedEndAt: params.expectedEndAt?.toISOString() ?? null,
      },
    });
  });

  return readMaintenanceState();
}

/** Cancels a pending notice. Rows are retained; cancellation never deletes. */
export async function cancelMaintenanceNotice(
  actorUserId: string,
  expectedVersion: number,
  noticeId: string,
): Promise<MaintenanceState> {
  requireUuid(actorUserId, "Actor");
  requireUuid(noticeId, "Notice");
  requireVersion(expectedVersion);

  await getDb().transaction(async (transaction) => {
    await requireActiveAdministrator(transaction, actorUserId);
    const now = new Date();
    await updateSingletonVersion(transaction, expectedVersion, {}, now);
    const [cancelled] = await transaction.update(maintenanceNotices)
      .set({ cancelledAt: now })
      .where(and(
        eq(maintenanceNotices.id, noticeId),
        isNull(maintenanceNotices.activatedAt),
        isNull(maintenanceNotices.cancelledAt),
      ))
      .returning({ id: maintenanceNotices.id });
    if (!cancelled) {
      throw new AppError("maintenance_notice_not_pending", "That notice is not available to cancel", 404);
    }
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId,
      entityType: "instance_maintenance",
      entityId: noticeId,
      action: "maintenance_notice_cancelled",
      changes: { cancelledAt: now.toISOString() },
    });
  });

  return readMaintenanceState();
}

export interface MaintenanceTickResult {
  /** The notice this call claimed, or null when there was nothing due to claim. */
  activatedNoticeId: string | null;
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
   * chosen a due notice but before it tries to claim it, which is the only
   * window in which two ticks can genuinely race. Holding one tick here while
   * another completes is what proves the conditional claim — rather than the
   * select's own filter — is what excludes the duplicate.
   */
  beforeClaim?: () => Promise<void>;
}

/**
 * The durable half of scheduled activation (ADR-0013 decision 5, #525).
 *
 * Effective state already treats a due, unclaimed notice as active from the
 * scheduled instant, on every process at once — the clock is the trigger, not
 * this tick. What this adds is the durable transition behind it: claim the
 * notice, copy it into the singleton, and audit it exactly once.
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
export async function activateDueMaintenanceNotice(
  dependencies: MaintenanceTickDependencies = {},
): Promise<MaintenanceTickResult> {
  return getDb().transaction(async (transaction) => {
    // Database time throughout, so processes with skewed clocks cannot
    // disagree about whether a notice is due.
    const [due] = await transaction
      .select({ id: maintenanceNotices.id })
      .from(maintenanceNotices)
      .where(and(
        isNull(maintenanceNotices.activatedAt),
        isNull(maintenanceNotices.cancelledAt),
        lte(maintenanceNotices.startsAt, sql`now()`),
      ))
      .orderBy(asc(maintenanceNotices.startsAt), asc(maintenanceNotices.id))
      .limit(1);
    if (!due) return { activatedNoticeId: null };

    await dependencies.beforeClaim?.();

    const [claimed] = await transaction.update(maintenanceNotices)
      .set({ activatedAt: sql`now()` })
      .where(and(
        eq(maintenanceNotices.id, due.id),
        isNull(maintenanceNotices.activatedAt),
        isNull(maintenanceNotices.cancelledAt),
        lte(maintenanceNotices.startsAt, sql`now()`),
      ))
      .returning({
        id: maintenanceNotices.id,
        message: maintenanceNotices.message,
        startsAt: maintenanceNotices.startsAt,
        expectedEndAt: maintenanceNotices.expectedEndAt,
        activatedAt: maintenanceNotices.activatedAt,
      });
    // Zero rows means another process claimed it between the read and the
    // update. Stop: no singleton write, no audit row, no duplicate.
    if (!claimed) return { activatedNoticeId: null };

    const now = claimed.activatedAt ?? new Date();
    const [updated] = await transaction.update(instanceMaintenance)
      .set({
        active: true,
        message: claimed.message,
        messagePublishedAt: now,
        expectedEndAt: claimed.expectedEndAt,
        activatedAt: now,
        version: sql`${instanceMaintenance.version} + 1`,
        updatedAt: now,
      })
      .where(eq(instanceMaintenance.singleton, true))
      .returning({ id: instanceMaintenance.id });
    if (!updated) {
      throw new AppError("maintenance_state_missing", "Maintenance state has not been initialized", 500);
    }

    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId: null,
      entityType: "instance_maintenance",
      entityId: claimed.id,
      action: "maintenance_activated_scheduled",
      changes: {
        active: true,
        message: claimed.message,
        startsAt: claimed.startsAt.toISOString(),
        expectedEndAt: claimed.expectedEndAt?.toISOString() ?? null,
      },
    });

    await dependencies.beforeCommit?.();

    return { activatedNoticeId: claimed.id };
  });
}
