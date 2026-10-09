import { z } from "zod";
import {
  ACTIVITY_NOTES_MAX,
  COST_MINOR_MAX,
  NOTES_MAX,
  PROVIDER_MAX,
  RECURRENCE_MAX,
  REFERENCE_MAX,
  REMINDER_DAYS_MAX,
  REMINDER_MAX,
  SUBTYPE_MAX,
  TITLE_MAX,
  defaultSections,
  itemStatuses,
  scheduleKinds,
  sectionAccents,
  sectionIcons,
  type HomeItem,
  type HouseholdSection,
  type ScheduleKind,
} from "@/lib/domain";
import { calendarDate } from "@/lib/calendar-date";
import { AppError } from "@/lib/errors";
import { itemKinds, itemOfIntent, type ItemIntent, type ItemKind, type StoredItemFacts } from "@/lib/item-kind";
import { nextDueDate } from "@/lib/next-due-date";
import { currencyCode, timeZoneName } from "@/lib/platform-lists";
import { completionRefusal, costMinorOf, itemRefusal, Refusal } from "@/lib/refusals";

export const WORKSPACE_VERSION = 1;

export const optionalText = (maximum: number) => z.string().trim().max(maximum).optional();
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
  /* #1005: written by the worker's daily sweep, never by a member -- an
     expiry's fortnight ran out and the item became an ended thing. */
  "expired",
] as const;

/**
 * Why an encrypted field is not being shown (ADR-0024 decision 5).
 * `metadata_integrity_failed` is one damaged value; `metadata_locked` is the
 * instance missing its key-encryption key, which is reversible. Neither is
 * ever rendered as an empty value: the field is absent and the marker says so.
 */
export const metadataFieldStates = ["metadata_integrity_failed", "metadata_locked"] as const;
export const metadataFieldStateSchema = z.enum(metadataFieldStates);
export const itemMetadataStatusSchema = z.object({
  reference: metadataFieldStateSchema.optional(),
  notes: metadataFieldStateSchema.optional(),
  /* Tier 2 (#963). `title` is the one required field that can now be missing,
     which is why the item schema below tolerates an empty title only when this
     says why it is empty. */
  title: metadataFieldStateSchema.optional(),
  provider: metadataFieldStateSchema.optional(),
  costMinor: metadataFieldStateSchema.optional(),
});
export type ItemMetadataStatus = z.infer<typeof itemMetadataStatusSchema>;

const workspaceItemShape = z.object({
  id: z.string().min(1).max(100),
  sectionId: z.string().min(1).max(100),
  /* Empty only for a damaged or locked title (ADR-0024 decision 5), which the
     superRefine below is what allows: a write still has to carry a real one,
     and the read path is the only producer of the empty case. */
  title: z.string().trim().max(TITLE_MAX),
  subtype: optionalText(SUBTYPE_MAX),
  provider: optionalText(PROVIDER_MAX),
  reference: optionalText(REFERENCE_MAX),
  costMinor: z.number().int().min(0).max(COST_MINOR_MAX).optional(),
  currency: currencyCode,
  dueDate: calendarDate.optional(),
  scheduleKind: z.enum(scheduleKinds).optional(),
  recurrenceMonths: z.number().int().min(1).max(RECURRENCE_MAX).optional(),
  reminderDays: z.array(z.number().int().min(0).max(REMINDER_DAYS_MAX)).max(REMINDER_MAX).optional(),
  snoozedUntil: calendarDate.optional(),
  notes: optionalText(NOTES_MAX),
  /** Read-only; the write path ignores whatever a client sends here. */
  metadataStatus: itemMetadataStatusSchema.optional(),
  /** Read-only; count of the item's listable documents, added by the read path (#1091). */
  documentCount: z.number().int().min(0).optional(),
  status: z.enum(itemStatuses),
  version: z.number().int().positive().optional(),
  updatedAt: z.iso.datetime().optional(),
});

