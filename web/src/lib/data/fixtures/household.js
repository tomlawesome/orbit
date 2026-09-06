/**
 * The rosters `GET /api/households/{householdId}/members` answers (#410),
 * in that route's exact shape: `{ members, candidates }`.
 *
 * Members carry `{ id, displayName, avatarUrl, role }` — the HouseholdMember
 * projection in src/server/workspace-repository.ts — and candidates carry
 * `{ id, displayName, avatarUrl }`. No email address appears in either,
 * because the route deliberately never discloses one: this screen shows
 * people by the name they chose.
 *
 * Ordering mirrors the route's: members by membership creation, so the owner
 * heads the list they founded.
 *
 * The values are design/v19/household-manage.html's own — Tom's four in
 * Lawson Home, Emma's three in Seaside Cottage — so the fidelity gate
 * measures the port rather than a difference of data.
 *
 * TWO KNOWN DIVERGENCES FROM THE ROUTE, recorded rather than papered over:
 *
 *  1. `listRegisteredUserCandidates` orders by displayName ascending, so a
 *     live instance would list Ada Reid before Ben Lawson. The mockup drew
 *     Ben first and the gate compares against the mockup, so the fixture
 *     keeps the mockup's order. The screen itself does not sort — it renders
 *     the order the route hands it — so production is unaffected.
 *  2. Ben Lawson and Ada Reid are not in ADMIN_USERS_FIXTURE. On a real
 *     instance every candidate is a registered account and would appear on
 *     administration too; adding them there would move a screen the owner has
 *     already ratified, so they live here alone.
 */

const AVATARS = null;

/**
 * Typed as the route's own projection (HouseholdMember in
 * src/server/workspace-repository.ts) rather than workspace.js's `Member`,
 * which has no `avatarUrl` and requires a `role` candidates never carry.
 * @typedef {{ id: string, displayName: string, avatarUrl: ?string }} FixtureCandidate
 * @type {Record<string, { members: (FixtureCandidate & { role: string })[], candidates: FixtureCandidate[] }>}
 */
export const MEMBERS_FIXTURE = {
  /* Lawson Home — Tom owns it, and the mockup's owner state is drawn from
     exactly these four. */
  "hh-lawson-1": {
    members: [
      { id: "u-fixture", displayName: "Tom Lawson", avatarUrl: AVATARS, role: "owner" },
      { id: "u-emma", displayName: "Emma Lawson", avatarUrl: AVATARS, role: "member" },
      { id: "u-rob", displayName: "Rob Lawson", avatarUrl: AVATARS, role: "member" },
      { id: "u-gran", displayName: "Gran", avatarUrl: AVATARS, role: "member" },
    ],
    candidates: [
      { id: "u-ben", displayName: "Ben Lawson", avatarUrl: AVATARS },
      { id: "u-ada", displayName: "Ada Reid", avatarUrl: AVATARS },
    ],
  },
  /* Seaside Cottage — Emma owns it and Tom is only a member, which is the
     mockup's non-owner state. The route answers NO candidates to someone who
     may not add anyone, so this list is empty by contract, not by omission. */
  "hh-seaside-4551": {
    members: [
      { id: "u-emma", displayName: "Emma Lawson", avatarUrl: AVATARS, role: "owner" },
      { id: "u-fixture", displayName: "Tom Lawson", avatarUrl: AVATARS, role: "member" },
      { id: "u-rob", displayName: "Rob Lawson", avatarUrl: AVATARS, role: "member" },
    ],
    candidates: [],
  },
  "hh-mumdad-2480": {
    members: [
      { id: "u-sue", displayName: "Sue Lawson", avatarUrl: AVATARS, role: "owner" },
      { id: "u-fixture", displayName: "Tom Lawson", avatarUrl: AVATARS, role: "member" },
    ],
    candidates: [],
  },
  "hh-narrow-15033": {
    members: [
      { id: "u-rob", displayName: "Rob Lawson", avatarUrl: AVATARS, role: "owner" },
    ],
    candidates: [],
  },
  "hh-grans-1307": {
    members: [
      { id: "u-emma", displayName: "Emma Lawson", avatarUrl: AVATARS, role: "owner" },
      { id: "u-fixture", displayName: "Tom Lawson", avatarUrl: AVATARS, role: "member" },
    ],
    candidates: [],
  },
};

/**
 * The open invitations `GET /api/households/{householdId}/invitations`
 * answers (#481), in that route's exact shape.
 *
 * The primary household holds the one seat the ratified mockup draws, address
 * and dates included, because the round-2 verdict made the held seat part of
 * the design rather than an empty state with a caption: a fixture without it
 * would photograph a block the design does not have. The address is the
 * mockup's own, on the reserved documentation domain — a placeholder, never a
 * deliverable address — and it is the one address this screen shows anywhere.
 *
 * The dates are the strings the mockup prints, read against the fixture clock
 * (`fixtureToday`, 2026-08-13 noon): sent two days before it, expiring on the
 * mockup's date. Nothing on the screen claims an interval between them, so
 * there is nothing for them to contradict.
 *
 * @type {Record<string, { id: string, householdId: string, email: string, createdAt: string, sentAt: string | null, sendError: string | null, expiresAt: string }[]>}
 */
export const INVITATIONS_FIXTURE = {
  "hh-lawson-1": [
    {
      id: "inv-fixture-1",
      householdId: "hh-lawson-1",
      email: "daniel.lawson@example.com",
      createdAt: "2026-08-11T12:00:00.000Z",
      sentAt: "2026-08-11T12:00:00.000Z",
      sendError: null,
      expiresAt: "2026-09-18T12:00:00.000Z",
    },
  ],
  "hh-seaside-4551": [],
  "hh-mumdad-2480": [],
  "hh-narrow-15033": [],
  "hh-grans-1307": [],
};
