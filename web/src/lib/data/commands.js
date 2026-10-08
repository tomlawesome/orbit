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

/**
 * What an edit sends for an item (ADR-0034, #1325): any of its typed fields,
 * the cost as typed (`cost`, which the engine reads into `costMinor`), and
 * the kind the member chose. Never the schedule kind, subtype or status.
 * @typedef {Partial<Omit<CommandItem, "scheduleKind" | "subtype" | "status">> & {
 *   kind?: string, cost?: string,
 * }} ItemEdits
 */

/** @typedef {{ uuid: () => string, now: () => string }} IdSource */

/** @type {IdSource} */
const DEFAULT_IDS = {
  uuid: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
};

/**
 * The activity a command records: its identity, the moment and the details.
 * Never its kind, which the engine names from what the command did (ADR-0034,
 * #1325) and refuses if sent.
 * @param {CommandItem} item
 * @param {Partial<import('./workspace.js').ItemActivity>} details
 * @param {IdSource} ids
 * @returns {Omit<import('./workspace.js').ItemActivity, "kind">}
 */
function activityOf(item, details, ids) {
  return {
    id: ids.uuid(),
    itemId: item.id,
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
 * What happened: the day it was done, the cost (in minor units, or as typed
 * for the engine to read), the notes. Never the next due date -- the engine
 * works that out from the item's period and refuses one sent (ADR-0034,
 * #1324); read it back with dueDateIn.
 * @param {CommandItem} item
 * @param {{ completedDate: string | undefined, costMinor?: number, cost?: string, notes?: string }} fields
 * @param {IdSource} [ids]
 */
export function completeCommand(item, { completedDate, costMinor, cost, notes }, ids = DEFAULT_IDS) {
  return {
    type: "item.complete",
    ...base(item),
    completedDate,
    ...(costMinor !== undefined && costMinor !== null ? { costMinor } : {}),
    ...(cost ? { cost } : {}),
    ...(notes ? { notes } : {}),
    activity: activityOf(item, {
      effectiveDate: completedDate,
      ...(item.dueDate ? { previousDate: item.dueDate } : {}),
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
    activity: activityOf(item, {
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
    activity: activityOf(item, { effectiveDate: snoozedUntil }, ids),
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
    activity: activityOf(item, {}, ids),
  };
}

/**
 * A status change: the status asked for; the engine records whether that
 * restored or cancelled the item (#1325).
 * @param {CommandItem} item
 * @param {string} status
 * @param {IdSource} [ids]
 */
export function statusCommand(item, status, ids = DEFAULT_IDS) {
  return {
    type: "item.status",
    ...base(item),
    status,
    activity: activityOf(item, {}, ids),
  };
}

/**
 * The fields an item's upsert carries — the view-model's joins must never
 * travel, and neither may what the engine decides from the kind: the
 * schedule kind, the subtype and the status (ADR-0034, #1325).
 * @type {(keyof CommandItem)[]}
 */
const ITEM_FIELDS = [
  "id", "sectionId", "title", "provider", "reference", "costMinor",
  "currency", "dueDate", "recurrenceMonths", "reminderDays",
  "snoozedUntil", "notes", "version", "updatedAt",
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
 * An item's edits as `item.upsert`: the item's own fields with the edits
 * over them, the kind chosen beside them. A cost typed in the edits replaces
 * the stored amount (empty clears it), for the engine to read.
 * @param {CommandItem} item
 * @param {ItemEdits} edits
 * @param {IdSource} [ids]
 */
export function upsertCommand(item, edits, ids = DEFAULT_IDS) {
  const { kind, cost, ...fields } = edits;
  const merged = /** @type {CommandItem} */ ({ ...item, ...fields });
  const clean = /** @type {Record<string, unknown>} */ ({});
  for (const field of ITEM_FIELDS) {
    copyItemField(/** @type {CommandItem} */ (clean), merged, field);
  }
  if ("cost" in edits) {
    delete clean.costMinor;
    if (cost !== undefined) clean.cost = cost;
  }
  return {
    type: "item.upsert",
    householdId: item.householdId,
    ...(kind ? { kind } : {}),
    item: clean,
    activity: activityOf(item, {}, ids),
  };
}
