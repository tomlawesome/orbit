import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  auditLog,
  dueEvents,
  households,
  items,
  memberships,
  notificationStates,
  reminderRules,
  sections,
  sessions,
  users,
} from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { defaultSections } from "@/lib/domain";
import {
  itemActivitySchema,
  workspaceSchema,
  type ItemActivity,
  type WorkspaceCommand,
  type WorkspaceState,
} from "@/lib/workspace";
import { isInstanceAdministrator } from "@/server/authorization";
import { planOwnershipTransfer } from "@/server/household-ownership";

const uuidSchema = z.uuid();

function validUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

function requireUuid(value: string, field: string): string {
  if (!validUuid(value)) throw new AppError("invalid_identifier", `${field} is not a valid identifier`, 422);
  return value;
}

function sectionSlug(name: string, id: string): string {
  const normalized = name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-");
  return `${normalized || "section"}-${id.slice(0, 8)}`;
}

async function membershipRole(userId: string, householdId: string): Promise<"owner" | "member"> {
  const [membership] = await getDb()
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.householdId, householdId)))
    .limit(1);
  if (!membership) throw new AppError("household_not_found", "That household is not available", 404);
  return membership.role;
}

async function requireHouseholdAccess(userId: string, householdId: string, ownerOnly = false): Promise<void> {
  requireUuid(householdId, "Household");
  const [lifecycle] = await getDb().select({ deletionRequestedAt: households.deletionRequestedAt })
    .from(households).where(eq(households.id, householdId)).limit(1);
  if (!lifecycle) throw new AppError("household_not_found", "That household is not available", 404);
  if (lifecycle.deletionRequestedAt) throw new AppError("household_pending_deletion", "This household is scheduled for deletion and cannot be changed", 409);
  if (await isInstanceAdministrator(userId)) return;
  const role = await membershipRole(userId, householdId);
  if (ownerOnly && role !== "owner") {
    throw new AppError("owner_required", "Only a household owner can make this change", 403);
  }
}

async function createInitialHousehold(userId: string, sessionId: string): Promise<string> {
  const householdId = randomUUID();
  await getDb().transaction(async (transaction) => {
    await transaction.insert(households).values({
      id: householdId,
      name: "My home",
      timezone: "Europe/London",
      defaultCurrency: "GBP",
      setupCompleted: false,
    });
    await transaction.insert(memberships).values({ householdId, userId, role: "owner" });
    await transaction.insert(sections).values(defaultSections.map((section, position) => ({
      id: randomUUID(),
      householdId,
      slug: section.id,
      name: section.name,
      icon: section.icon,
      accent: section.accent,
      position,
      visible: section.visible,
    })));
    await transaction.update(sessions).set({ activeHouseholdId: householdId }).where(eq(sessions.id, sessionId));
  });
  return householdId;
}

/**
 * Reconstructs the normalized database rows into the UI's versioned workspace
 * contract. The browser therefore stays independent from database structure.
 */
