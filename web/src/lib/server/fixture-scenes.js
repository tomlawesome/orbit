/**
 * Scenes: what one browser asks the fixture app to add to the sample, under
 * `ORBIT_FIXTURES=1` (#1609).
 *
 * The sample workspace is what every pixel screen, the inbox's papers and the
 * sections' counts are measured against, and the fixture routes keep nothing
 * between calls. Two journeys need more than that, and need it where a test's
 * own request interception cannot reach, because home's server load reads the
 * workspace in-process:
 *
 * - `keep-saves`: a real `item.upsert` is kept, so a journey that saves an
 *   item and lands on `/home?item=<id>` finds it, and home opens its row.
 * - `archived-item`: Harlow Home also holds an archived item with one paper
 *   (`/home?item=i-archived`).
 * - `noted-item`: the Car MOT (`i-mot`) carries a note. Not in the sample: an
 *   open i-mot is in a pixel baseline (the item screen), and a note moves it.
 * - `keep-saves` also holds the last `PUT /api/preferences` planet-name days
 *   (#1461) and sky driver (#1462), so the fixture session and home answer
 *   with what a journey set.
 * - `keep-saves` also holds the last `sections.replace` for a household, so a
 *   journey that saves the sections card and then lands on home finds them.
 * - `empty-sky`, `full-sky`, `overfull-sky` (#1611): the reader belongs to no
 *   household and the sky shows 5, 12 or 20 others (the arrival fixtures
 *   `newcomer`, `crowded`, `overfull`). Replaces the households of the sample.
 * - `import-closed` (#1611): Harlow Home is closed to this reader while its
 *   owner brings an archive in (`importInProgress`; unlike the real server's answer it
 *   still carries the sample's sections and items, so a screen that drew them fails).
 *
 * A browser asks by cookie (`orbit-fixture-scenes`, a comma list of names; a
 * rig state sets it, web/tests/fidelity/pocket-states.js). Kept saves live in a
 * second cookie, `orbit-fixture-saved`. Nothing is held in the server process,
 * so parallel tests and the pixel baselines never see each other's items, and
 * a browser that asked for nothing gets the sample workspace unchanged. Only
 * `item.upsert` and `sections.replace` are kept; the cookie holds a few items
 * and drops the oldest past its size.
 *
 * Fixture routes only: every caller runs behind `fixturesRequested()`.
 */
import { scheduleKinds } from "orbit/lib/domain";
import { parseWorkspaceCommand } from "orbit/lib/workspace";

import { ARRIVAL_FIXTURES } from "$lib/data/fixtures/arrival.js";
import {
  ARCHIVED_DOCUMENTS_FIXTURE,
  ARCHIVED_ITEM_FIXTURE,
  DOCUMENTS_FIXTURE,
  IMPORT_CLOSED_HOUSEHOLD_FIXTURE,
  PROVING_DOCUMENTS_FIXTURE,
  WORKSPACE_FIXTURE,
} from "$lib/data/fixtures/workspace.js";

export const SCENES_COOKIE = "orbit-fixture-scenes";
export const SAVED_COOKIE = "orbit-fixture-saved";
export const SECTIONS_COOKIE = "orbit-fixture-sections";
export const LABEL_DAYS_COOKIE = "orbit-fixture-label-days";
export const SKY_DRIVER_COOKIE = "orbit-fixture-sky-driver";
/** #1463 */
export const PLANET_SIZE_COOKIE = "orbit-fixture-planet-size";
export const OFFER_DISMISSED_COOKIE = "orbit-fixture-importance-offer-dismissed";
export const MOT_NOTES = "Book the early slot.";

/* A cookie is one name=value of at most ~4 KB once encoded. */
const SAVED_MAX_CHARS = 1200;
const SAVED_MAX_ITEMS = 5;
const SECTIONS_MAX_CHARS = 2400;

/** The scenes a browser can ask for. */
/** @typedef {"keep-saves" | "archived-item" | "noted-item" | "empty-sky" | "full-sky" | "overfull-sky" | "import-closed"} Scene */

/** The sky scenes, each the arrival fixture that draws it. */
const SKIES = /** @type {const} */ ({ "empty-sky": "newcomer", "full-sky": "crowded", "overfull-sky": "overfull" });

/** @typedef {import("@sveltejs/kit").Cookies} Cookies */

/**
 * Whether this browser asked for `scene`.
 * @param {Pick<Cookies, "get">} cookies
 * @param {Scene} scene
 */
function asked(cookies, scene) {
  return (cookies.get(SCENES_COOKIE) ?? "").split(",").includes(scene);
}

/**
 * The items this browser has saved, as `{ householdId, item }`; a missing or
 * damaged cookie is none.
 * @param {Pick<Cookies, "get">} cookies
 * @returns {{ householdId: string, item: Record<string, any> }[]}
 */
function savedOf(cookies) {
  if (!asked(cookies, "keep-saves")) return [];
  try {
    const held = JSON.parse(cookies.get(SAVED_COOKIE) ?? "[]");
    return Array.isArray(held) ? held : [];
  } catch {
    return [];
  }
}

