import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, householdJoinRequests, households, memberships, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { isInstanceAdministrator } from "@/server/authorization";

/**
 * Join requests (§11, #453): a no-household user's signal to a household's
 * owners. The label is the entire surface a non-member ever sees — nothing
 * here returns items, sections, members or activity to a requester. Creation
 * is idempotent (one pending request per household+user, enforced by a
 * partial unique index); decisions keep the row as an audit trail and write
 * the audit log with ids only.
 */

export interface JoinDecisionContext {
  status: "pending" | "approved" | "declined";
  actorIsOwner: boolean;
  actorIsAdministrator: boolean;
  requesterDisabled: boolean;
}

/** The authority matrix, pure: owners of that household and instance admins
 * decide; nobody else, never twice, and never onto a disabled account. */
export function planJoinDecision(context: JoinDecisionContext, action: "approve" | "decline") {
  if (context.status !== "pending") {
    throw new AppError("request_closed", "That request has already been decided", 409);
  }
  if (!context.actorIsOwner && !context.actorIsAdministrator) {
    throw new AppError("owner_required", "Only that household's owner can decide a join request", 403);
  }
  if (action === "approve" && context.requesterDisabled) {
    throw new AppError("account_disabled", "That Orbit account is disabled", 409);
  }
  return {
    nextStatus: action === "approve" ? ("approved" as const) : ("declined" as const),
    grantsMembership: action === "approve",
  };
}

export interface JoinRequestSummary {
  id: string;
  householdId: string;
  status: "pending" | "approved" | "declined";
}

export async function createJoinRequest(userId: string, householdId: string): Promise<JoinRequestSummary> {
  return getDb().transaction(async (transaction) => {
    const [household] = await transaction
      .select({ id: households.id, deletionRequestedAt: households.deletionRequestedAt })
      .from(households)
      .where(eq(households.id, householdId))
      .limit(1);
    if (!household || household.deletionRequestedAt) {
      throw new AppError("household_not_found", "That household is not available", 404);
    }
    const [membership] = await transaction
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.householdId, householdId), eq(memberships.userId, userId)))
      .limit(1);
    if (membership) {
      throw new AppError("already_member", "You are already in that household", 409);
    }
    const [inserted] = await transaction
      .insert(householdJoinRequests)
      .values({ householdId, userId })
      .onConflictDoNothing()
      .returning({ id: householdJoinRequests.id, householdId: householdJoinRequests.householdId, status: householdJoinRequests.status });
    if (inserted) {
      await transaction.insert(auditLog).values({
        householdId,
        actorUserId: userId,
        entityType: "membership",
        entityId: userId,
        action: "join_requested",
        changes: {},
      });
      return inserted;
    }
    /* Idempotent repeat: the pending request already exists — hand it back. */
    const [existing] = await transaction
      .select({ id: householdJoinRequests.id, householdId: householdJoinRequests.householdId, status: householdJoinRequests.status })
      .from(householdJoinRequests)
      .where(and(
        eq(householdJoinRequests.householdId, householdId),
        eq(householdJoinRequests.userId, userId),
        eq(householdJoinRequests.status, "pending"),
      ))
      .limit(1);
    if (!existing) throw new AppError("unexpected_failure", "The join request could not be recorded", 500);
    return existing;
  });
}

export interface PendingJoinRequest {
  id: string;
  householdId: string;
  householdName: string;
  userId: string;
  displayName: string;
  createdAt: Date;
}

/** Pending requests the actor may decide: their owned households, or every
 * household for an instance admin. Requester display name only — deciding
 * needs to know WHO is asking, and nothing more. */