export async function readWorkspace(userId: string, sessionId: string, preferredHouseholdId?: string | null): Promise<WorkspaceState> {
  const administrator = await isInstanceAdministrator(userId);
  const householdSelection = {
    id: households.id,
    name: households.name,
    timezone: households.timezone,
    currency: households.defaultCurrency,
    onboardingComplete: households.setupCompleted,
    deletionRequestedAt: households.deletionRequestedAt,
    deleteAfter: households.deleteAfter,
  };
  const householdRows = administrator
    ? await getDb().select(householdSelection).from(households).orderBy(asc(households.createdAt))
    : await getDb().select(householdSelection)
      .from(memberships)
      .innerJoin(households, eq(households.id, memberships.householdId))
      .where(eq(memberships.userId, userId))
      .orderBy(asc(households.createdAt));

  if (!householdRows.length) {
    const initialId = await createInitialHousehold(userId, sessionId);
    return readWorkspace(userId, sessionId, initialId);
  }

  const householdIds = householdRows.map((household) => household.id);
  const activeHouseholdId = preferredHouseholdId && householdIds.includes(preferredHouseholdId)
    ? preferredHouseholdId
    : householdIds[0];

  const [sectionRows, itemRows, eventRows, reminderRows, activityRows, memberRows, stateRows] = await Promise.all([
    getDb().select().from(sections)
      .where(and(inArray(sections.householdId, householdIds), isNull(sections.archivedAt)))
      .orderBy(asc(sections.position)),
    getDb().select().from(items).where(and(inArray(items.householdId, householdIds), eq(items.requiresReview, false))).orderBy(desc(items.updatedAt)),
    getDb().select().from(dueEvents)
      .where(and(inArray(dueEvents.householdId, householdIds), isNull(dueEvents.completedAt)))
      .orderBy(asc(dueEvents.dueDate)),
    getDb().select().from(reminderRules),
    getDb().select().from(auditLog)
      .where(inArray(auditLog.householdId, householdIds))
      .orderBy(desc(auditLog.createdAt))
      .limit(5_000),
    getDb().select({ householdId: memberships.householdId, userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(inArray(memberships.householdId, householdIds)),
    getDb().select().from(notificationStates)
      .where(and(eq(notificationStates.userId, userId), inArray(notificationStates.householdId, householdIds))),
  ]);

  const eventByItem = new Map<string, (typeof eventRows)[number]>();
  for (const event of eventRows) {
    if (!eventByItem.has(event.itemId)) eventByItem.set(event.itemId, event);
  }
  const remindersByItem = new Map<string, number[]>();
  for (const reminder of reminderRows) {
    const current = remindersByItem.get(reminder.itemId) ?? [];
    current.push(reminder.daysBefore);
    remindersByItem.set(reminder.itemId, current);
  }

  const activitiesByHousehold = new Map<string, ItemActivity[]>();
  for (const entry of activityRows) {
    // Instance-wide audit records have no household and never appear here.
    if (!entry.householdId) continue;
    const candidate = itemActivitySchema.safeParse((entry.changes as { activity?: unknown })?.activity);
    if (!candidate.success) continue;
    const current = activitiesByHousehold.get(entry.householdId) ?? [];
    current.push(candidate.data);
    activitiesByHousehold.set(entry.householdId, current);
  }

  return workspaceSchema.parse({
    version: 1,
    activeHouseholdId,
    households: householdRows.map((household) => {
      const householdItems = itemRows.filter((item) => item.householdId === household.id).map((item) => {
        const event = eventByItem.get(item.id);
        const scheduleKind = event?.kind
          ?? (item.serviceDate ? "service" : item.renewalDate ? "renewal" : undefined);
        const dueDate = event?.dueDate ?? item.serviceDate ?? item.renewalDate ?? undefined;
        return {
          id: item.id,
          sectionId: item.sectionId,
          title: item.title,
          subtype: item.subtype ?? undefined,
          provider: item.provider ?? undefined,
          reference: item.reference ?? undefined,
          costMinor: item.costMinor ?? undefined,
          currency: item.currency,
          dueDate,
          scheduleKind,
          recurrenceMonths: item.recurrenceMonths ?? undefined,
          reminderDays: remindersByItem.get(item.id)?.sort((left, right) => right - left),
          snoozedUntil: item.snoozedUntil ?? undefined,
          notes: item.notes ?? undefined,
          status: item.status,
          version: item.version,
          updatedAt: item.updatedAt.toISOString(),
        };
      });
      const householdStates = stateRows.filter((state) => state.householdId === household.id);
      return {
        id: household.id,
        name: household.name,
        timezone: household.timezone,
        currency: household.currency,
        memberCount: memberRows.filter((member) => member.householdId === household.id).length,
        canManage: administrator || memberRows.some((member) => (
          member.householdId === household.id
          && member.userId === userId
          && member.role === "owner"
        )),
        onboardingComplete: household.onboardingComplete,
        deletionRequestedAt: household.deletionRequestedAt?.toISOString(),
        deleteAfter: household.deleteAfter?.toISOString(),
        sections: sectionRows.filter((section) => section.householdId === household.id).map((section) => ({
          id: section.id,
          name: section.name,
          icon: section.icon,
          accent: section.accent,
          visible: section.visible,
        })),
        items: householdItems,
        activities: activitiesByHousehold.get(household.id) ?? [],
        readNotificationIds: householdStates.filter((state) => state.readAt).map((state) => state.notificationId),
        dismissedNotificationIds: householdStates.filter((state) => state.dismissedAt).map((state) => state.notificationId),
      };
    }),
  });
}

function itemDates(scheduleKind: "renewal" | "service" | undefined, dueDate: string | undefined) {
  return {
    renewalDate: scheduleKind === "renewal" ? dueDate ?? null : null,
    serviceDate: scheduleKind === "service" ? dueDate ?? null : null,
  };
}

/** Applies one validated, authorized command atomically, then returns canonical state. */
export async function applyWorkspaceCommand(
  userId: string,
  sessionId: string,
  command: WorkspaceCommand,
): Promise<WorkspaceState> {
  if (command.type === "household.create") {
    const householdId = requireUuid(command.household.id, "Household");
    await getDb().transaction(async (transaction) => {
      await transaction.insert(households).values({
        id: householdId,
        name: command.household.name,
        timezone: command.household.timezone,
        defaultCurrency: command.household.currency,
        setupCompleted: command.household.onboardingComplete,
      });
      await transaction.insert(memberships).values({ householdId, userId, role: "owner" });
      await transaction.insert(sections).values(command.household.sections.map((section, position) => {
        const sectionId = validUuid(section.id) ? section.id : randomUUID();
        return {
          id: sectionId,
          householdId,
          slug: sectionSlug(section.name, sectionId),
          name: section.name,
          icon: section.icon,
          accent: section.accent,
          position,
          visible: section.visible,
        };
      }));
      await transaction.update(sessions).set({ activeHouseholdId: householdId }).where(eq(sessions.id, sessionId));
    });
    return readWorkspace(userId, sessionId, householdId);
  }

  await requireHouseholdAccess(
    userId,
    command.householdId,
    command.type === "sections.replace"
      || command.type === "household.setup"
      || command.type === "household.update",
  );
  const householdId = command.householdId;

  await getDb().transaction(async (transaction) => {
    const recordActivity = async (itemId: string, activity: ItemActivity) => {
      const entityId = requireUuid(itemId, "Item");
      await transaction.insert(auditLog).values({
        id: validUuid(activity.id) ? activity.id : randomUUID(),
        householdId,
        actorUserId: userId,
        entityType: "item",
        entityId,
        action: activity.kind,
        changes: { activity },
        createdAt: new Date(activity.occurredAt),
      }).onConflictDoNothing();
    };

    if (command.type === "household.activate") {
      await transaction.update(sessions).set({ activeHouseholdId: householdId }).where(eq(sessions.id, sessionId));
      return;
    }

    if (command.type === "household.setup") {
      await transaction.update(households).set({
        name: command.name,
        timezone: command.timezone,
        defaultCurrency: command.currency,
        setupCompleted: true,
        updatedAt: new Date(),
      }).where(eq(households.id, householdId));

      const retainedSectionIds: string[] = [];
      for (const [position, section] of command.sections.entries()) {
        const sectionId = validUuid(section.id) ? section.id : randomUUID();
        retainedSectionIds.push(sectionId);
        const values = {
          slug: sectionSlug(section.name, sectionId),
          name: section.name,
          icon: section.icon,
          accent: section.accent,
          position,
          visible: section.visible,
          updatedAt: new Date(),
        };
        const [existing] = await transaction.select({ id: sections.id }).from(sections)
          .where(and(eq(sections.id, sectionId), eq(sections.householdId, householdId))).limit(1);
        if (existing) {
          await transaction.update(sections).set(values).where(eq(sections.id, sectionId));
        } else {
          await transaction.insert(sections).values({ id: sectionId, householdId, ...values });
        }
      }
      await transaction.delete(sections).where(and(
        eq(sections.householdId, householdId),
        notInArray(sections.id, retainedSectionIds),
      ));
      return;
    }

    if (command.type === "household.update") {
      await transaction.update(households).set({
        name: command.name,
        timezone: command.timezone,
        defaultCurrency: command.currency,
        updatedAt: new Date(),
      }).where(eq(households.id, householdId));
      return;
    }

    if (command.type === "sections.replace") {
      const existing = await transaction.select({ id: sections.id }).from(sections).where(eq(sections.householdId, householdId));
      const existingIds = new Set(existing.map((section) => section.id));
      const retainedSectionIds: string[] = [];
      for (const [position, section] of command.sections.entries()) {
        if (existingIds.has(section.id)) {
          retainedSectionIds.push(section.id);
          await transaction.update(sections).set({
            name: section.name,
            icon: section.icon,
            accent: section.accent,
            position,
            visible: section.visible,
            updatedAt: new Date(),
          }).where(and(eq(sections.id, section.id), eq(sections.householdId, householdId)));
        } else {
          const sectionId = validUuid(section.id) ? section.id : randomUUID();
          retainedSectionIds.push(sectionId);
          await transaction.insert(sections).values({
            id: sectionId,
            householdId,
            slug: sectionSlug(section.name, sectionId),
            name: section.name,
            icon: section.icon,
            accent: section.accent,
            position,
            visible: section.visible,
          });
        }
      }
      const fallbackSectionId = retainedSectionIds[0];
      await transaction.update(items)
        .set({ sectionId: fallbackSectionId })
        .where(and(
          eq(items.householdId, householdId),
          notInArray(items.sectionId, retainedSectionIds),
        ));
      await transaction.delete(sections).where(and(
        eq(sections.householdId, householdId),
        notInArray(sections.id, retainedSectionIds),
      ));
      return;
    }

    if (command.type === "item.upsert") {
      const itemId = requireUuid(command.item.id, "Item");
      const sectionId = requireUuid(command.item.sectionId, "Section");
      const [ownedSection] = await transaction.select({ id: sections.id }).from(sections)
        .where(and(eq(sections.id, sectionId), eq(sections.householdId, householdId))).limit(1);
      if (!ownedSection) throw new AppError("section_not_found", "Choose a section from this household", 422);
      const [existing] = await transaction.select({ version: items.version }).from(items)
        .where(and(eq(items.id, itemId), eq(items.householdId, householdId))).limit(1);
      const values = {
        sectionId,
        title: command.item.title,
        subtype: command.item.subtype ?? null,
        provider: command.item.provider ?? null,
        reference: command.item.reference ?? null,
        costMinor: command.item.costMinor ?? null,
        currency: command.item.currency,
        recurrenceMonths: command.item.recurrenceMonths ?? null,
        snoozedUntil: command.item.snoozedUntil ?? null,
        notes: command.item.notes ?? null,
        status: command.item.status,
        updatedAt: new Date(),
        ...itemDates(command.item.scheduleKind, command.item.dueDate),
      };
      if (existing) {
        const expectedVersion = Math.max(1, (command.item.version ?? existing.version + 1) - 1);
        const [updated] = await transaction.update(items)
          .set({ ...values, version: sql`${items.version} + 1` })
          .where(and(
            eq(items.id, itemId),
            eq(items.householdId, householdId),
            eq(items.version, expectedVersion),
          ))
          .returning({ id: items.id });
        if (!updated) throw new AppError("version_conflict", "This item changed on another device; refresh and try again", 409);
      } else {
        await transaction.insert(items).values({ id: itemId, householdId, version: 1, ...values });
      }
      await transaction.delete(dueEvents).where(and(eq(dueEvents.itemId, itemId), isNull(dueEvents.completedAt)));
      if (command.item.dueDate && command.item.scheduleKind) {
        await transaction.insert(dueEvents).values({
          householdId,
          itemId,
          kind: command.item.scheduleKind,
          dueDate: command.item.dueDate,
        });
      }
      await transaction.delete(reminderRules).where(eq(reminderRules.itemId, itemId));
      if (command.item.reminderDays?.length) {
        await transaction.insert(reminderRules).values(command.item.reminderDays.map((daysBefore) => ({
          itemId,
          daysBefore,
        })));
      }
      if (command.activity) await recordActivity(itemId, command.activity);
      return;
    }

    if (
      command.type === "notification.read"
      || command.type === "notification.dismiss"
      || command.type === "notification.read-all"
    ) {
      const notificationIds = command.type === "notification.read-all"
        ? command.notificationIds
        : [command.notificationId];
      for (const notificationId of notificationIds) {
        const changes = command.type === "notification.dismiss"
          ? { dismissedAt: new Date(), updatedAt: new Date() }
          : { readAt: new Date(), updatedAt: new Date() };
        await transaction.insert(notificationStates).values({
          userId,
          householdId,
          notificationId,
          ...changes,
        }).onConflictDoUpdate({
          target: [notificationStates.userId, notificationStates.householdId, notificationStates.notificationId],
          set: changes,
        });
      }
      return;
    }

    const itemId = requireUuid(command.itemId, "Item");
    const [current] = await transaction.select().from(items)
      .where(and(eq(items.id, itemId), eq(items.householdId, householdId))).limit(1);
    if (!current) throw new AppError("item_not_found", "That item is not available", 404);

    if (command.type === "item.archive") {
      await transaction.update(items).set({ status: "archived", version: sql`${items.version} + 1`, updatedAt: new Date() })
        .where(eq(items.id, itemId));
      await recordActivity(itemId, command.activity);
      return;
    }

    if (command.type === "item.complete") {
      const [currentEvent] = await transaction.select().from(dueEvents)
        .where(and(eq(dueEvents.itemId, itemId), isNull(dueEvents.completedAt))).orderBy(asc(dueEvents.dueDate)).limit(1);
      let nextEventId: string | undefined;
      if (command.nextDate && currentEvent) {
        nextEventId = randomUUID();
        await transaction.insert(dueEvents).values({
          id: nextEventId,
          householdId,
          itemId,
          kind: currentEvent.kind,
          dueDate: command.nextDate,
        });
      }
      if (currentEvent) {
        await transaction.update(dueEvents).set({
          completedAt: new Date(command.activity.occurredAt),
          completedByUserId: userId,
          completionKey: command.activity.id,
          nextEventId,
        }).where(eq(dueEvents.id, currentEvent.id));
      }
      const kind = currentEvent?.kind ?? (current.serviceDate ? "service" : current.renewalDate ? "renewal" : undefined);
      await transaction.update(items).set({
        costMinor: command.costMinor ?? current.costMinor,
        status: "active",
        snoozedUntil: null,
        recurrenceMonths: command.nextDate ? current.recurrenceMonths : null,
        ...itemDates(command.nextDate ? kind : undefined, command.nextDate),
        version: sql`${items.version} + 1`,
        updatedAt: new Date(),
      }).where(eq(items.id, itemId));
      if (!command.nextDate) await transaction.delete(reminderRules).where(eq(reminderRules.itemId, itemId));
      await recordActivity(itemId, command.activity);
      return;
    }

    if (command.type === "item.reschedule") {
      const kind = current.serviceDate ? "service" : "renewal";
      await transaction.update(items).set({
        status: "active",
        snoozedUntil: null,
        ...itemDates(kind, command.dueDate),
        version: sql`${items.version} + 1`,
        updatedAt: new Date(),
      }).where(eq(items.id, itemId));
      const [event] = await transaction.select({ id: dueEvents.id }).from(dueEvents)
        .where(and(eq(dueEvents.itemId, itemId), isNull(dueEvents.completedAt))).limit(1);
      if (event) {
        await transaction.update(dueEvents).set({ dueDate: command.dueDate, kind }).where(eq(dueEvents.id, event.id));
      } else {
        await transaction.insert(dueEvents).values({ householdId, itemId, dueDate: command.dueDate, kind });
      }
      await recordActivity(itemId, command.activity);
      return;
    }

    if (command.type === "item.snooze") {
      await transaction.update(items).set({
        snoozedUntil: command.snoozedUntil,
        version: sql`${items.version} + 1`,
        updatedAt: new Date(),
      }).where(eq(items.id, itemId));
      await recordActivity(itemId, command.activity);
      return;
    }

    if (command.type === "item.status") {
      await transaction.update(items).set({
        status: command.status,
        version: sql`${items.version} + 1`,
        updatedAt: new Date(),
      }).where(eq(items.id, itemId));
      await recordActivity(itemId, command.activity);
      return;
    }

  });

  const nextActiveId = command.type === "household.activate" ? command.householdId : undefined;
  return readWorkspace(userId, sessionId, nextActiveId);
}

export interface HouseholdMember {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  role: "owner" | "member";
}

export interface RegisteredUserCandidate {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export async function listHouseholdMembers(userId: string, householdId: string): Promise<HouseholdMember[]> {
  await requireHouseholdAccess(userId, householdId);
  return getDb().select({
    id: users.id,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    role: memberships.role,
  }).from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.householdId, householdId))
    .orderBy(asc(memberships.createdAt));
}

/** Returns registered display names to owners without disclosing account email addresses. */
export async function listRegisteredUserCandidates(userId: string, householdId: string): Promise<RegisteredUserCandidate[]> {
  await requireHouseholdAccess(userId, householdId, true);
  const currentMembers = await getDb().select({ userId: memberships.userId }).from(memberships)
    .where(eq(memberships.householdId, householdId));
  const memberIds = currentMembers.map((member) => member.userId);
  return getDb().select({
    id: users.id,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
  }).from(users)
    .where(and(
      isNull(users.disabledAt),
      memberIds.length ? notInArray(users.id, memberIds) : sql`true`,
    ))
    .orderBy(asc(users.displayName))
    .limit(500);
}

export async function addHouseholdMember(userId: string, householdId: string, memberUserId: string): Promise<HouseholdMember[]> {
  await requireHouseholdAccess(userId, householdId, true);
  const validHouseholdId = requireUuid(householdId, "Household");
  const targetUserId = requireUuid(memberUserId, "Member");
  await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:household-owner:${validHouseholdId}`}, 0))`,
    );
    const [actor] = await transaction.select({
      role: memberships.role,
      administrator: users.isInstanceAdmin,
    }).from(users).leftJoin(
      memberships,
      and(eq(memberships.userId, users.id), eq(memberships.householdId, validHouseholdId)),
    ).where(eq(users.id, userId)).limit(1);
    if (!actor?.administrator && actor?.role !== "owner") {
      throw new AppError("owner_required", "Only the current household owner can add members", 403);
    }
    const [registered] = await transaction.select({ id: users.id, disabledAt: users.disabledAt }).from(users)
      .where(eq(users.id, targetUserId)).limit(1);
    if (!registered) throw new AppError("user_not_found", "That registered Orbit user is no longer available", 404);
    if (registered.disabledAt) throw new AppError("account_disabled", "That Orbit account is disabled", 409);
    await transaction.insert(memberships).values({
      householdId: validHouseholdId,
      userId: targetUserId,
      role: "member",
    }).onConflictDoNothing();
  });
  return listHouseholdMembers(userId, householdId);
}