/**
 * The sections this browser last saved, with the household they belong to; a
 * missing or damaged cookie is none.
 * @param {Pick<Cookies, "get">} cookies
 * @returns {{ householdId: string, sections: Record<string, any>[] } | null}
 */
function sectionsOf(cookies) {
  if (!asked(cookies, "keep-saves")) return null;
  try {
    const held = JSON.parse(cookies.get(SECTIONS_COOKIE) ?? "null");
    return held && typeof held.householdId === "string" && Array.isArray(held.sections) ? held : null;
  } catch {
    return null;
  }
}

/**
 * The planet-name days this browser last saved (#1461), or null when it has
 * saved none (or did not ask for `keep-saves`): the session then answers its
 * default.
 * @param {Pick<Cookies, "get">} cookies
 * @returns {number | null}
 */
export function labelDaysOf(cookies) {
  if (!asked(cookies, "keep-saves")) return null;
  const held = Number(cookies.get(LABEL_DAYS_COOKIE));
  return Number.isInteger(held) && held >= 0 && held <= 365 && cookies.get(LABEL_DAYS_COOKIE) !== "" ? held : null;
}

/**
 * Remembers the last saved planet-name days for a browser that asked for
 * `keep-saves`; any other browser keeps nothing.
 * @param {Cookies} cookies
 * @param {number} labelDays  already checked by the preference schema
 */
export function keepLabelDays(cookies, labelDays) {
  if (!asked(cookies, "keep-saves")) return;
  cookies.set(LABEL_DAYS_COOKIE, String(labelDays), { path: "/", httpOnly: true, sameSite: "lax", secure: false });
}

/**
 * The sky driver this browser last saved (#1462), or null when it has saved
 * none (or did not ask for `keep-saves`): the session then answers "due".
 * @param {Pick<Cookies, "get">} cookies
 * @returns {"due" | "warning" | null}
 */
export function skyDriverOf(cookies) {
  if (!asked(cookies, "keep-saves")) return null;
  const held = cookies.get(SKY_DRIVER_COOKIE);
  return held === "due" || held === "warning" ? held : null;
}

/**
 * Remembers the last saved sky driver for a browser that asked for
 * `keep-saves`; any other browser keeps nothing.
 * @param {Cookies} cookies
 * @param {"due" | "warning"} skyDriver  already checked by the preference schema
 */
export function keepSkyDriver(cookies, skyDriver) {
  if (!asked(cookies, "keep-saves")) return;
  cookies.set(SKY_DRIVER_COOKIE, skyDriver, { path: "/", httpOnly: true, sameSite: "lax", secure: false });
}

/**
 * The planet size this browser last saved (#1463), or null when it has saved
 * none (or did not ask for `keep-saves`): the session then answers "cost".
 * @param {Pick<Cookies, "get">} cookies
 * @returns {"cost" | "importance" | null}
 */
export function planetSizeOf(cookies) {
  if (!asked(cookies, "keep-saves")) return null;
  const held = cookies.get(PLANET_SIZE_COOKIE);
  return held === "cost" || held === "importance" ? held : null;
}

/**
 * Remembers the last saved planet size for a browser that asked for
 * `keep-saves`; any other browser keeps nothing.
 * @param {Cookies} cookies
 * @param {"cost" | "importance"} planetSize  already checked by the preference schema
 */
export function keepPlanetSize(cookies, planetSize) {
  if (!asked(cookies, "keep-saves")) return;
  cookies.set(PLANET_SIZE_COOKIE, planetSize, { path: "/", httpOnly: true, sameSite: "lax", secure: false });
}

/**
 * Whether this browser dismissed the one-time importance pass (#1463): true
 * once saved, null when it saved none (or did not ask for `keep-saves`).
 * @param {Pick<Cookies, "get">} cookies
 * @returns {boolean | null}
 */
export function importanceOfferDismissedOf(cookies) {
  if (!asked(cookies, "keep-saves")) return null;
  const held = cookies.get(OFFER_DISMISSED_COOKIE);
  return held === "true" ? true : held === "false" ? false : null;
}

/**
 * Remembers the dismissal for a browser that asked for `keep-saves`.
 * @param {Cookies} cookies
 * @param {boolean} dismissed  already checked by the preference schema
 */
export function keepImportanceOfferDismissed(cookies, dismissed) {
  if (!asked(cookies, "keep-saves")) return;
  cookies.set(OFFER_DISMISSED_COOKIE, String(dismissed), { path: "/", httpOnly: true, sameSite: "lax", secure: false });
}

/**
 * The stored item an `item.upsert` makes, as the engine would send it back:
 * active, at its first version, with the schedule its kind and date imply.
 * An importance the save leaves out stays what the item had (#1463): the
 * level an earlier save kept, else the sample's, else not set.
 * @param {{ householdId: string, kind?: string, item: Record<string, any> }} command
 * @param {?string} [before]  the importance the item held before this save
 */