export async function listJoinRequests(actorUserId: string): Promise<PendingJoinRequest[]> {
  const administrator = await isInstanceAdministrator(actorUserId);
  const base = getDb()
    .select({
      id: householdJoinRequests.id,
      householdId: householdJoinRequests.householdId,
      householdName: households.name,
      userId: householdJoinRequests.userId,
      displayName: users.displayName,
      createdAt: householdJoinRequests.createdAt,
    })
    .from(householdJoinRequests)
    .innerJoin(households, eq(households.id, householdJoinRequests.householdId))
    .innerJoin(users, eq(users.id, householdJoinRequests.userId));
  if (administrator) {
    return base
      .where(eq(householdJoinRequests.status, "pending"))
      .orderBy(asc(householdJoinRequests.createdAt));
  }
  return base
    .innerJoin(memberships, and(
      eq(memberships.householdId, householdJoinRequests.householdId),
      eq(memberships.userId, actorUserId),
      eq(memberships.role, "owner"),
    ))
    .where(eq(householdJoinRequests.status, "pending"))
    .orderBy(asc(householdJoinRequests.createdAt));
}

export async function decideJoinRequest(
  actorUserId: string,
  requestId: string,
  action: "approve" | "decline",
): Promise<JoinRequestSummary> {
  return getDb().transaction(async (transaction) => {
    const [request] = await transaction
      .select({
        id: householdJoinRequests.id,
        householdId: householdJoinRequests.householdId,
        userId: householdJoinRequests.userId,
        status: householdJoinRequests.status,
      })
      .from(householdJoinRequests)
      .where(eq(householdJoinRequests.id, requestId))
      .limit(1);
    if (!request) throw new AppError("request_not_found", "That join request is not available", 404);

    const [actor] = await transaction
      .select({ role: memberships.role, administrator: users.isInstanceAdmin, disabledAt: users.disabledAt })
      .from(users)
      .leftJoin(memberships, and(
        eq(memberships.userId, users.id),
        eq(memberships.householdId, request.householdId),
      ))
      .where(eq(users.id, actorUserId))
      .limit(1);
    if (!actor || actor.disabledAt) {
      throw new AppError("request_not_found", "That join request is not available", 404);
    }
    const [requester] = await transaction
      .select({ disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, request.userId))
      .limit(1);

    const plan = planJoinDecision({
      status: request.status,
      actorIsOwner: actor.role === "owner",
      actorIsAdministrator: Boolean(actor.administrator),
      requesterDisabled: Boolean(requester?.disabledAt) || !requester,
    }, action);

    const [decided] = await transaction
      .update(householdJoinRequests)
      .set({ status: plan.nextStatus, decidedAt: new Date(), decidedByUserId: actorUserId })
      .where(and(eq(householdJoinRequests.id, requestId), eq(householdJoinRequests.status, "pending")))
      .returning({ id: householdJoinRequests.id, householdId: householdJoinRequests.householdId, status: householdJoinRequests.status });
    if (!decided) throw new AppError("request_closed", "That request has already been decided", 409);

    if (plan.grantsMembership) {
      await transaction
        .insert(memberships)
        .values({ householdId: request.householdId, userId: request.userId, role: "member" })
        .onConflictDoNothing();
    }
    await transaction.insert(auditLog).values({
      householdId: request.householdId,
      actorUserId,
      entityType: "membership",
      entityId: request.userId,
      action: plan.grantsMembership ? "join_approved" : "join_declined",
      changes: {},
    });
    return decided;
  });
}

/** The choose-branch's label-only sky (§11): every live household's id and
 * name — THE ENTIRE non-member surface — with the caller's pending flags. */
export async function listVisibleHouseholds(userId: string) {
  const [rows, pending] = await Promise.all([
    getDb()
      .select({ id: households.id, name: households.name, deletionRequestedAt: households.deletionRequestedAt })
      .from(households)
      .orderBy(asc(households.createdAt)),
    getDb()
      .select({ householdId: householdJoinRequests.householdId })
      .from(householdJoinRequests)
      .where(and(eq(householdJoinRequests.userId, userId), eq(householdJoinRequests.status, "pending"))),
  ]);
  const requested = new Set(pending.map((row) => row.householdId));
  return rows
    .filter((row) => !row.deletionRequestedAt)
    .map((row) => ({ id: row.id, name: row.name, requested: requested.has(row.id) }));
}