export async function removeHouseholdMember(userId: string, householdId: string, memberUserId: string): Promise<HouseholdMember[]> {
  await requireHouseholdAccess(userId, householdId);
  const validHouseholdId = requireUuid(householdId, "Household");
  const targetUserId = requireUuid(memberUserId, "Member");
  await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:household-owner:${validHouseholdId}`}, 0))`,
    );
    const [actor] = await transaction.select({
      role: memberships.role,
      administrator: users.isInstanceAdmin,
    }).from(users).leftJoin(
      memberships,
      and(eq(memberships.userId, users.id), eq(memberships.householdId, validHouseholdId)),
    ).where(eq(users.id, userId)).limit(1);
    const [target] = await transaction.select({ role: memberships.role }).from(memberships)
      .where(and(eq(memberships.householdId, validHouseholdId), eq(memberships.userId, targetUserId)))
      .limit(1);
    if (!target) throw new AppError("member_not_found", "That member is not part of this household", 404);
    if (target.role === "owner") throw new AppError("owner_protected", "The household owner cannot be removed", 409);
    if (!actor?.administrator && actor?.role !== "owner" && targetUserId !== userId) {
      throw new AppError("owner_required", "Only the current household owner can remove other members", 403);
    }
    await transaction.delete(memberships).where(and(
      eq(memberships.householdId, validHouseholdId),
      eq(memberships.userId, targetUserId),
    ));
    await transaction.insert(auditLog).values({
      householdId: validHouseholdId,
      actorUserId: userId,
      entityType: "membership",
      entityId: validHouseholdId,
      action: targetUserId === userId ? "member_left" : "member_removed",
      changes: { targetUserId },
    });
  });
  return listHouseholdMembers(userId, householdId);
}

