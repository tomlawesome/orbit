import { z } from "zod";
import {
  defaultSections,
  itemStatuses,
  scheduleKinds,
  sectionAccents,
  sectionIcons,
  type HomeItem,
  type HouseholdSection,
} from "@/lib/domain";

export const WORKSPACE_VERSION = 1;

const optionalText = (maximum: number) => z.string().trim().max(maximum).optional();
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const activityKinds = [
  "created",
  "updated",
  "renewal_completed",
  "service_completed",
  "rescheduled",
  "snoozed",
  "cancelled",
  "restored",
  "archived",
] as const;

export const workspaceItemSchema = z.object({
  id: z.string().min(1).max(100),
  sectionId: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(100),
  subtype: optionalText(80),
  provider: optionalText(100),
  reference: optionalText(80),
  costMinor: z.number().int().min(0).max(100_000_000).optional(),
  currency: z.string().length(3),
  dueDate: calendarDate.optional(),
  scheduleKind: z.enum(scheduleKinds).optional(),
  recurrenceMonths: z.number().int().min(1).max(120).optional(),
  reminderDays: z.array(z.number().int().min(0).max(365)).max(8).optional(),
  snoozedUntil: calendarDate.optional(),
  notes: optionalText(2_000),
  status: z.enum(itemStatuses),
  version: z.number().int().positive().optional(),
  updatedAt: z.iso.datetime().optional(),
}).superRefine((item, context) => {
  if (item.scheduleKind && !item.dueDate) {
    context.addIssue({ code: "custom", path: ["dueDate"], message: "Choose a date for the scheduled event" });
  }
  if (item.recurrenceMonths && !item.scheduleKind) {
    context.addIssue({ code: "custom", path: ["recurrenceMonths"], message: "Recurrence requires a schedule type" });
  }
});

export const itemActivitySchema = z.object({
  id: z.string().min(1).max(100),
  itemId: z.string().min(1).max(100),
  kind: z.enum(activityKinds),
  occurredAt: z.iso.datetime(),
  effectiveDate: calendarDate.optional(),
  previousDate: calendarDate.optional(),
  nextDate: calendarDate.optional(),
  costMinor: z.number().int().min(0).max(100_000_000).optional(),
  notes: optionalText(1_000),
});

export const workspaceSectionSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(30),
  icon: z.enum(sectionIcons),
  accent: z.enum(sectionAccents),
  visible: z.boolean(),
});

export const householdWorkspaceSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(60),
  timezone: z.string().min(1).max(80),
  currency: z.string().length(3),
  memberCount: z.number().int().positive(),
  canManage: z.boolean().default(false),
  onboardingComplete: z.boolean().default(true),
  deletionRequestedAt: z.iso.datetime().optional(),
  deleteAfter: z.iso.datetime().optional(),
  sections: z.array(workspaceSectionSchema).min(1).max(12),
  items: z.array(workspaceItemSchema).max(500),
  activities: z.array(itemActivitySchema).max(5_000).default([]),
  readNotificationIds: z.array(z.string().min(1).max(180)).max(2_000).default([]),
  dismissedNotificationIds: z.array(z.string().min(1).max(180)).max(2_000).default([]),
});

export const recoverableHouseholdSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(60),
  deleteAfter: z.iso.datetime(),
});

export const workspaceSchema = z.object({
  version: z.literal(WORKSPACE_VERSION),
  activeHouseholdId: z.string().min(1).nullable(),
  households: z.array(householdWorkspaceSchema).max(500),
  recoverableHouseholds: z.array(recoverableHouseholdSchema).max(500).default([]),
});

export type ItemActivity = z.infer<typeof itemActivitySchema>;
export type HouseholdWorkspace = z.infer<typeof householdWorkspaceSchema>;
export type WorkspaceState = z.infer<typeof workspaceSchema>;

export type WorkspaceCommand =
  | { type: "household.create"; household: HouseholdWorkspace }
  | {
      type: "household.setup";
      householdId: string;
      name: string;
      timezone: string;
      currency: string;
      sections: HouseholdSection[];
    }
  | { type: "household.update"; householdId: string; name: string; timezone: string; currency: string }
  | { type: "household.activate"; householdId: string }
  | { type: "sections.replace"; householdId: string; sections: HouseholdSection[] }
  | { type: "item.upsert"; householdId: string; item: HomeItem; activity?: ItemActivity }
  | { type: "item.archive"; householdId: string; itemId: string; activity: ItemActivity }
  | {
      type: "item.complete";
      householdId: string;
      itemId: string;
      completedDate: string;
      nextDate?: string;
      costMinor?: number;
      notes?: string;
      activity: ItemActivity;
    }
  | { type: "item.reschedule"; householdId: string; itemId: string; dueDate: string; activity: ItemActivity }
  | { type: "item.snooze"; householdId: string; itemId: string; snoozedUntil: string; activity: ItemActivity }
  | { type: "item.status"; householdId: string; itemId: string; status: "active" | "cancelled"; activity: ItemActivity }
  | { type: "notification.read"; householdId: string; notificationId: string }
  | { type: "notification.dismiss"; householdId: string; notificationId: string }
  | { type: "notification.read-all"; householdId: string; notificationIds: string[] };

