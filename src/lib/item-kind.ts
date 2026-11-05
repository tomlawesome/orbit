/**
 * WHAT A STORED ITEM'S SCHEDULE FOLLOWS FROM (ADR-0044, #1468; amends ADR-0034
 * decision 2). An item has no type. A command carries the item's date and how
 * it repeats; the engine decides the rest:
 *
 *   · a new item with a date is a `renewal` (the engine's default schedule kind);
 *   · an item with no date has no schedule and no repeat;
 *   · an edit keeps the schedule kind and subtype it was stored with, so an
 *     MOT stays a `service` and a mail-read expiry stays an `expiry`;
 *   · an expiry happens once, so it keeps no repeat.
 *
 * A new item is active; an edited one keeps its status, which only
 * item.status changes. `subtype` is the free-text descriptor a document
 * proposal gives; the form never sets it.
 */
import { RECURRENCE_MAX, type HomeItem, type ItemStatus, type ScheduleKind } from "@/lib/domain";

/** What a client sends for an item: what the member typed and chose, never what follows from it. */
export type ItemIntent = Omit<HomeItem, "scheduleKind" | "subtype" | "status" | "recurrenceMonths"> & {
  /** "every N months"; 0 or absent is once. */
  recurrenceMonths?: number;
};

/** What the engine keeps of an item already stored, to decide an edit. */
export type StoredItemFacts = { subtype?: string | null; scheduleKind?: ScheduleKind | null; status: ItemStatus };

/** The item an upsert stores: the member's intent, with the schedule, subtype, repeat and status the date and the stored item decide. */
export function itemOfIntent(intent: ItemIntent, stored?: StoredItemFacts): HomeItem {
  const { recurrenceMonths, ...fields } = intent;
  const dueDate = intent.dueDate ? intent.dueDate : undefined;
  const scheduleKind: ScheduleKind | undefined = dueDate ? stored?.scheduleKind ?? "renewal" : undefined;
  const months = recurrenceMonths ?? 0;
  const recurs = Boolean(scheduleKind) && scheduleKind !== "expiry" && months > 0;
  return {
    ...fields,
    dueDate,
    scheduleKind,
    recurrenceMonths: recurs ? Math.min(RECURRENCE_MAX, months) : undefined,
    subtype: stored?.subtype ?? undefined,
    status: stored?.status ?? "active",
  };
}