/**
 * Atomically hands household ownership to an existing member. Serialising on
 * the household prevents concurrent requests from leaving multiple owners.
 */
export async function transferHouseholdOwnership(
  userId: string,
  householdId: string,
  nextOwnerUserId: string,
): Promise<HouseholdMember[]> {
  await requireHouseholdAccess(userId, householdId, true);
  const validHouseholdId = requireUuid(householdId, "Household");
  const validNextOwnerId = requireUuid(nextOwnerUserId, "Member");

  await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:household-owner:${validHouseholdId}`}, 0))`,
    );
    const householdMembers = await transaction.select({
      userId: memberships.userId,
      role: memberships.role,
    }).from(memberships).where(eq(memberships.householdId, validHouseholdId));
    const [actor] = await transaction.select({ administrator: users.isInstanceAdmin })
      .from(users).where(eq(users.id, userId)).limit(1);
    const plan = planOwnershipTransfer(
      householdMembers,
      userId,
      validNextOwnerId,
      actor?.administrator ?? false,
    );
    if (!plan.changed) return;

    await transaction.update(memberships).set({ role: "member" })
      .where(and(eq(memberships.householdId, validHouseholdId), eq(memberships.role, "owner")));
    const [promoted] = await transaction.update(memberships).set({ role: "owner" })
      .where(and(eq(memberships.householdId, validHouseholdId), eq(memberships.userId, validNextOwnerId)))
      .returning({ userId: memberships.userId });
    if (!promoted) {
      throw new AppError("member_not_found", "The selected member is no longer available", 409);
    }
    await transaction.insert(auditLog).values({
      householdId: validHouseholdId,
      actorUserId: userId,
      entityType: "household",
      entityId: validHouseholdId,
      action: "ownership_transferred",
      changes: {
        previousOwnerUserId: plan.previousOwnerUserId,
        nextOwnerUserId: plan.nextOwnerUserId,
      },
    });
  });

  return listHouseholdMembers(userId, householdId);
}
