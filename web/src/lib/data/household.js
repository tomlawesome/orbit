/**
 * Household management's pure transforms (#410, §15).
 *
 * The seam (workspace.js readHouseholdScreen) does the fetching; everything
 * that turns four API payloads into the screen's words lives here, pure and
 * unit-tested, so the contract is pinned in tests/unit rather than discovered
 * in a container run — the commands.js precedent.
 *
 * Nothing here invents server behaviour. Where the mockup drew something no
 * route can answer, the transform says so in the shape it returns rather than
 * filling the hole with a plausible value.
 */

import { bandOf, bodySize, daysUntil, dialPlacement } from "$lib/data/chart.js";
import { ago, tminus } from "$lib/format.js";

/**
 * Two letters from a chosen display name — never from an email address, which
 * this screen's routes deliberately never disclose.
 * @param {?string} [name]
 * @returns {string}
 */
export function initialsOf(name) {
  return (name ?? "")
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase() || "·";
}

/**
 * @param {number} count
 * @param {string} word
 * @returns {string}
 */
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * "3 entries" / "1 entry" — the count printed beside a section in the editor.
 * @param {number} count
 * @returns {string}
 */
export function entriesLabel(count) {
  return `${count} ${count === 1 ? "entry" : "entries"}`;
}

/**
 * The sections editor's rows: the household's own list, each carrying how many
 * entries sit in it. The count is what makes the hidden-not-removed law
 * enforceable in the interface — a section holding entries has no × at all,
 * because sections.replace would re-file its items under the first surviving
 * section and the reader never asked for that.
 * @param {import('./workspace.js').Household | null} [household]
 * @returns {import('./workspace.js').SectionRow[]}
 */
export function sectionRowsOf(household) {
  const items = (household?.items ?? []).filter((item) => item.status !== "archived");
  return (household?.sections ?? []).map((section) => {
    const count = items.filter((item) => item.sectionId === section.id).length;
    return {
      id: section.id,
      name: section.name,
      icon: section.icon ?? "home",
      accent: section.accent ?? "sage",
      /* The server's field is `visible`; the interface's word is "shown". A
         section with no `visible` at all is shown — the engine's schema
         requires the flag, so only a degraded payload can reach this. */
      visible: section.visible !== false,
      count,
      /* The law, not a style: emptiness is the ONLY thing that earns a ×. */
      removable: count === 0,
    };
  });
}

/** The most sections the engine's schema will accept in one replace. */
export const MAX_SECTIONS = 12;

/**
 * `sections.replace` — the whole list, every time, because the command
 * replaces the list. Rows are mapped back to the engine's own field names and
 * nothing else travels: the entry counts and the removable flag are the
 * interface's arithmetic, not the household's state.
 * @param {string} householdId
 * @param {import('./workspace.js').SectionRow[]} rows
 * @returns {{ type: string, householdId: string, sections: { id: string, name: string, icon: string, accent: string, visible: boolean }[] }}
 */
export function sectionsCommandOf(householdId, rows) {
  return {
    type: "sections.replace",
    householdId,
    sections: rows.map((row) => ({
      id: row.id,
      name: row.name,
      icon: row.icon,
      accent: row.accent,
      visible: row.visible,
    })),
  };
}

/**
 * `household.update` — the bundle, always whole (2c).
 *
 * Three fields wear three saves TO THE EYE. Underneath, one command carries
 * name + time zone + currency together, because that is the only shape the
 * route accepts: a per-field save simply submits the bundle with the other two
 * values as they stand. The split is a courtesy to the person, not a change to
 * the protocol.
 * @param {string} householdId
 * @param {{ name?: ?string, timezone?: string, currency?: string }} fields
 * @returns {{ type: string, householdId: string, name: string, timezone?: string, currency?: string }}
 */
export function householdUpdateCommandOf(householdId, { name, timezone, currency }) {
  return {
    type: "household.update",
    householdId,
    name: (name ?? "").trim(),
    timezone,
    currency,
  };
}