export const workspaceItemSchema = workspaceItemShape.superRefine((item, context) => {
  if (!item.title && !item.metadataStatus?.title) {
    context.addIssue({ code: "custom", path: ["title"], message: "Give this a name" });
  }
  if (item.scheduleKind && !item.dueDate) {
    context.addIssue({ code: "custom", path: ["dueDate"], message: "Choose a date for the scheduled event" });
  }
  if (item.recurrenceMonths && !item.scheduleKind) {
    context.addIssue({ code: "custom", path: ["recurrenceMonths"], message: "Recurrence requires a schedule type" });
  }
  /* #1005: an expiry is the one-off kind. It ends on its day and does not come
     round, so a recurrence on one is a contradiction rather than a default to
     quietly drop -- the reviewer is told, exactly as an unscheduled one is. */
  if (item.recurrenceMonths && item.scheduleKind === "expiry") {
    context.addIssue({ code: "custom", path: ["recurrenceMonths"], message: "An expiry happens once and does not come round" });
  }
});

export function initialScheduleKind(item?: Pick<HomeItem, "scheduleKind">): ScheduleKind | "none" {
  return item ? item.scheduleKind ?? "none" : "renewal";
}

export const itemActivitySchema = z.object({
  id: z.string().min(1).max(100),
  itemId: z.string().min(1).max(100),
  kind: z.enum(activityKinds),
  occurredAt: z.iso.datetime(),
  effectiveDate: calendarDate.optional(),
  previousDate: calendarDate.optional(),
  nextDate: calendarDate.optional(),
  costMinor: z.number().int().min(0).max(COST_MINOR_MAX).optional(),
  notes: optionalText(ACTIVITY_NOTES_MAX),
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
  timezone: timeZoneName,
  currency: currencyCode,
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
  /** Read-only (ADR-0034, #1325): the household's calendar date where it
   * lives, as the engine reckons it for its rules (household-date.ts), so a
   * client's calendar greys exactly the days the engine refuses. */
  today: calendarDate.optional(),
});

export const recoverableHouseholdSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(60),
  deleteAfter: z.iso.datetime(),
});

/** §11 (#453): the ENTIRE surface a non-member sees of a household — an id,
 * a name, and whether they have already asked to join. Deliberately its own
 * minimal shape, never the member household schema with empty arrays. */
export const visibleHouseholdSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  requested: z.boolean().default(false),
});

/** Mirrored by listVisibleHouseholds' SQL LIMIT (src/server/join-requests.ts,
 * #492): the schema cap is meaningless if the query it bounds can still
 * return more rows than it allows. */
export const VISIBLE_HOUSEHOLDS_LIMIT = 500;

export const workspaceSchema = z.object({
  version: z.literal(WORKSPACE_VERSION),
  /** The server decides whether the user may enter a household or must choose one. */
  householdLanding: z.enum(["active", "choose"]).default("active"),
  activeHouseholdId: z.string().min(1).nullable(),
  households: z.array(householdWorkspaceSchema).max(500),
  recoverableHouseholds: z.array(recoverableHouseholdSchema).max(500).default([]),
  /** Populated only on the choose branch: the labelled sky (#453). */
  visibleHouseholds: z.array(visibleHouseholdSchema).max(VISIBLE_HOUSEHOLDS_LIMIT).default([]),
});

export type ItemActivity = z.infer<typeof itemActivitySchema>;
/** An activity as a client sends it where the engine names its kind (#1325). */
export type ItemActivityIntent = Omit<ItemActivity, "kind">;
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
  | {
      type: "item.upsert";
      householdId: string;
      kind?: ItemKind;
      item: ItemIntent;
      activity?: ItemActivityIntent;
      /** Engine-side callers only, never on the wire (the schema has no
       * such field): what a new item starts from when the engine has
       * already read it -- reviewed intake's relay reading. An edit's basis
       * is always the stored item. */
      basis?: StoredItemFacts;
    }
  | { type: "item.archive"; householdId: string; itemId: string; expectedVersion: number; activity: ItemActivityIntent }
  | {
      type: "item.complete";
      householdId: string;
      itemId: string;
      expectedVersion: number;
      completedDate: string;
      costMinor?: number;
      notes?: string;
      activity: ItemActivityIntent;
    }
  | { type: "item.reschedule"; householdId: string; itemId: string; expectedVersion: number; dueDate: string; activity: ItemActivityIntent }
  | { type: "item.snooze"; householdId: string; itemId: string; expectedVersion: number; snoozedUntil: string; activity: ItemActivityIntent }
  | { type: "item.status"; householdId: string; itemId: string; expectedVersion: number; status: "active" | "cancelled"; activity: ItemActivityIntent }
  | { type: "notification.read"; householdId: string; notificationId: string }
  | { type: "notification.dismiss"; householdId: string; notificationId: string }
  | { type: "notification.read-all"; householdId: string; notificationIds: string[] };

