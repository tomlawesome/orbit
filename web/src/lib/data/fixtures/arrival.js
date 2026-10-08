/**
 * THE ARRIVAL'S FIXTURES (#410, §15).
 *
 * The newcomer's arrival is a state the workspace fixture cannot be in — it
 * has households, and this has none — so the harness carries its own, in the
 * shape `GET /api/workspace` really answers with on the choose branch (§11, #453: `householdLanding: "choose"`, `households`
 * empty, `visibleHouseholds` the whole instance).
 *
 * DETERMINISTIC BY CONSTRUCTION. The ids are fixed, so `constellationPosOf`
 * puts every constellation on the same bearing every run and `placeGalaxy`
 * hands back the same sky; the names are design/v19/first-run.html's own five,
 * so the count reads 5 as the sheet's does and the labels read what the sheet's
 * read. The one already asked is the sheet's own (`Mum & Dad's`), because the
 * waiting note on a constellation and the WAITING row in the card are both
 * ratified states that have to be photographable.
 *
 * Reachable only through the fixture flag: see the front door's +page.server.js.
 */

/** The newcomer: nothing of theirs, five systems out there. */
export const NEWCOMER_ARRIVAL_FIXTURE = {
  version: 1,
  householdLanding: "choose",
  activeHouseholdId: null,
  households: [],
  recoverableHouseholds: [],
  visibleHouseholds: [
    { id: "hh-lawson-1", name: "Lawson Home", requested: false },
    { id: "hh-seaside-4551", name: "Seaside Cottage", requested: false },
    { id: "hh-mumdad-3", name: "Mum & Dad’s", requested: true },
    { id: "hh-narrowboat-7", name: "The Narrowboat", requested: false },
    { id: "hh-grans-9", name: "Gran’s Flat", requested: false },
  ],
};

/* #1263: no `create` fixture any more. The create questions are the belong
   card's drawer, photographed as `?arrival=newcomer&drawer=1`. */
export const ARRIVAL_FIXTURES = {
  newcomer: NEWCOMER_ARRIVAL_FIXTURE,
};