function storedItem(command, before = null) {
  const { recurrenceMonths, ...item } = command.item;
  const scheduled = command.kind && item.dueDate && /** @type {readonly string[]} */ (scheduleKinds).includes(command.kind);
  return {
    ...item,
    ...(scheduled
      ? { scheduleKind: command.kind, subtype: command.kind, ...(recurrenceMonths > 0 && command.kind !== "expiry" ? { recurrenceMonths } : {}) }
      : {}),
    kind: command.kind ?? null,
    importance: item.importance ?? before ?? null,
    status: "active",
    version: 1,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Remembers a real `item.upsert`, or the last `sections.replace`, for a
 * browser that asked for `keep-saves`.
 * Anything else, and anything the engine's own parse would refuse, is left
 * alone.
 * @param {Cookies} cookies
 * @param {unknown} body  the command as the browser sent it
 */
export function keepSave(cookies, body) {
  if (!asked(cookies, "keep-saves")) return;
  let command;
  try {
    command = parseWorkspaceCommand(body);
  } catch {
    return;
  }
  if (command.type === "sections.replace") {
    const value = JSON.stringify({ householdId: command.householdId, sections: command.sections });
    if (value.length <= SECTIONS_MAX_CHARS) cookies.set(SECTIONS_COOKIE, value, { path: "/", httpOnly: true, sameSite: "lax", secure: false });
    return;
  }
  if (command.type !== "item.upsert") return;
  const saved = savedOf(cookies);
  /** @type {{ importance?: ?string } | undefined} */
  const earlier = saved.find((one) => one.item.id === command.item.id)?.item
    ?? WORKSPACE_FIXTURE.households.flatMap((household) => /** @type {any[]} */ (household.items)).find((one) => one.id === command.item.id);
  const kept = saved.filter((one) => one.item.id !== command.item.id);
  kept.push({ householdId: command.householdId, item: storedItem(command, earlier?.importance ?? null) });
  let value = JSON.stringify(kept.slice(-SAVED_MAX_ITEMS));
  while (value.length > SAVED_MAX_CHARS && kept.length > 1) {
    kept.shift();
    value = JSON.stringify(kept);
  }
  cookies.set(SAVED_COOKIE, value, { path: "/", httpOnly: true, sameSite: "lax", secure: false });
}

/**
 * The fixture workspace as this browser's scenes make it: its saved items in
 * their households (a re-saved item replaces its earlier self), the archived
 * item in Harlow Home, the Car MOT's note, a closed Harlow Home, or a whole other
 * sky. No scene, no change: the same object comes back.
 * @template {{ households: { id: string, items: any[], sections?: any[] }[] }} W
 * @param {W} workspace
 * @param {Pick<Cookies, "get">} cookies
 * @returns {W}
 */
export function withScenes(workspace, cookies) {
  for (const [scene, key] of Object.entries(SKIES)) {
    if (asked(cookies, /** @type {Scene} */ (scene))) return /** @type {W} */ (/** @type {unknown} */ ({ ...workspace, ...ARRIVAL_FIXTURES[key] }));
  }
  /** @type {{ householdId: string, item: Record<string, any> }[]} */
  const extra = [...savedOf(cookies)];
  if (asked(cookies, "archived-item")) extra.push({ householdId: "hh-harlow-1", item: ARCHIVED_ITEM_FIXTURE });
  const noted = asked(cookies, "noted-item");
  const closed = asked(cookies, "import-closed");
  const sections = sectionsOf(cookies);
  if (!extra.length && !noted && !closed && !sections) return workspace;
  return {
    ...workspace,
    households: workspace.households.map((household) => {
      if (closed && household.id === IMPORT_CLOSED_HOUSEHOLD_FIXTURE.id) return /** @type {typeof household} */ (/** @type {unknown} */ (IMPORT_CLOSED_HOUSEHOLD_FIXTURE));
      if (sections?.householdId === household.id) household = { ...household, sections: sections.sections };
      if (noted) household = { ...household, items: household.items.map((item) => (item.id === "i-mot" ? { ...item, notes: MOT_NOTES } : item)) };
      const mine = extra.filter((one) => one.householdId === household.id).map((one) => one.item);
      if (!mine.length) return household;
      const ids = new Set(mine.map((item) => item.id));
      return { ...household, items: [...household.items.filter((item) => !ids.has(item.id)), ...mine] };
    }),
  };
}

/**
 * The papers of an item, for the documents route: the sample's and the
 * proving papers', and the archived item's for a browser that asked for it.
 * @param {string} itemId
 * @param {Pick<Cookies, "get">} cookies
 */
export function documentsOf(itemId, cookies) {
  if (itemId === ARCHIVED_ITEM_FIXTURE.id && asked(cookies, "archived-item")) return ARCHIVED_DOCUMENTS_FIXTURE;
  return [...(DOCUMENTS_FIXTURE[itemId] ?? []), ...(PROVING_DOCUMENTS_FIXTURE[itemId] ?? [])];
}