/**
 * WHAT A NEW SYSTEM IS ASKED FOR (§15, "first-run asks three things only").
 *
 * The arrival's create card knows three things — a name, a time zone and a
 * currency — and design/v19/first-run.html is explicit that the fourth is not
 * the form's business: "sections are no longer in the payload the form
 * composes; the command applies the default set itself, so there is ONE PLACE
 * that decides what a new household starts with". That place is
 * `defaultSections` (src/lib/domain.ts), reached here through `cloneSections()`
 * — so a browser that knows only the three answers can compose the whole
 * command, and the default set cannot drift between callers.
 *
 * The sheet names `household.setup` for this, on the premise that the install
 * leaves a household SHELL behind for the first admin to complete. This engine
 * leaves no shell: `provisionIdentity` creates a user and nothing else, so
 * there is no `householdId` to address and the road is the one the same sheet
 * gives the other create ("a second system from an empty sky uses
 * `household.create` down the same road"). One command, both cases.
 *
 * Everything the browser may not know is DEFAULTED rather than removed, so the
 * shipped dashboard's payload — the full household, composed by
 * `createHousehold()` below — still parses exactly as it always did.
 */
export const householdCreateSchema = householdWorkspaceSchema
  .extend({
    memberCount: z.number().int().positive().default(1),
    canManage: z.boolean().default(true),
    sections: z.array(workspaceSectionSchema).min(1).max(12).optional(),
    items: z.array(workspaceItemSchema).max(500).default([]),
  })
  .transform((household) => ({
    ...household,
    sections: household.sections
      ?? cloneSections().map((section) => ({ ...section, id: crypto.randomUUID() })),
  }));

/**
 * An item as a client sends it (ADR-0034, #1325): what the member typed and
 * chose, beside the kind on the command. The schedule kind, subtype and
 * status follow from the kind and the stored item (item-kind.ts), so a client
 * never sends them; parseWorkspaceCommand refuses them. A repeat may be 0
 * ("once"); the engine keeps it only where a schedule comes round.
 */
export const itemIntentSchema = workspaceItemShape
  .omit({ scheduleKind: true, subtype: true, status: true, recurrenceMonths: true })
  .extend({
    /* 0 is the member clearing a repeat ("once"); the stored item's schema
       starts at 1, and the engine keeps a repeat only where a schedule comes
       round (item-kind.ts). */
    recurrenceMonths: z.number().int().min(0).max(RECURRENCE_MAX).optional(),
    scheduleKind: z.never().optional(),
    subtype: z.never().optional(),
    status: z.never().optional(),
  });

/** An item command's activity as a client sends it: the identity, the
 * moment and the details, never the kind, which the engine names from what
 * the command did (ADR-0034, #1325). */
const activityIntentSchema = itemActivitySchema.extend({ kind: z.never().optional() });