/** Runtime contract shared by the browser synchronizer and authenticated command API. */
export const workspaceCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("household.create"), household: householdWorkspaceSchema }),
  z.object({
    type: z.literal("household.setup"),
    householdId: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(60),
    timezone: z.string().min(1).max(80),
    currency: z.string().length(3),
    sections: z.array(workspaceSectionSchema).min(1).max(12),
  }),
  z.object({
    type: z.literal("household.update"),
    householdId: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(60),
    timezone: z.string().min(1).max(80),
    currency: z.string().length(3),
  }),
  z.object({ type: z.literal("household.activate"), householdId: z.string().min(1).max(100) }),
  z.object({
    type: z.literal("sections.replace"),
    householdId: z.string().min(1).max(100),
    sections: z.array(workspaceSectionSchema).min(1).max(12),
  }),
  z.object({
    type: z.literal("item.upsert"),
    householdId: z.string().min(1).max(100),
    item: workspaceItemSchema,
    activity: itemActivitySchema.optional(),
  }),
  z.object({
    type: z.literal("item.archive"),
    householdId: z.string().min(1).max(100),
    itemId: z.string().min(1).max(100),
    activity: itemActivitySchema,
  }),
  z.object({
    type: z.literal("item.complete"),
    householdId: z.string().min(1).max(100),
    itemId: z.string().min(1).max(100),
    completedDate: calendarDate,
    nextDate: calendarDate.optional(),
    costMinor: z.number().int().min(0).max(100_000_000).optional(),
    notes: optionalText(1_000),
    activity: itemActivitySchema,
  }),
  z.object({
    type: z.literal("item.reschedule"),
    householdId: z.string().min(1).max(100),
    itemId: z.string().min(1).max(100),
    dueDate: calendarDate,
    activity: itemActivitySchema,
  }),
  z.object({
    type: z.literal("item.snooze"),
    householdId: z.string().min(1).max(100),
    itemId: z.string().min(1).max(100),
    snoozedUntil: calendarDate,
    activity: itemActivitySchema,
  }),
  z.object({
    type: z.literal("item.status"),
    householdId: z.string().min(1).max(100),
    itemId: z.string().min(1).max(100),
    status: z.enum(["active", "cancelled"]),
    activity: itemActivitySchema,
  }),
  z.object({
    type: z.literal("notification.read"),
    householdId: z.string().min(1).max(100),
    notificationId: z.string().min(1).max(180),
  }),
  z.object({
    type: z.literal("notification.dismiss"),
    householdId: z.string().min(1).max(100),
    notificationId: z.string().min(1).max(180),
  }),
  z.object({
    type: z.literal("notification.read-all"),
    householdId: z.string().min(1).max(100),
    notificationIds: z.array(z.string().min(1).max(180)).max(2_000),
  }),
]);

export function cloneSections(): HouseholdSection[] {
  return defaultSections.map((section) => ({ ...section }));
}

export function createHousehold(input: {
  id: string;
  name: string;
  timezone?: string;
  currency?: string;
}): HouseholdWorkspace {
  return householdWorkspaceSchema.parse({
    id: input.id,
    name: input.name,
    timezone: input.timezone ?? "Europe/London",
    currency: input.currency ?? "GBP",
    memberCount: 1,
    canManage: true,
    onboardingComplete: true,
    sections: cloneSections().map((section) => ({ ...section, id: crypto.randomUUID() })),
    items: [],
  });
}

/** Creates the clean browser-local workspace used before authentication. */
export function createEmptyWorkspace(sections = cloneSections()): WorkspaceState {
  return workspaceSchema.parse({
    version: WORKSPACE_VERSION,
    activeHouseholdId: "local-home",
    recoverableHouseholds: [],
    households: [{
      id: "local-home",
      name: "My home",
      timezone: "Europe/London",
      currency: "GBP",
      memberCount: 1,
      canManage: true,
      onboardingComplete: false,
      sections,
      items: [],
      activities: [],
    }],
  });
}

function appendActivity(household: HouseholdWorkspace, activity: ItemActivity | undefined): ItemActivity[] {
  if (!activity || household.activities.some((entry) => entry.id === activity.id)) return household.activities;
  return [itemActivitySchema.parse(activity), ...household.activities];
}

function updateHousehold(
  state: WorkspaceState,
  householdId: string,
  updater: (household: HouseholdWorkspace) => HouseholdWorkspace,
): WorkspaceState {
  return workspaceSchema.parse({
    ...state,
    households: state.households.map((household) => household.id === householdId ? updater(household) : household),
  });
}

function updateItem(item: HomeItem, changes: Partial<HomeItem>, occurredAt: string): HomeItem {
  return {
    ...item,
    ...changes,
    version: (item.version ?? 1) + 1,
    updatedAt: occurredAt,
  };
}