/**
 * Whether a typed name unlocks the deletion request.
 *
 * The client's test is a courtesy — the SERVER compares the exact name and is
 * the only authority — so this is deliberately the same comparison the route
 * makes (`confirmation` against the stored name) and not a friendlier one: a
 * button that wakes on a name the server will reject is a worse lie than a
 * button that stays asleep.
 * @param {?string} [typed]
 * @param {?string} [householdName]
 * @returns {boolean}
 */
export function deletionNameMatches(typed, householdName) {
  const target = (householdName ?? "").trim();
  return target.length > 0 && (typed ?? "").trim() === target;
}

/**
 * One entry's star in the household's own constellation (§15 H2).
 *
 * @typedef {object} ConstellationMark
 * @property {string} id
 * @property {string} title
 * @property {?string} sectionId
 * @property {?string} accent
 * @property {number} days
 * @property {string} tag
 * @property {string} band
 * @property {number} dx
 * @property {number} dy
 * @property {number} halo
 */

/**
 * The line joining one section's stars, when it holds more than one.
 *
 * @typedef {object} ConstellationFigure
 * @property {string} id
 * @property {string} name
 * @property {?string} accent
 * @property {string[]} members
 */

/**
 * THE SYSTEM YOU ARE STANDING IN (§15 H2 — "inside this system").
 *
 * Everywhere else in Orbit this household is a distant mark: a 40px ring with
 * three dots on it, out in someone's sky. On its own management screen you are
 * INSIDE that mark, so the backdrop is the same figure at room scale — and
 * every star in it is one of the household's entries, placed by the dial law
 * out of chart.js: the same pure functions the home screen's chart is drawn
 * with, never a copy of them.
 *
 *   angle° = daysUntilDue − 90,  radius = 62 + 0.242·days
 *   (overdue falls inward at 0.625/day),  halo = bodySize(costMinor),
 *   tone = the chart key's urgency band.
 *
 * What travels is the OFFSET from the dial's own centre, in dial units, rather
 * than a screen coordinate: where the household is drawn is the room's business
 * (room.js), and how far each entry sits from its sun is the law's.
 *
 * The figures joining the stars are the SECTIONS (§15-2b): a section's entries
 * joined in date order in that section's own accent. A section holding one
 * entry is a lone star with no line to anyone; a section holding none is not in
 * the sky at all. Count the stars on a figure and you have read the sections
 * card beside you.
 * @param {import('./workspace.js').Household | null} [household]
 * @param {?string} [today]
 * @returns {{ marks: ConstellationMark[], figures: ConstellationFigure[] }}
 */
