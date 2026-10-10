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
import { ago, dayMonthYear, initials, plural, tminus } from "$lib/format.js";
import { SHIPPED_SECTION_IDS } from "$lib/marks.js";

/**
 * "3 entries" / "1 entry" — the count printed beside a section in the editor.
 * @param {number} count
 * @returns {string}
 */
export function entriesLabel(count) {
  return plural(count, "entry", "entries");
}

/**
 * The sections editor's rows: the household's own list, each carrying how many
 * entries sit in it. The count is what makes the hidden-not-removed law
 * enforceable in the interface — a section holding entries is not removed
 * quietly: the engine refuses to remove one unless told where its entries go
 * (#1332), so the interface asks where, at the moment of removal.
 *
 * `shipped` (#867) says whether the row's mark is a button: it is decided
 * by the section's id (marks.js's `SHIPPED_SECTION_IDS`), never by what the
 * row happens to be wearing, so a user section saved before this issue —
 * still wearing the never-actually-chosen fallback, "home"/"sage" — gets
 * its swap button immediately rather than staying fixed until some other
 * migration runs. Nothing about a stored icon or accent is rewritten here.
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
      shipped: SHIPPED_SECTION_IDS.has(section.id),
      /* The server's field is `visible`; the interface's word is "shown". A
         section with no `visible` at all is shown — the engine's schema
         requires the flag, so only a degraded payload can reach this. */
      visible: section.visible !== false,
      count,
      /* Entries moved here by a removal not yet saved; the editor raises it
         as it records each pick, so a destination is itself asked when it is
         removed (#1332). Nothing arrives from the server already incoming. */
      incoming: 0,
      /* The law, not a style: `removable` means "goes without asking". An
         empty section does; one holding entries (or about to hold some) is
         asked where they go. */
      removable: count === 0,
    };
  });
}

/**
 * How many entries a section holds or is about to hold: its own, plus those
 * a removal not yet saved sends here.
 * @param {{ count?: number, incoming?: number }} row
 * @returns {number}
 */
export const entriesIn = (row) => (row.count ?? 0) + (row.incoming ?? 0);

/**
 * The chooser's heading (#1332): "where 3 entries go", "where 1 entry goes".
 * @param {number} count
 * @returns {string}
 */
export const whereHeadingOf = (count) => (count === 1 ? "where 1 entry goes" : `where ${count} entries go`);

/**
 * Strike a section out and record where its entries go: the row is marked
 * removed with its destination, and the destination's count rises locally so
 * the landing is seen. Nothing is sent until the list is saved. Returns the
 * status line that says so (role=status).
 * @param {import('./workspace.js').SectionRow[]} rows  the editor's rows (live, mutated)
 * @param {import('./workspace.js').SectionRow} row  the section going
 * @param {string} destinationId
 * @returns {string}
 */
export function moveEntriesAway(rows, row, destinationId) {
  const destination = rows.find((one) => one.id === destinationId);
  if (!destination) return "";
  const moving = entriesIn(row);
  row.removed = true;
  row.moveTo = destinationId;
  destination.incoming = (destination.incoming ?? 0) + moving;
  destination.removable = false;
  return `${row.name.trim() || "Section"} removed · ${plural(moving, "entry", "entries")} ${moving === 1 ? "moves" : "move"} to ${destination.name.trim()} when you save`;
}

/** The most sections the engine's schema will accept in one replace. */
export const MAX_SECTIONS = 12;

/**
 * `sections.replace` — the whole list, every time, because the command
 * replaces the list. Rows are mapped back to the engine's own field names and
 * nothing else travels: the entry counts and the removable flag are the
 * interface's arithmetic, not the household's state.
 *
 * Delete and reassign (#1332): a row struck out while it held entries carries
 * `moveTo`, the section its entries go to, and travels as its own command with
 * `moveItemsTo`. Sections that go without asking (empty) leave in whichever
 * command comes last. Several held drops are several commands in removal
 * order, each list shrinking; a drop whose entries land in another held drop
 * goes first, so a chain (A to B, then B on to C) resolves in order.
 * @param {string} householdId
 * @param {import('./workspace.js').SectionRow[]} rows  every editor row, struck-out ones included
 * @returns {{ type: string, householdId: string, sections: { id: string, name: string, icon: string, accent: string, visible: boolean }[], moveItemsTo?: string }[]}
 */
