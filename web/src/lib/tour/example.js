/**
 * THE EXAMPLE BODY (#752; ratified on #477, 2026-09-02).
 *
 * Owner: "it's not a very good tour if you can't see what things look like."
 * On a household with nothing on it, stops 3–5 have nothing to point at, so
 * the tour draws ONE body — dashed, labelled *example*, "car insurance · due
 * in 12 days" — purely to teach the dial's grammar.
 *
 * This is a bounded, deliberate exception to §12 of design/owner-decisions.md
 * ("nothing on the dial is decoration"), and it is bounded here, in code:
 *
 *  - it is drawn only while the tour is running, and only on the stops that
 *    ask for it;
 *  - it says what it is, in the label and in the copy;
 *  - it is never sent anywhere. Nothing in this module writes, posts or
 *    persists — it appends two nodes to the document and takes them away
 *    again on skip or finish;
 *  - where the household HAS bodies, it is never drawn at all: the tour
 *    points at the nearest real one instead (see stops.js, the `body` stop).
 *
 * Geometry and wording are design/v19/tour.html's own: r≈64 from the sun,
 * just past the r=62 danger ring — the ring that means about twelve days out
 * — with the label anchored outward so it never crosses the household's name.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** What the teaching prop says. Both surfaces read from here, so they agree. */
export const EXAMPLE_BODY = {
  label: "EXAMPLE",
  title: "car insurance",
  due: "due in 12 days",
  row: "Car insurance",
  rowMeta: "example · due in 12 days",
  countdown: "T−12d",
};

/**
 * Every real body on either dialect's dial — the desk's `.body-link` anchors
 * and the pocket's tappable circles. What this counts is what the reader can
 * already see: if it is more than none, the tour has something true to point
 * at and draws nothing.
 */
export const REAL_BODY_SELECTOR = ".body-link, .mdial [data-sheet-title], .mdial [data-sheet-sugg]";

/** @param {Document} doc */
export function countBodies(doc) {
  return doc.querySelectorAll(REAL_BODY_SELECTOR).length;
}

/**
 * Whether this stop, on this household, gets the example.
 *
 * @param {{ example?: boolean }} stop
 * @param {{ bodyCount?: number }} [household]
 */
export function needsExampleBody(stop, { bodyCount = 0 } = {}) {
  return Boolean(stop?.example) && bodyCount === 0;
}

/** @param {Document} doc @param {string} tag @param {Record<string, string>} attributes */
function svg(doc, tag, attributes) {
  const element = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

/**
 * Draws the example on whichever dial is on screen, and adds its matching
 * manifest row where there is a manifest to add it to. Idempotent: drawing
 * twice leaves one example, so a re-entered stop cannot stack them up.
 *
 * @param {Document} doc
 * @returns {boolean} whether anything was drawn
 */
export function drawExampleBody(doc) {
  removeExampleBody(doc);
  const dial = doc.querySelector("svg.dial") ?? doc.querySelector(".mdial svg");
  if (!dial) return false;

  const group = svg(doc, "g", { class: "tour-example example-body" });
  /* Read as one thing by assistive technology — a body, not five shapes. */
  group.setAttribute("role", "img");
  group.setAttribute("aria-label", `example: ${EXAMPLE_BODY.title}, ${EXAMPLE_BODY.due}`);
  group.append(
    svg(doc, "circle", {
      class: "exring", cx: "222", cy: "245", r: "6.5", fill: "none",
      style: "stroke:var(--accent-text)", "stroke-width": "1.6",
    }),
    svg(doc, "ellipse", {
      class: "example-belt", cx: "222", cy: "245", rx: "12", ry: "4.2",
      transform: "rotate(-18 222 245)", fill: "none",
      style: "stroke:var(--accent-text)", "stroke-width": "1.2", opacity: ".8",
    }),
  );
  const lines = /** @type {[string, string, string]} */ ([
    EXAMPLE_BODY.label, EXAMPLE_BODY.title, EXAMPLE_BODY.due,
  ]);
  lines.forEach((line, index) => {
    const text = svg(doc, "text", {
      x: "234", y: String(230 + index * 15), "text-anchor": "start",
      ...(index === 0 ? { class: "exlabel" } : {}),
    });
    text.textContent = line;
    group.append(text);
  });
  dial.append(group);

  const corridor = doc.querySelector("#manifest-top .corridor");
  if (corridor) corridor.insertBefore(exampleRow(doc), rowAnchorIn(corridor));
  return true;
}

/**
 * The manifest's own reading of the same body, in the corridor's vocabulary
 * (home.css draws `.item`, `.planet`, `.body`, `.t`) with the dashed outline
 * and the *example* tag tour.css adds.
 *
 * @param {Document} doc
 */
function exampleRow(doc) {
  const row = doc.createElement("div");
  row.className = "item example tour-example";
  const planet = doc.createElement("span");
  planet.className = "planet";
  planet.setAttribute("aria-hidden", "true");
  planet.append(doc.createElement("i"));
  const tag = doc.createElement("span");
  tag.className = "tag";
  tag.textContent = "example";
  const body = doc.createElement("div");
  body.className = "body";
  const title = doc.createElement("b");
  title.textContent = EXAMPLE_BODY.row;
  const meta = doc.createElement("span");
  meta.textContent = EXAMPLE_BODY.rowMeta;
  body.append(title, meta);
  const countdown = doc.createElement("div");
  countdown.className = "t";
  countdown.textContent = EXAMPLE_BODY.countdown;
  row.append(planet, tag, body, countdown);
  return row;
}

/**
 * Where the example row goes: straight after the TODAY marker when the
 * corridor has one, so a twelve-day body sits where a twelve-day body would.
 *
 * @param {Element} corridor
 */
function rowAnchorIn(corridor) {
  const today = corridor.querySelector(".today");
  return today ? today.nextSibling : corridor.firstChild;
}

/**
 * Takes the example away — on skip, on finish, and on any stop that does not
 * ask for it. Nothing of it survives the walk.
 *
 * @param {Document} doc
 */
export function removeExampleBody(doc) {
  for (const element of doc.querySelectorAll(".tour-example")) element.remove();
}