export function constellationOf(household, today) {
  /* No today, no sky: an undated room is better than one drawn from NaN. */
  if (!today) return { marks: [], figures: [] };
  const accents = new Map((household?.sections ?? []).map((section) => [section.id, section]));
  /** @type {ConstellationMark[]} */
  const marks = [];
  for (const item of household?.items ?? []) {
    if (item.status !== "active" || !item.dueDate) continue;
    const days = daysUntil(item.dueDate, today);
    if (days === null) continue;
    const { angle, radius } = dialPlacement(days);
    marks.push({
      id: item.id,
      title: item.title,
      sectionId: item.sectionId ?? null,
      accent: accents.get(item.sectionId)?.accent ?? null,
      days,
      /* The same string every other screen prints on the same body. */
      tag: tminus(item.dueDate, today),
      band: bandOf(days),
      dx: Math.cos(angle) * radius,
      dy: Math.sin(angle) * radius,
      halo: bodySize(item.costMinor),
    });
  }
  /* Lead time, then id: the sky cannot depend on the order the API answered
     in, and the closest thing is drawn — and lettered — first. */
  marks.sort((a, b) => a.days - b.days || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  /** @type {ConstellationFigure[]} */
  const figures = [];
  for (const section of household?.sections ?? []) {
    const members = marks.filter((mark) => mark.sectionId === section.id);
    if (members.length < 2) continue;
    figures.push({
      id: section.id,
      name: section.name,
      accent: section.accent ?? null,
      members: members.map((mark) => mark.id),
    });
  }
  return { marks, figures };
}

/**
 * Everything the screen renders, from the payloads their routes answer.
 *
 * `members` is the truth about who is in the system — the workspace's
 * `memberCount` is a summary written for other screens, and where the two
 * disagree the roster wins because it is the thing being edited here.
 *
 * `canManage` decides which of the two states is drawn, and it is the
 * workspace's own flag rather than a role read off the roster: an instance
 * admin holding owner powers over a household they are not a member of has no
 * row in that roster (§15-2i, one screen, one drawing).
 * @param {object} params
 * @param {import('./workspace.js').Workspace | null} [params.workspace]
 * @param {string} params.householdId
 * @param {import('./workspace.js').SessionUser | null} [params.user]
 * @param {import('./workspace.js').Member[]} [params.members]
 * @param {import('./workspace.js').Member[]} [params.candidates]
 * @param {import('./workspace.js').JoinRequest[]} [params.joinRequests]
 * @param {?string} [params.today]
 * @param {?string} [params.now]
 */
export function householdScreenOf({
  workspace,
  householdId,
  user = null,
  members = [],
  candidates = [],
  joinRequests = [],
  today = null,
  now = null,
}) {
  const household = (workspace?.households ?? []).find((one) => one.id === householdId) ?? null;
  if (!household) return null;

  const roster = members.map((member) => ({
    id: member.id,
    name: member.displayName,
    initials: initialsOf(member.displayName),
    role: member.role,
    you: Boolean(user?.id) && member.id === /** @type {import('./workspace.js').SessionUser} */ (user).id,
  }));
  const owner = roster.find((member) => member.role === "owner") ?? null;
  const canManage = Boolean(household.canManage);
  const entries = (household.items ?? []).filter((item) => item.status !== "archived").length;
  /* The roster is the count when it answered; the workspace's summary is the
     honest fallback when the members route could not be reached. */
  const memberCount = roster.length || household.memberCount || 0;

  return {
    id: household.id,
    name: household.name,
    timezone: household.timezone ?? "UTC",
    currency: household.currency ?? "GBP",
    canManage,
    user,
    today,
    /* Whether this is the system the sky is drawn around: the header ring
       wears a lit core for your own, an unlit one for a system you visit —
       the same distinction administration's roster makes. */
    primary: workspace?.activeHouseholdId === householdId,
    /* The ring's dots are the household's REAL due states (§12: nothing on it
       is decoration), so the items travel to the renderer unchanged. */
    items: household.items ?? [],
    /* The backdrop: this household's own constellation, at room scale, behind
       the cards (§15 H2). Placed by the dial law here; composed by room.js. */
    constellation: constellationOf(household, today),
    entries,
    memberCount,
    owner,
    roster,
    /* Registered accounts only, and only for someone who may add them — the
       route hands back an empty list to everybody else, which is the same
       shape as "there is nobody left to add" and is drawn the same way. */
    candidates: canManage
      ? candidates.map((candidate) => ({
          id: candidate.id,
          name: candidate.displayName,
          initials: initialsOf(candidate.displayName),
        }))
      : [],
    /* §15-2g: joiners are answered HERE and nowhere else. The route answers
       every request the caller may decide, across every household they own,
       so the screen keeps only its own. */
    joinRequests: canManage
      ? joinRequests
          .filter((request) => request.householdId === householdId)
          .map((request) => ({
            id: request.id,
            userId: request.userId,
            name: request.displayName,
            initials: initialsOf(request.displayName),
            /* "2d ago". `now` is passed in, never read from the clock, so the
               gate holds still and production stays live. */
            waited: now ? ago(request.createdAt, now) : null,
          }))
      : [],
    sections: canManage ? sectionRowsOf(household) : [],
    /* You are a member of this system if you have a row in its roster. An
       instance admin wearing the owner screen has none, and must not be
       offered "leave this system" for a system they were never in. */
    you: roster.find((member) => member.you) ?? null,
    subtitle: canManage
      ? `your system · you own it · ${plural(memberCount, "member")} · ${entries} ${entries === 1 ? "entry" : "entries"} in orbit`
      : `a system you’re in · ${owner ? `${owner.name} owns it` : "its owner"} · ${plural(memberCount, "member")} · ${entries} ${entries === 1 ? "entry" : "entries"} in orbit`,
  };
}
