/**
 * THE WALK, AS DATA (#752, slice 2 of #477).
 *
 * The ratified design's own words: "stops being data means a later move of
 * create (#474) or the inbox layout (#472) is a text change, not a rebuild".
 * So everything that differs between one stop and the next lives here — the
 * screen it happens on, what it points at, what it says — and the engine
 * (engine.js) reads this list without knowing a single thing about the walk.
 *
 * A stop's `target` is one CSS selector, and a selector list is still one
 * selector: `querySelectorAll` takes ".dial .chrome, .sun-link" and returns
 * both, which is how the mockup's multi-element stops (design/v19/tour.html,
 * whose STOPS carry a `lit` array of ids) are said here in one field.
 *
 * Every selector a stop names must also appear in `TOUR_REGIONS` for its
 * route: the emphasis mechanism can only lift something it is also able to
 * dim (see emphasis.js). tests/unit/v19-tour-stops.test.mjs pins both that
 * and the fact that every selector exists in the markup it names.
 */

/**
 * @typedef {object} TourStop
 * @property {string} id            stable name, used by tests and the URL of nothing
 * @property {string} route         the screen this stop happens on
 * @property {string} target        CSS selector (or selector list) for what is explained
 * @property {string} [phoneTarget] the same thing in the pocket dialect, where it differs
 * @property {boolean} phone        true if this stop survives the four-stop phone cut
 * @property {boolean} example      true if the example body belongs on this stop
 * @property {[string, string]} copy the two lines, in Orbit's voice
 * @property {string} [exampleCopy] second line used INSTEAD when the example body is drawn
 */

/**
 * The eight stops, in the ratified order (#477, "Ratified design").
 *
 * The copy is the mockup's, verbatim, including stop 7's forward-never-
 * redirect line (the #336 ruling: the tour is one of the places that must say
 * it loudly). Stop 4 is the one place with a second reading, and it carries
 * both: the mockup draws the empty household, where "this one's an example"
 * is true; on a household that already has bodies the tour points at the
 * nearest REAL one, where that sentence would be a lie, so the plain line is
 * the default and the mockup's is the example's own.
 *
 * @type {TourStop[]}
 */
export const TOUR_STOPS = [
  {
    id: "chart",
    route: "/home",
    target: ".dial .chrome, .sun-link",
    phoneTarget: ".mdial, .skies",
    phone: true,
    example: false,
    copy: ["This is your star chart.", "Every sun is a household you belong to."],
  },
  {
    id: "sun",
    route: "/home",
    target: ".sun-link, .minisys",
    phone: false,
    example: false,
    copy: [
      "That's your sun, at centre — your household, always here.",
      "The rest of the sky holds systems you don't belong to, dimmed by distance.",
    ],
  },
  {
    id: "dial",
    route: "/home",
    target: ".dial .chrome, .tour-example",
    phoneTarget: ".mdial",
    phone: true,
    example: true,
    copy: ["Bodies orbit by when they're due.", "The nearer the ring, the sooner."],
  },
  {
    id: "body",
    route: "/home",
    /* The nearest real body (home marks it `#b-closest`) and the belts around
       the bodies that carry documents — or, on a household with nothing on
       it, the example the tour draws instead. */
    target: "#b-closest, .belt, .tour-example",
    phone: false,
    example: true,
    copy: [
      "Every body carries its documents in a belt around it.",
      "The belt is what you have attached to it.",
    ],
    exampleCopy: "This one's an example — car insurance, due in 12 days.",
  },
  {
    id: "manifest",
    route: "/home",
    target: "#manifest-top, .tour-example",
    phone: false,
    example: true,
    copy: [
      "The manifest lists what's ahead, nearest first.",
      "Same law as the dial, read top to bottom instead of round the ring.",
    ],
  },
  {
    id: "inbox",
    route: "/inbox",
    target: ".lane",
    phone: true,
    example: false,
    copy: [
      "Mail lands here first — filed, waiting for review, or still being read.",
      "Nothing joins your orbit without your say-so.",
    ],
  },
  {
    id: "relay",
    route: "/settings/mail",
    target: ".relay-card",
    phone: true,
    example: false,
    copy: [
      "Forward a bill to your relay address and Orbit reads a copy.",
      "Your mail is never redirected — it keeps arriving exactly where it always has.",
    ],
  },
  {
    id: "create",
    route: "/home",
    /*
     * The mockup draws create and settings as two cards on one stage. In the
     * product create is home's own drawer (CON-12: the north star IS its
     * handle) and settings is a screen reached from the account orb, so the
     * last stop points at those two doors — and the walk ends where it began,
     * on the reader's own sky, rather than stranding them on the helm.
     */
    target: "#nstar, button.orb",
    phone: false,
    example: false,
    copy: [
      "Add anything here, by hand or by forwarding a document.",
      "Settings holds your sky, your relay and this walk — take it again anytime.",
    ],
  },
];

/**
 * What can be dimmed, per screen.
 *
 * The mockup marks every dimmable element `data-tour-dim` in its own markup;
 * the product's screens are not the tour's to annotate, so the engine marks
 * them from this list at each stop. The members of a route's list must not
 * contain one another (opacity multiplies down the tree, so a lit child of a
 * dimmed parent is still dim) — which is exactly how the mockup's own marks
 * are placed: siblings inside the dial, never the dial itself.
 *
 * The home list carries both dialects (CON-10, #430): the desk chart and the
 * pocket's `.mdial`/`.mgroup`. Only one of them is ever in the document.
 *
 * @type {Record<string, string[]>}
 */
export const TOUR_REGIONS = {
  "/home": [
    ".dial .chrome",
    ".sun-link",
    ".body-link",
    ".belt",
    ".tour-example",
    ".minisys",
    ".hero-foot",
    "#manifest-top",
    "#nstar",
    ".orb",
    /* the pocket dialect */
    ".mdial",
    ".skies",
    ".msearch",
    ".mgroup",
  ],
  /* The inbox's three lanes, as the mockup dims them, and nothing else. */
  "/inbox": [".lane"],
  /* The relay screen IS the card, so the card is the whole list — the mockup's
     relay scene marks exactly one element too. */
  "/settings/mail": [".relay-card"],
};

/**
 * The stops this viewport walks: all eight on a desk, the ratified four-stop
 * cut on a phone — sky, dial, inbox, relay.
 *
 * @param {{ phone?: boolean }} [options]
 * @returns {TourStop[]}
 */
export function stopsFor({ phone = false } = {}) {
  return phone ? TOUR_STOPS.filter((stop) => stop.phone) : TOUR_STOPS;
}

/**
 * What this stop points at in the dialect being walked.
 *
 * @param {TourStop} stop
 * @param {{ phone?: boolean }} [options]
 * @returns {string}
 */
export function targetOf(stop, { phone = false } = {}) {
  return phone && stop.phoneTarget ? stop.phoneTarget : stop.target;
}

/**
 * The stop's two lines, given whether the example body is on screen.
 *
 * @param {TourStop} stop
 * @param {{ example?: boolean }} [options]
 * @returns {[string, string]}
 */
export function copyOf(stop, { example = false } = {}) {
  return example && stop.exampleCopy ? [stop.copy[0], stop.exampleCopy] : stop.copy;
}
