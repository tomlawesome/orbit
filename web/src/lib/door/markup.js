/*
 * The door's markup, as strings: the dawn (the sign-in's surface) and the dusk (the goodbye). Pure functions, so a
 * host can render them on the server or write them into a page ahead of time; nothing here touches the document.
 * This is the master copy: the site's index.html carries what dawnMarkup and duskMarkup write (tools/door-markup.mjs
 * writes it there; the lint fails if the two differ), and Orbit renders them in its own components.
 *
 * The structure is dawn.js's and door.css's contract: the star sky (.dsky), the world (.world: the glows, the limb,
 * the Earth's two pictures, each a compositor layer of its own), and the chrome over it (.loginchrome .lockup: the
 * glyph with its ring and runner, the name, the way in). What is the host's goes in the slots:
 *
 *   image(path)   where a picture is (the same resolver as createDoor's setting): "dawn/glow-zod.webp" → URL
 *   lockup        markup placed in the lockup between the glyph and the name (the site: the planets on their orbits)
 *   gate          the way in, inside .gate-wrap (the site: the gate button and the maintenance notice; Orbit: its
 *                 sign-in form). Nothing by default
 *   foot          a line at the foot of the surface (the site: its credit). Nothing by default
 *   farewell      the dusk's words: { said, sub }
 *   indent        the whitespace before each line (the page's own), "" for none
 *
 * A slot is put in as given, its own whitespace and all: the host indents it as it likes.
 */
const DEFS_DAWN = [
  '<linearGradient id="rimg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ffd989"/><stop offset="100%" stop-color="#e2772b"/></linearGradient>',
  '<linearGradient id="skywash" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-opacity="0"/><stop offset="62%" stop-color="#3d2a4d" stop-opacity=".12"/><stop offset="86%" stop-color="#a2492a" stop-opacity=".2"/><stop offset="100%" stop-color="#e2772b" stop-opacity=".26"/></linearGradient>',
];
/* the rich look's light: the ring and the orbits lit from the sunrise below, a deep disc behind the name (orblit is
   the site's orbits' stroke, drawn by its hub: kept here so the one glyph serves both) */
const DEFS_GLYPH = [
  '<linearGradient id="ringlit" gradientUnits="userSpaceOnUse" x1="0" y1="26" x2="0" y2="174"><stop offset="0" stop-color="#6c76a0" stop-opacity=".6"/><stop offset=".5" stop-color="#aab2cf" stop-opacity=".85"/><stop offset=".86" stop-color="#ead2a4"/><stop offset="1" stop-color="#ffe2a8"/></linearGradient>',
  '<linearGradient id="orblit" gradientUnits="userSpaceOnUse" x1="0" y1="-15" x2="0" y2="215"><stop offset="0" stop-color="#8791b3" stop-opacity=".1"/><stop offset=".55" stop-color="#9aa2c2" stop-opacity=".2"/><stop offset="1" stop-color="#f2cf98" stop-opacity=".5"/></linearGradient>',
  '<radialGradient id="disclit" cx="100" cy="100" r="72" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#03040a" stop-opacity=".55"/><stop offset=".8" stop-color="#05070f" stop-opacity=".35"/><stop offset="1" stop-color="#05070f" stop-opacity="0"/></radialGradient>',
  '<radialGradient id="discwarm" cx="100" cy="182" r="70" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffcf8a" stop-opacity=".16"/><stop offset="1" stop-color="#ffcf8a" stop-opacity="0"/></radialGradient>',
];
const DEFS_DUSK = [
  '<linearGradient id="d-rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f0a35a"/><stop offset="100%" stop-color="#7a2c18"/></linearGradient>',
  '<linearGradient id="d-wash" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-opacity="0"/><stop offset="40%" stop-color="#1e1838" stop-opacity=".30"/><stop offset="62%" stop-color="#3b2450" stop-opacity=".34"/><stop offset="78%" stop-color="#83354f" stop-opacity=".26"/><stop offset="91%" stop-color="#a2492a" stop-opacity=".22"/><stop offset="100%" stop-color="#c2571f" stop-opacity=".22"/></linearGradient>',
];

const SLICE = 'viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMax slice"';
/* a picture laid over the whole 1600×1000 frame, drawn once from its filter graph (glows.js) */
const picture = (name, href, cls = "") => `<image${cls ? ` class="${cls}"` : ""} data-raster="${name}"${href ? ` href="${href}"` : ""} x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>`;
/* a compositor layer of its own, holding one picture */
const layer = (cls, inner) => `<svg class="wl ${cls}" ${SLICE}>${inner}</svg>`;

/* lines joined with the page's indent: a nested array is one level deeper; a slot (raw) is kept as it came */
const raw = (s) => ({ raw: s });
function lines(indent, items, depth = 0) {
  const out = [];
  for (const it of items) {
    if (it === null || it === undefined || it === "") continue;
    if (Array.isArray(it)) out.push(lines(indent, it, depth + 1));
    else if (typeof it === "object") { if (it.raw) out.push(it.raw); }
    else out.push(indent + "  ".repeat(depth) + it);
  }
  return out.join("\n");
}

