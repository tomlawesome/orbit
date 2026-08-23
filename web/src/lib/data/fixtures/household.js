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