/** Runtime contract shared by the browser synchronizer and authenticated command API. */
export const workspaceCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("household.create"), household: householdCreateSchema }),
  z.object({
    type: z.literal("household.setup"),
    householdId: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(60),
    timezone: timeZoneName,
    currency: currencyCode,
    sections: z.array(workspaceSectionSchema).min(1).max(12),
  }),
  z.object({
    type: z.literal("household.update"),
    householdId: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(60),
    timezone: timeZoneName,
    currency: currencyCode,
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
    kind: z.enum(itemKinds).optional(),
    item: itemIntentSchema,
    activity: activityIntentSchema.optional(),
  }),
  z.object({
    type: z.literal("item.archive"),
    householdId: z.string().min(1).max(100),
    itemId: z.string().min(1).max(100),
    expectedVersion: z.number().int().positive(),
    activity: activityIntentSchema,
  }),
  z.object({
    type: z.literal("item.complete"),
    householdId: z.string().min(1).max(100),
    itemId: z.string().min(1).max(100),
    expectedVersion: z.number().int().positive(),
    completedDate: calendarDate,
    /* ADR-0034, #1324: the engine works the next date out from the item's
       period; parseWorkspaceCommand refuses one sent by a client. */
    nextDate: z.never().optional(),
    costMinor: z.number().int().min(0).max(COST_MINOR_MAX).optional(),
    notes: optionalText(ACTIVITY_NOTES_MAX),
    activity: activityIntentSchema.extend({ nextDate: z.never().optional() }),
  }),
  z.object({
    type: z.literal("item.reschedule"),
    householdId: z.string().min(1).max(100),
    itemId: z.string().min(1).max(100),
    expectedVersion: z.number().int().positive(),
    dueDate: calendarDate,
    activity: activityIntentSchema,
  }),
  z.object({
    type: z.literal("item.snooze"),
    householdId: z.string().min(1).max(100),
    itemId: z.string().min(1).max(100),
    expectedVersion: z.number().int().positive(),
    snoozedUntil: calendarDate,
    activity: activityIntentSchema,
  }),
  z.object({
    type: z.literal("item.status"),
    householdId: z.string().min(1).max(100),
    itemId: z.string().min(1).max(100),
    expectedVersion: z.number().int().positive(),
    status: z.enum(["active", "cancelled"]),
    activity: activityIntentSchema,
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

/**
 * Reads a command a client sent. A command carries intent, never derived
 * state (ADR-0034): a completion carries what happened -- the day, the cost,
 * the notes -- and never the next due date, which the engine works out from
 * the item's period (#1324); an item carries what the member typed and the
 * kind they chose, never its schedule kind, subtype or status (#1325).
 * Derived state sent anyway is refused rather than quietly dropped, so a
 * client that still computes it finds out.
 *
 * The member-facing rules run first, so a member reads why in their own words
 * (refusals.ts) rather than a schema message. A cost may come as typed
 * (`cost: "£1,250"`), which the engine reads into `costMinor`.
 */
export function parseWorkspaceCommand(input: unknown): WorkspaceCommand {
  if (isRecord(input) && typeof input.type === "string" && input.type.startsWith("item.")
    && isRecord(input.activity) && input.activity.kind !== undefined) {
    throw new AppError(
      "invalid_command",
      `An ${input.type} command does not send its activity's kind; Orbit records what the command did`,
      400,
    );
  }
  if (isRecord(input) && input.type === "item.complete") {
    const activity = isRecord(input.activity) ? input.activity : {};
    if (input.nextDate !== undefined || activity.nextDate !== undefined) {
      throw new AppError(
        "invalid_command",
        "A completion does not send the next due date; Orbit works it out from the item's period",
        400,
      );
    }
    const refused = completionRefusal(input);
    if (refused) throw new Refusal(refused);
    return workspaceCommandSchema.parse(withTypedCost(input, (costMinor) => ({
      activity: isRecord(input.activity) && input.activity.costMinor === undefined
        ? { ...input.activity, costMinor }
        : input.activity,
    })));
  }
  if (isRecord(input) && input.type === "item.upsert" && isRecord(input.item)) {
    const derived = (["scheduleKind", "subtype", "status"] as const).filter((key) => (input.item as Record<string, unknown>)[key] !== undefined);
    if (derived.length) {
      throw new AppError(
        "invalid_command",
        `An item does not send its ${derived.join(", ")}; Orbit works them out from the kind`,
        400,
      );
    }
    const kind = itemKinds.find((one) => one === input.kind);
    const refused = itemRefusal(input.item, kind);
    if (refused) throw new Refusal(refused);
    return workspaceCommandSchema.parse({ ...input, item: withTypedCost(input.item) });
  }
  return workspaceCommandSchema.parse(input);
}

/**
 * The command or item with its typed `cost` read into `costMinor`; a client
 * sends one or the other. `alongside` adds what else follows from the cost.
 */
function withTypedCost(
  record: Record<string, unknown>,
  alongside: (costMinor: number) => Record<string, unknown> = () => ({}),
): Record<string, unknown> {
  if (record.cost === undefined) return record;
  if (record.costMinor !== undefined) {
    throw new AppError("invalid_command", "Send the cost as typed or in minor units, not both", 400);
  }
  const { cost, ...rest } = record;
  if (typeof cost !== "string") throw new AppError("invalid_command", "A typed cost is text", 400);
  const costMinor = costMinorOf(cost);
  return costMinor === undefined ? rest : { ...rest, costMinor, ...alongside(costMinor) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
    householdLanding: "choose",
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

/** The completion's activity as the engine records it: its kind is the
 * schedule's (a renewal renewed, anything else serviced, #1325), and the
 * next date is the one the engine worked out, never the client's (#1324). */
export function completionActivity(
  activity: ItemActivityIntent,
  scheduleKind: ScheduleKind | undefined,
  nextDate: string | undefined,
): ItemActivity {
  const { nextDate: _sent, ...rest } = activity as ItemActivity;
  const kind = scheduleKind === "renewal" ? "renewal_completed" : "service_completed";
  return nextDate ? { ...rest, kind, nextDate } : { ...rest, kind };
}

/** A status change's activity as the engine records it: restored or cancelled (#1325). */
export function statusActivity(activity: ItemActivityIntent, status: "active" | "cancelled"): ItemActivity {
  return { ...activity, kind: status === "active" ? "restored" : "cancelled" };
}

/** The activity of an item command whose kind follows from the command alone (#1325). */
export function namedActivity(activity: ItemActivityIntent, kind: "created" | "updated" | "archived" | "rescheduled" | "snoozed"): ItemActivity {
  return { ...activity, kind };
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
        householdLanding: "active",
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
      return updateHousehold(state, command.householdId, (household) => {
        const currentIndex = household.items.findIndex((entry) => entry.id === command.item.id);
        const item = workspaceItemSchema.parse(itemOfIntent(command.item, command.kind, household.items[currentIndex] ?? command.basis));
        const activity = command.activity && namedActivity(command.activity, currentIndex < 0 ? "created" : "updated");
        const items = currentIndex < 0
          ? [item, ...household.items]
          : household.items.map((entry, index) => index === currentIndex ? item : entry);
        return { ...household, items, activities: appendActivity(household, activity) };
      });
    }
    case "item.archive": {
      return updateHousehold(state, command.householdId, (household) => ({
        ...household,
        items: household.items.map((item) => item.id === command.itemId
          ? updateItem(item, { status: "archived" }, command.activity.occurredAt)
          : item),
        activities: appendActivity(household, namedActivity(command.activity, "archived")),
      }));
    }
    case "item.complete": {
      return updateHousehold(state, command.householdId, (household) => {
        const completed = household.items.find((item) => item.id === command.itemId);
        const nextDate = completed ? nextDueDate(completed, command.completedDate) : undefined;
        return {
          ...household,
          items: household.items.map((item) => {
            if (item.id !== command.itemId) return item;
            const hasNextSchedule = Boolean(nextDate);
            return updateItem(item, {
              status: "active",
              costMinor: command.costMinor ?? item.costMinor,
              dueDate: nextDate,
              scheduleKind: hasNextSchedule ? item.scheduleKind : undefined,
              recurrenceMonths: hasNextSchedule ? item.recurrenceMonths : undefined,
              reminderDays: hasNextSchedule ? item.reminderDays : undefined,
              snoozedUntil: undefined,
            }, command.activity.occurredAt);
          }),
          activities: appendActivity(household, completionActivity(command.activity, completed?.scheduleKind, nextDate)),
        };
      });
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
        activities: appendActivity(household, namedActivity(command.activity, "rescheduled")),
      }));
    }
    case "item.snooze": {
      return updateHousehold(state, command.householdId, (household) => ({
        ...household,
        items: household.items.map((item) => item.id === command.itemId
          ? updateItem(item, { snoozedUntil: command.snoozedUntil }, command.activity.occurredAt)
          : item),
        activities: appendActivity(household, namedActivity(command.activity, "snoozed")),
      }));
    }
    case "item.status": {
      return updateHousehold(state, command.householdId, (household) => ({
        ...household,
        items: household.items.map((item) => item.id === command.itemId
          ? updateItem(item, { status: command.status }, command.activity.occurredAt)
          : item),
        activities: appendActivity(household, statusActivity(command.activity, command.status)),
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