/** the dawn: `<div id="door">…</div>` */
export function dawnMarkup({ image = (p) => p, lockup = "", gate = "", foot = "", indent = "" } = {}) {
  return lines(indent, [
    '<div id="door">',
    [
      '<div class="dsky" aria-hidden="true"></div>',
      '<div class="world" aria-hidden="true">',
      [
        '<svg class="wl defs" width="0" height="0" aria-hidden="true"><defs>',
        [...DEFS_DAWN],
        "</defs></svg>",
        "<!-- each thing that moves or breathes is a layer of its own, so the compositor carries it -->",
        '<div class="dawnlayer">',
        [
          layer("wash", '<rect x="0" y="0" width="1600" height="1000" fill="url(#skywash)"/>'),
          '<div class="rays">',
          [
            layer("sway1", picture("sway1", image("dawn/glow-sway1.webp"))),
            layer("sway2", picture("sway2", image("dawn/glow-sway2.webp"))),
          ],
          "</div>",
          "<!-- the glows that breathe, breathing together as one layer -->",
          '<div class="sunpt">',
          [
            `<svg class="wl breath" ${SLICE}>`,
            [
              picture("zod", image("dawn/glow-zod.webp"), "zodiacal"),
              picture("sun", ""),
              picture("sunpt", image("dawn/glow-sunpt.webp")),
            ],
            "</svg>",
          ],
          "</div>",
        ],
        "</div>",
        `<svg class="wl limb" ${SLICE}>`,
        [
          '<circle cx="800" cy="3920" r="3000" fill="#04060e"/>',
          '<circle class="rim" cx="800" cy="3920" r="3000" fill="none" stroke="url(#rimg)" stroke-width="2.4" stroke-opacity=".85"/>',
        ],
        "</svg>",
        "<!-- the Earth itself, from orbit, as the sun comes up over it (tools/dawn.py): before the light, and with it -->",
        `<svg class="wl earth" ${SLICE}>`,
        [
          `<image class="pre" data-href="${image("dawn/dawn-pre.webp")}" x="0" y="640" width="1600" height="360" preserveAspectRatio="none"/>`,
          `<image class="up" data-href="${image("dawn/dawn.webp")}" x="0" y="640" width="1600" height="360" preserveAspectRatio="none"/>`,
        ],
        "</svg>",
      ],
      "</div>",
      '<div class="loginchrome">',
      [
        '<div class="lockup">',
        [
          '<div class="glyph" id="login-glyph"><svg width="420" height="420" viewBox="0 0 200 200" aria-hidden="true">',
          [
            "<!-- the rich look's light: the ring and the orbits lit from the sunrise below, a deep disc behind the name -->",
            "<defs>",
            [...DEFS_GLYPH],
            "</defs>",
            '<g class="lux" aria-hidden="true"><circle cx="100" cy="100" r="71" fill="url(#disclit)"/><circle cx="100" cy="100" r="71" fill="url(#discwarm)"/></g>',
            '<circle class="ring lux" cx="100" cy="100" r="72" fill="none" stroke="url(#ringlit)" stroke-width="9" stroke-opacity=".05" pathLength="100"/>',
            '<circle class="ring lux" cx="100" cy="100" r="72" fill="none" stroke="url(#ringlit)" stroke-width="3.6" stroke-opacity=".12" pathLength="100"/>',
            '<circle class="ring" cx="100" cy="100" r="72" fill="none" stroke="#8791b3" stroke-width="2" pathLength="100"/>',
          ],
          '</svg><i class="runner" aria-hidden="true"></i></div>',
          raw(lockup),
          '<h1 class="name">orbit</h1>',
          `<div class="gate-wrap">${gate}</div>`,
        ],
        "</div>",
      ],
      "</div>",
      raw(foot),
    ],
    "</div>",
  ]);
}

/** the dusk: `<div id="dusk" hidden>…</div>` */
export function duskMarkup({ image = (p) => p, gate = "", foot = "", farewell = { said: "You are signed out.", sub: "the sky keeps turning · your systems keep their orbits" }, indent = "" } = {}) {
  return lines(indent, [
    '<div id="dusk" hidden>',
    [
      '<div class="dsky" aria-hidden="true"></div>',
      '<div class="world" aria-hidden="true">',
      [
        '<svg class="wl defs" width="0" height="0" aria-hidden="true"><defs>',
        [...DEFS_DUSK],
        "</defs></svg>",
        layer("wash", '<rect x="0" y="0" width="1600" height="1000" fill="url(#d-wash)"/>' + picture("glow", image("dusk/glow-glow.webp"))),
        layer("belt", picture("belt", image("dusk/glow-belt.webp"))),
        layer("afterglow", picture("afterglow", image("dusk/glow-afterglow.webp"))),
        `<svg class="wl limb" ${SLICE}>`,
        [
          '<circle cx="800" cy="3920" r="3000" fill="#03050b"/>',
          picture("rim", image("dusk/glow-rim.webp")),
          '<circle cx="800" cy="3920" r="3000" fill="none" stroke="url(#d-rim)" stroke-width="1.8" stroke-opacity=".6"/>',
        ],
        "</svg>",
        layer("shimmerlayer", '<circle class="shimmer" pathLength="100" cx="800" cy="3920" r="3000" fill="none" stroke="#ffb37a" stroke-width="3" stroke-linecap="round"/>'),
      ],
      "</div>",
      '<div class="loginchrome">',
      [
        '<div class="lockup">',
        [
          '<div class="glyph" id="dusk-glyph"><svg width="420" height="420" viewBox="0 0 200 200" aria-hidden="true">',
          [
            '<circle cx="100" cy="100" r="72" fill="none" stroke="#8791b3" stroke-width="2"/>',
            '<g class="tr"><circle cx="163" cy="63.5" r="7" fill="#d8b45a"/></g></svg></div>',
          ],
          '<div class="name">orbit</div>',
          `<div class="gate-wrap">${gate}</div>`,
        ],
        "</div>",
        '<div class="farewell">',
        [
          `<div class="said">${farewell.said}</div>`,
          `<div class="sub">${farewell.sub}</div>`,
        ],
        "</div>",
      ],
      "</div>",
      raw(foot),
    ],
    "</div>",
  ]);
}
