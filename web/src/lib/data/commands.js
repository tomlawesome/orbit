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

/**
 * The raw item a command is built against. workspace.js's own WorkspaceItem
 * carries no `householdId` (a household already knows which items are its
 * own), but every command here has to address one from outside that context,
 * so this is a local, wider shape rather than a change to that typedef.
 *
 * @typedef {object} CommandItem
 * @property {string} id
 * @property {string} householdId
 * @property {?string} [sectionId]
 * @property {string} title
 * @property {?string} [subtype]
 * @property {?string} [provider]
 * @property {?string} [reference]
 * @property {?number} [costMinor]
 * @property {?boolean} [costIsEstimate]
 * @property {?string} [currency]
 * @property {?string} [dueDate]
 * @property {?string} [scheduleKind]
 * @property {?number} [recurrenceMonths]
 * @property {?number[]} [reminderDays]
 * @property {?string} [snoozedUntil]
 * @property {?string} [notes]
 * @property {string} status
 * @property {number} [version]
 * @property {string} [updatedAt]
 */

/** @typedef {{ uuid: () => string, now: () => string }} IdSource */

/** @type {IdSource} */
const DEFAULT_IDS = {
  uuid: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
};

/**
 * The item's next orbit: the completion date plus its period in calendar
 * months, clamped to the end of a shorter month rather than overflowing into
 * the one after (31 Jan + 1 month is 28 Feb, not 3 Mar).
 * @param {string} completedDate
 * @param {?number} [recurrenceMonths]
 * @returns {?string}
 */
export function nextDateAfter(completedDate, recurrenceMonths) {
  if (!recurrenceMonths) return null;
  const [year, month, day] = completedDate.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + recurrenceMonths, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * @param {CommandItem} item
 * @param {string} kind
 * @param {Partial<import('./workspace.js').ItemActivity>} details
 * @param {IdSource} ids
 * @returns {import('./workspace.js').ItemActivity}
 */
function activityOf(item, kind, details, ids) {
  return {
    id: ids.uuid(),
    itemId: item.id,
    kind,
    occurredAt: ids.now(),
    ...details,
  };
}

/**
 * @param {CommandItem} item
 * @returns {{ householdId: string, itemId: string, expectedVersion: number }}
 */
function base(item) {
  return {
    householdId: item.householdId,
    itemId: item.id,
    expectedVersion: item.version ?? 1,
  };
}

/**
 * @param {CommandItem} item
 * @param {{ completedDate: string | undefined, nextDate?: string, costMinor?: number, notes?: string }} fields
 * @param {IdSource} [ids]
 */
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

/**
 * @param {CommandItem} item
 * @param {string | undefined} dueDate
 * @param {IdSource} [ids]
 */
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

/**
 * @param {CommandItem} item
 * @param {string | undefined} snoozedUntil
 * @param {IdSource} [ids]
 */
export function snoozeCommand(item, snoozedUntil, ids = DEFAULT_IDS) {
  return {
    type: "item.snooze",
    ...base(item),
    snoozedUntil,
    activity: activityOf(item, "snoozed", { effectiveDate: snoozedUntil }, ids),
  };
}

/**
 * @param {CommandItem} item
 * @param {IdSource} [ids]
 */
export function archiveCommand(item, ids = DEFAULT_IDS) {
  return {
    type: "item.archive",
    ...base(item),
    activity: activityOf(item, "archived", {}, ids),
  };
}

/**
 * @param {CommandItem} item
 * @param {string} status
 * @param {IdSource} [ids]
 */
export function statusCommand(item, status, ids = DEFAULT_IDS) {
  return {
    type: "item.status",
    ...base(item),
    status,
    activity: activityOf(item, status === "active" ? "restored" : "cancelled", {}, ids),
  };
}

/**
 * The workspaceItemSchema fields — the view-model's joins must never travel.
 * @type {(keyof CommandItem)[]}
 */
const ITEM_FIELDS = [
  "id", "sectionId", "title", "subtype", "provider", "reference", "costMinor",
  "currency", "dueDate", "scheduleKind", "recurrenceMonths", "reminderDays",
  "snoozedUntil", "notes", "status", "version", "updatedAt",
];

/**
 * Copies one field across if the merged record actually set it -- a small
 * generic so the field-by-field copy below type-checks per property instead
 * of collapsing every field in the list to one shared (and wrong) type.
 * @template {keyof CommandItem} K
 * @param {CommandItem} clean
 * @param {CommandItem} merged
 * @param {K} field
 */
function copyItemField(clean, merged, field) {
  const value = merged[field];
  if (value !== undefined && value !== null) clean[field] = value;
}

/**
 * @param {CommandItem} item
 * @param {Partial<CommandItem>} edits
 * @param {IdSource} [ids]
 */
export function upsertCommand(item, edits, ids = DEFAULT_IDS) {
  const merged = { ...item, ...edits };
  const clean = /** @type {CommandItem} */ ({});
  for (const field of ITEM_FIELDS) {
    copyItemField(clean, merged, field);
  }
  return {
    type: "item.upsert",
    householdId: item.householdId,
    item: clean,
    activity: activityOf(item, "updated", {}, ids),
  };
}
