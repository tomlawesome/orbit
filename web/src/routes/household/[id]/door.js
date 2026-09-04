/**
 * WHICH DOOR YOU CAME IN BY (§15, owner ruling 2026-08-17).
 *
 * The household screen has two doors and the way back must be the way you
 * came:
 *
 *   · the helm — settings' memberships card, "Your systems" → a row → manage —
 *     and the way back reads "← SETTINGS", as it always has;
 *   · the SUN at the centre of the dial (ce86c7e, "the sun is a door"), and the
 *     way back reads "← YOUR SKY" and returns to /home.
 *
 * Sending a reader who clicked the sun back to a settings page they were never
 * on is the kind of small lie that makes an interface feel like software rather
 * than a place.
 *
 * HOW IT KNOWS. The same one-shot marker the family already uses twice — the
 * launch signal (lib/flight/arrival.js) and the old dashboard's
 * `settings-return-focus` — because it is the honest signal available: a
 * navigation carries nothing else that distinguishes two links to one address,
 * and the alternatives are worse. A query string (`?from=sky`) would be
 * bookmarked, shared and refreshed, so a URL somebody sent you would claim you
 * came through a door you never touched. `document.referrer` is absent on
 * plenty of navigations and lies on others.
 *
 * THE RULES, and each one is a decision:
 *
 *   · WRITTEN AT THE DOOR that is not the default. Only the sun marks; the helm
 *     writes nothing, because the helm is what absence means.
 *   · READ ONCE, and deleted in the same breath (consumeLaunch's rule). So a
 *     refresh, a Back into this screen, or a later visit typed into the bar all
 *     read the default — a marker that outlived its own journey would start
 *     answering for journeys it knows nothing about.
 *   · DEFAULT IS THE HELM. A deep link, a bookmark, an instance admin arriving
 *     from the dial (§15-2i), storage denied outright: all of them get
 *     "← SETTINGS", which is the door that was ratified before this ruling.
 *   · A CLICK, NOT A KEY. Reading the marker changes one label and one href, so
 *     keyboard focus, Enter, Back and new-tab behaviour are exactly what the
 *     anchor already gave them.
 *
 * The one edge worth writing down: a ctrl-click on the sun opens the household
 * in a NEW tab, which in Chromium inherits a copy of this tab's session
 * storage, so the new tab reads the sky door correctly — and this tab is left
 * holding a marker its own journey never spent. The next arrival here in THIS
 * tab would read "← YOUR SKY" once, and then never again. A wrong label on one
 * visit is the whole cost, and it is cheaper than a lie in a URL.
 */

/** Namespaced like the launch marker, so two features cannot collide. */
export const DOOR_KEY = "orbit-household-door";

/**
 * The doors, and what the way back says at each. `current` is what the account
 * card's nav marks as the journey you are in.
 */
export const DOORS = {
  settings: { name: "settings", href: "/settings", label: "← SETTINGS" },
  sky: { name: "sky", href: "/home", label: "← YOUR SKY" },
};

/** The door absence means: the helm, which is where this screen hangs (§15-2k). */
export const DEFAULT_DOOR = DOORS.settings;

/** @param {Storage | null | undefined} [given] @returns {Storage | null} */
function store(given) {
  if (given) return given;
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    /* Storage can be denied outright. The way back is never a gate: it falls
       to the default door and the screen works exactly as before. */
    return null;
  }
}

/**
 * Written by a door as the reader steps through it.
 * @param {keyof typeof DOORS} name
 * @param {Storage | null} [storage]
 */
export function markDoor(name, storage) {
  const door = DOORS[name];
  const s = store(storage);
  if (!door || !s) return false;
  try {
    s.setItem(DOOR_KEY, door.name);
    return true;
  } catch {
    return false;
  }
}

/**
 * The door this arrival came through, taken away as it is read.
 * @param {Storage | null} [storage]
 */
export function consumeDoor(storage) {
  const s = store(storage);
  if (!s) return DEFAULT_DOOR;
  try {
    const name = s.getItem(DOOR_KEY);
    if (name !== null) s.removeItem(DOOR_KEY);
    return DOORS[/** @type {keyof typeof DOORS} */ (name)] ?? DEFAULT_DOOR;
  } catch {
    return DEFAULT_DOOR;
  }
}
