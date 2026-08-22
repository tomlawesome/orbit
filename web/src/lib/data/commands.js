/**
 * The item view's writes (#455): pure builders for the engine's command
 * vocabulary (src/lib/workspace.ts, workspaceCommandSchema). Payloads mirror
 * the shipped app's construction (src/components/dashboard.tsx) exactly —
 * expectedVersion from the item, an activity record with a UUID and the
 * occurred-at instant — so the server sees nothing new, only a new sender.
 *
 * Pure and injectable (ids = {uuid, now}) so the contract is unit-tested
 * rather than discovered in a container run.
 */

const DEFAULT_IDS = {
  uuid: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
};

/**
 * The item's next orbit: the completion date plus its period in calendar
 * months, clamped to the end of a shorter month rather than overflowing into
 * the one after (31 Jan + 1 month is 28 Feb, not 3 Mar).
 */
export function nextDateAfter(completedDate, recurrenceMonths) {
  if (!recurrenceMonths) return null;
  const [year, month, day] = completedDate.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + recurrenceMonths, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function activityOf(item, kind, details, ids) {
  return {
    id: ids.uuid(),
    itemId: item.id,
    kind,
    occurredAt: ids.now(),
    ...details,
  };
}

function base(item) {
  return {
    householdId: item.householdId,
    itemId: item.id,
    expectedVersion: item.version ?? 1,
  };
}

export function completeCommand(item, { completedDate, nextDate, costMinor, notes }, ids = DEFAULT_IDS) {
  const kind = item.scheduleKind === "renewal" ? "renewal_completed" : "service_completed";
  return {
    type: "item.complete",
    ...base(item),
    completedDate,
    ...(nextDate ? { nextDate } : {}),
    ...(costMinor !== undefined && costMinor !== null ? { costMinor } : {}),
    ...(notes ? { notes } : {}),
    activity: activityOf(item, kind, {
      effectiveDate: completedDate,
      ...(item.dueDate ? { previousDate: item.dueDate } : {}),
      ...(nextDate ? { nextDate } : {}),
      ...(costMinor !== undefined && costMinor !== null ? { costMinor } : {}),
      ...(notes ? { notes } : {}),
    }, ids),
  };
}

export function rescheduleCommand(item, dueDate, ids = DEFAULT_IDS) {
  return {
    type: "item.reschedule",
    ...base(item),
    dueDate,
    activity: activityOf(item, "rescheduled", {
      ...(item.dueDate ? { previousDate: item.dueDate } : {}),
      nextDate: dueDate,
    }, ids),
  };
}

export function snoozeCommand(item, snoozedUntil, ids = DEFAULT_IDS) {
  return {
    type: "item.snooze",
    ...base(item),
    snoozedUntil,
    activity: activityOf(item, "snoozed", { effectiveDate: snoozedUntil }, ids),
  };
}

export function archiveCommand(item, ids = DEFAULT_IDS) {
  return {
    type: "item.archive",
    ...base(item),
    activity: activityOf(item, "archived", {}, ids),
  };
}

export function statusCommand(item, status, ids = DEFAULT_IDS) {
  return {
    type: "item.status",
    ...base(item),
    status,
    activity: activityOf(item, status === "active" ? "restored" : "cancelled", {}, ids),
  };
}

/** The workspaceItemSchema fields — the view-model's joins must never travel. */
const ITEM_FIELDS = [
  "id", "sectionId", "title", "subtype", "provider", "reference", "costMinor",
  "currency", "dueDate", "scheduleKind", "recurrenceMonths", "reminderDays",
  "snoozedUntil", "notes", "status", "version", "updatedAt",
];

export function upsertCommand(item, edits, ids = DEFAULT_IDS) {
  const merged = { ...item, ...edits };
  const clean = {};
  for (const field of ITEM_FIELDS) {
    if (merged[field] !== undefined && merged[field] !== null) clean[field] = merged[field];
  }
  return {
    type: "item.upsert",
    householdId: item.householdId,
    item: clean,
    activity: activityOf(item, "updated", {}, ids),
  };
}