/** Applies a validated workspace command without coupling product state to its storage adapter. */
export function reduceWorkspace(state: WorkspaceState, command: WorkspaceCommand): WorkspaceState {
  switch (command.type) {
    case "household.create": {
      if (state.households.some((household) => household.id === command.household.id)) return state;
      return workspaceSchema.parse({
        ...state,
        activeHouseholdId: command.household.id,
        households: [...state.households, command.household],
      });
    }
    case "household.setup": {
      return updateHousehold(state, command.householdId, (household) => ({
        ...household,
        name: command.name,
        timezone: command.timezone,
        currency: command.currency,
        onboardingComplete: true,
        sections: command.sections,
      }));
    }
    case "household.update": {
      return updateHousehold(state, command.householdId, (household) => ({
        ...household,
        name: command.name,
        timezone: command.timezone,
        currency: command.currency,
      }));
    }
    case "household.activate": {
      if (!state.households.some((household) => household.id === command.householdId)) return state;
      return { ...state, activeHouseholdId: command.householdId };
    }
    case "sections.replace": {
      const retainedSectionIds = new Set(command.sections.map((section) => section.id));
      const fallbackSectionId = command.sections[0].id;
      return updateHousehold(state, command.householdId, (household) => ({
        ...household,
        sections: command.sections,
        items: household.items.map((item) => retainedSectionIds.has(item.sectionId)
          ? item
          : { ...item, sectionId: fallbackSectionId }),
      }));
    }
    case "item.upsert": {
      const item = workspaceItemSchema.parse(command.item);
      return updateHousehold(state, command.householdId, (household) => {
        const currentIndex = household.items.findIndex((entry) => entry.id === item.id);
        const items = currentIndex < 0
          ? [item, ...household.items]
          : household.items.map((entry, index) => index === currentIndex ? item : entry);
        return { ...household, items, activities: appendActivity(household, command.activity) };
      });
    }
    case "item.archive": {
      return updateHousehold(state, command.householdId, (household) => ({
        ...household,
        items: household.items.map((item) => item.id === command.itemId
          ? updateItem(item, { status: "archived" }, command.activity.occurredAt)
          : item),
        activities: appendActivity(household, command.activity),
      }));
    }
    case "item.complete": {
      return updateHousehold(state, command.householdId, (household) => ({
        ...household,
        items: household.items.map((item) => {
          if (item.id !== command.itemId) return item;
          const hasNextSchedule = Boolean(command.nextDate);
          return updateItem(item, {
            status: "active",
            costMinor: command.costMinor ?? item.costMinor,
            dueDate: command.nextDate,
            scheduleKind: hasNextSchedule ? item.scheduleKind : undefined,
            recurrenceMonths: hasNextSchedule ? item.recurrenceMonths : undefined,
            reminderDays: hasNextSchedule ? item.reminderDays : undefined,
            snoozedUntil: undefined,
          }, command.activity.occurredAt);
        }),
        activities: appendActivity(household, command.activity),
      }));
    }
    case "item.reschedule": {
      return updateHousehold(state, command.householdId, (household) => ({
        ...household,
        items: household.items.map((item) => item.id === command.itemId
          ? updateItem(item, {
              dueDate: command.dueDate,
              scheduleKind: item.scheduleKind ?? "renewal",
              status: "active",
              snoozedUntil: undefined,
            }, command.activity.occurredAt)
          : item),
        activities: appendActivity(household, command.activity),
      }));
    }
    case "item.snooze": {
      return updateHousehold(state, command.householdId, (household) => ({
        ...household,
        items: household.items.map((item) => item.id === command.itemId
          ? updateItem(item, { snoozedUntil: command.snoozedUntil }, command.activity.occurredAt)
          : item),
        activities: appendActivity(household, command.activity),
      }));
    }
    case "item.status": {
      return updateHousehold(state, command.householdId, (household) => ({
        ...household,
        items: household.items.map((item) => item.id === command.itemId
          ? updateItem(item, { status: command.status }, command.activity.occurredAt)
          : item),
        activities: appendActivity(household, command.activity),
      }));
    }
    case "notification.read": {
      return updateHousehold(state, command.householdId, (household) => ({
        ...household,
        readNotificationIds: [...new Set([...household.readNotificationIds, command.notificationId])],
      }));
    }
    case "notification.dismiss": {
      return updateHousehold(state, command.householdId, (household) => ({
        ...household,
        dismissedNotificationIds: [...new Set([...household.dismissedNotificationIds, command.notificationId])],
      }));
    }
    case "notification.read-all": {
      return updateHousehold(state, command.householdId, (household) => ({
        ...household,
        readNotificationIds: [...new Set([...household.readNotificationIds, ...command.notificationIds])],
      }));
    }
  }
}

export function activeHousehold(state: WorkspaceState): HouseholdWorkspace {
  return state.households.find((household) => household.id === state.activeHouseholdId) ?? state.households[0];
}