export function sectionCommandsOf(householdId, rows) {
  const sent = (/** @type {import('./workspace.js').SectionRow} */ row) => ({
    id: row.id,
    name: row.name,
    icon: row.icon,
    accent: row.accent,
    visible: row.visible,
  });
  /** @type {import('./workspace.js').SectionRow[]} */
  const held = [];
  /** @type {Set<string>} */
  const asked = new Set();
  for (const row of rows) {
    if (!row.removed) continue;
    if (row.moveTo) held.push(row);
    else if ((row.count ?? 0) > 0 || (row.incoming ?? 0) > 0) {
      /* Never drop a section holding entries unasked, whatever the screen did. */
      throw new Error(`Choose where the entries in ${row.name || "that section"} go before removing it`);
    } else asked.add(row.id);
  }
  /* A drop whose section receives another drop's entries must wait for it. */
  const order = [];
  const waiting = [...held];
  while (waiting.length) {
    const at = waiting.findIndex((row) => !waiting.some((other) => other !== row && other.moveTo === row.id));
    order.push(...waiting.splice(at === -1 ? 0 : at, 1));
  }
  /** @type {ReturnType<typeof sectionCommandsOf>} */
  const commands = [];
  /* The drops that go unasked are sent first, in a command of their own with
     no moveItemsTo: if one gained an entry since the screen loaded, the engine
     refuses (section_has_items) rather than moving it somewhere unasked. */
  if (asked.size && held.length) {
    commands.push({
      type: "sections.replace",
      householdId,
      sections: rows.filter((one) => !asked.has(one.id) && (!one.removed || held.includes(one))).map(sent),
    });
  }
  const gone = new Set(asked);
  for (const row of order) {
    gone.add(row.id);
    commands.push({
      type: "sections.replace",
      householdId,
      sections: rows.filter((one) => !gone.has(one.id) && (!one.removed || held.includes(one))).map(sent),
      moveItemsTo: row.moveTo,
    });
  }
  if (!commands.length) {
    commands.push({ type: "sections.replace", householdId, sections: rows.filter((one) => !one.removed).map(sent) });
  }
  return commands;
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
 * The open-invitations rows (#481).
 *
 * The address IS the row — an invitation has no display name to stand in for
 * it, because there may be no account behind it — so this is the one place on
 * this screen where an email address is drawn at all. Everything else the row
 * says is a time: when it went, and when it stops working.
 *
 * `sent` is null when the mail could not be handed to the provider, and the
 * screen says so rather than claiming a send: an owner who thinks the mail
 * left will wait for a reply that is never coming.
 *
 * @param {import('./workspace.js').Invitation[]} invitations
 * @param {?string} now   pinned by the caller, never read from the clock here
 * @returns {{ id: string, email: string, sent: ?string, failed: boolean, expires: string }[]}
 */
export function invitationRowsOf(invitations, now) {
  return invitations.map((invitation) => ({
    id: invitation.id,
    email: invitation.email,
    sent: invitation.sentAt && now ? ago(invitation.sentAt, now) : null,
    failed: Boolean(invitation.sendError) || !invitation.sentAt,
    /* A date, not a countdown: "expires 18 Sep 2026" is what an owner can act
       on, and T−14d is not. Short-form month, as the ratified mockup draws it
       — the row's second line is chrome under the address, not a sentence. */
    expires: dayMonthYear(invitation.expiresAt.slice(0, 10)),
  }));
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
 * @property {string} icon    the dial's own legend draws this (#867)
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
      icon: section.icon ?? "home",
      members: members.map((star) => star.id),
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
 * @param {import('./workspace.js').Invitation[]} [params.invitations]
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
  invitations = [],
  today = null,
  now = null,
}) {
  const household = (workspace?.households ?? []).find((one) => one.id === householdId) ?? null;
  if (!household) return null;

  const roster = members.map((member) => ({
    id: member.id,
    name: member.displayName,
    initials: initials(member.displayName),
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
          initials: initials(candidate.displayName),
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
            initials: initials(request.displayName),
            /* "2d ago". `now` is passed in, never read from the clock, so the
               gate holds still and production stays live. */
            waited: now ? ago(request.createdAt, now) : null,
          }))
      : [],
    /* §11's "who sees what" (#481): members see the open invitations too. They
       typed none of them and can change none of them, but a household where an
       owner can quietly add people by mail and nobody else can see it
       happening is not the household this product describes. The route already
       answers every member, so this list is NOT gated on canManage — only the
       controls beside it are. */
    invitations: invitationRowsOf(
      invitations.filter((invitation) => invitation.householdId === householdId),
      now,
    ),
    sections: canManage ? sectionRowsOf(household) : [],
    /* You are a member of this system if you have a row in its roster. An
       instance admin wearing the owner screen has none, and must not be
       offered "leave this system" for a system they were never in. */
    you: roster.find((member) => member.you) ?? null,
    subtitle: canManage
      ? `your system · you own it · ${plural(memberCount, "member")} · ${plural(entries, "entry", "entries")} in orbit`
      : `a system you’re in · ${owner ? `${owner.name} owns it` : "its owner"} · ${plural(memberCount, "member")} · ${plural(entries, "entry", "entries")} in orbit`,
  };
}
