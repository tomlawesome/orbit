/**
 * WHAT A KIND MEANS (ADR-0034 decision 2, #1325; the owner's #1058 mapping).
 * A member files an item as one of five kinds; the engine decides what that
 * schedules and which subtype it records, and the browser sends only the kind.
 *
 *   · service and renewal schedule themselves;
 *   · inspection is a service with subtype `inspection`, so an MOT comes round;
 *   · document is an expiry with an optional date, and happens once;
 *   · suggestion schedules nothing.
 *
 * A schedule only exists with a date (workspaceItemSchema's rule), and a
 * repeat only with a schedule that comes round. A new item is active; an
 * edited one keeps its status, which only item.status changes.
 */
import type { HomeItem, ItemStatus, ScheduleKind } from "@/lib/domain";

/** A repeat is "every N months", at most ten years (recurrenceMonths' range). */
export const RECURRENCE_MAX = 120;

export const itemKinds = ["service", "renewal", "inspection", "suggestion", "document"] as const;
export type ItemKind = (typeof itemKinds)[number];

/** Whether a kind asks for a date at all (a suggestion schedules nothing). */
export const kindHasDate = (kind: ItemKind | null | undefined) => kind !== "suggestion";
/** Whether a kind can come round (a document's expiry happens once). */
export const kindRecurs = (kind: ItemKind | null | undefined) => kind !== "suggestion" && kind !== "document";

/** What a kind schedules, and the subtype it records. */
export function scheduleOfKind(kind: ItemKind | null | undefined): { scheduleKind?: ScheduleKind; subtype?: string } {
  switch (kind) {
    case "service": return { scheduleKind: "service", subtype: "service" };
    case "renewal": return { scheduleKind: "renewal", subtype: "renewal" };
    case "inspection": return { scheduleKind: "service", subtype: "inspection" };
    case "document": return { scheduleKind: "expiry", subtype: "document" };
    case "suggestion": return { subtype: "suggestion" };
    default: return {};
  }
}

/**
 * The kind a stored item reads as: its subtype when that is one of the five,
 * otherwise what its schedule says; null when neither says.
 */
export function kindOfItem(item: { subtype?: string | null; scheduleKind?: string | null }): ItemKind | null {
  const named = itemKinds.find((kind) => kind === item.subtype);
  if (named) return named;
  if (item.scheduleKind === "renewal") return "renewal";
  if (item.scheduleKind === "service") return "service";
  if (item.scheduleKind === "expiry") return "document";
  return null;
}

/** What a client sends for an item: what the member typed and chose, never what follows from it. */
export type ItemIntent = Omit<HomeItem, "scheduleKind" | "subtype" | "status" | "recurrenceMonths"> & {
  /** "every N months"; 0 or absent is once. */
  recurrenceMonths?: number;
};

/** What the engine keeps of an item already stored, to decide an edit. */
export type StoredItemFacts = { subtype?: string | null; scheduleKind?: ScheduleKind | null; status: ItemStatus };

/**
 * The item an upsert stores: the member's intent, with the schedule, subtype,
 * repeat and status the kind and the stored item decide. An edit that keeps
 * the item's kind keeps its own schedule and subtype (an "MOT" stays an MOT);
 * one that changes it takes the new kind's.
 */
export function itemOfIntent(intent: ItemIntent, kind: ItemKind | undefined, stored?: StoredItemFacts): HomeItem {
  const { recurrenceMonths, ...fields } = intent;
  const storedKind = stored ? kindOfItem(stored) : null;
  const retyped = !stored || (kind !== undefined && kind !== storedKind);
  const chosen = kind ?? storedKind;
  const dueDate = kindHasDate(chosen) && intent.dueDate ? intent.dueDate : undefined;
  const kept = retyped ? undefined : stored?.scheduleKind ?? undefined;
  const scheduleKind = dueDate ? kept ?? scheduleOfKind(chosen).scheduleKind : undefined;
  const months = recurrenceMonths ?? 0;
  const recurs = Boolean(scheduleKind) && scheduleKind !== "expiry" && months > 0;
  const subtype = retyped ? scheduleOfKind(chosen).subtype : stored?.subtype ?? undefined;
  return {
    ...fields,
    dueDate,
    scheduleKind,
    recurrenceMonths: recurs ? Math.min(RECURRENCE_MAX, months) : undefined,
    subtype,
    status: stored?.status ?? "active",
  };
}
