/*
 * CREDITS FOR WHAT ORBIT SHIPS THAT NO PACKAGE MANAGER KNOWS ABOUT (#1253,
 * #1256): the pictures, the typefaces and the sidecar images. The About page
 * draws these beside the libraries its bill of materials lists. One entry per
 * work, each meeting its own licence's terms and no more:
 *
 *   · `changes` is filled only where the licence requires adaptations to be
 *     marked (Creative Commons: the Milky Way). NASA's pictures are not
 *     copyrighted, so they carry the credit NASA asks for and nothing else.
 *   · A CC-licensed work's own title is in the `name` the page shows (CC 3.0
 *     §4(c) asks for the title where one is supplied); `source` is not drawn.
 *   · `licenceUrl` is given for every entry under a licence; for NASA it is
 *     NASA's own guidelines for using its imagery.
 *
 * `files` are the shipped copies, under web/static. They came from orbit-site
 * (assets/img, commit c189d38), whose tools made them from these sources.
 *
 * Fonts (#1256) are the three faces web/scripts/collect-font-licences.mjs
 * bundles, and link the full OFL text that script writes at build time, as
 * OFL requires. Sidecars are the four images docker-compose.yml pins; their
 * `image` must match the compose file's tag, which tests/unit/about-credits
 * checks, so a re-pin that forgets this file fails there.
 */

/**
 * @typedef {object} Credit
 * @property {string} name what the work is, as Orbit uses it
 * @property {string} source where it comes from, in words
 * @property {string} author the credit line
 * @property {string} licence
 * @property {string} [licenceUrl]
 * @property {string} sourceUrl
 * @property {string} [changes] what was changed, where the licence asks for it
 * @property {string[]} files the shipped copies, under web/static
 */

/**
 * @typedef {object} FontCredit
 * @property {string} name the face
 * @property {string} author the copyright holder its licence names
 * @property {string} licence
 * @property {string} spdx
 * @property {string} licenceUrl the bundled full text
 * @property {string} sourceUrl
 * @property {string} package the @fontsource package it ships from
 */

/**
 * @typedef {object} SidecarCredit
 * @property {string} name
 * @property {string} service its docker-compose.yml service
 * @property {string} image the pinned image and tag, without the digest
 * @property {string} author
 * @property {string} licence
 * @property {string} spdx
 * @property {string} licenceUrl
 * @property {string} sourceUrl
 */

/** @type {Credit[]} */
export const CREDITS = [
  {
    name: "The Earth at dawn, on the sign-in and in the flight",
    source: "NASA's Black Marble city lights (2016) and Blue Marble land and clouds",
    author: "NASA Earth Observatory",
    licence: "Public domain (NASA imagery is not copyrighted)",
    licenceUrl: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
    sourceUrl: "https://earthobservatory.nasa.gov/features/NightLights",
    files: [
      "flight/door/dawn.webp", "flight/door/dawn-pre.webp",
      "flight/world/earth-lights.webp", "flight/world/europe-lights.webp",
      "flight/world/earth-day.webp", "flight/world/earth-clouds.webp",
    ],
  },
  {
    name: "The gold world on the ring, on the sign-in and the goodbye",
    source: "Cassini's map of Jupiter (PIA07782), made into the gold world and backlit by the sunrise by orbit-site's tools/planets.py",
    author: "NASA/JPL/Space Science Institute",
    licence: "Public domain (NASA imagery is not copyrighted)",
    licenceUrl: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
    sourceUrl: "https://photojournal.jpl.nasa.gov/catalog/PIA07782",
    files: ["flight/door/planet-gold.webp"],
  },
  {
    name: "The gold moon the flight passes",
    source: "NASA's CGI Moon Kit (LRO colour and LOLA elevation)",
    author: "NASA's Scientific Visualization Studio",
    licence: "Public domain (NASA imagery is not copyrighted)",
    licenceUrl: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
    sourceUrl: "https://svs.gsfc.nasa.gov/4720",
    files: ["flight/world/moon.webp"],
  },
  {
    name: "The Milky Way behind the flight, from \"Deep Star Maps 2020\"",
    source: "NASA's Deep Star Maps 2020, from Gaia DR2 data",
    author: "NASA/Goddard Space Flight Center Scientific Visualization Studio; Gaia DR2: ESA/Gaia/DPAC",
    licence: "CC BY-NC 3.0 IGO (commercial use of this picture needs ESA's permission)",
    licenceUrl: "https://creativecommons.org/licenses/by-nc/3.0/igo/",
    sourceUrl: "https://svs.gsfc.nasa.gov/4851",
    changes: "Reduced in size and brought down from HDR (tone-mapped) for Orbit's flight, by orbit-site's tools/galaxy.py",
    files: ["flight/world/galaxy-2k.webp"],
  },
];

/** @type {FontCredit[]} */
export const FONTS = [
  {
    name: "Inter",
    author: "The Inter Project Authors",
    licence: "SIL Open Font License 1.1",
    spdx: "OFL-1.1",
    licenceUrl: "/licenses/fonts.txt",
    sourceUrl: "https://github.com/rsms/inter",
    package: "@fontsource-variable/inter",
  },
  {
    name: "JetBrains Mono",
    author: "The JetBrains Mono Project Authors",
    licence: "SIL Open Font License 1.1",
    spdx: "OFL-1.1",
    licenceUrl: "/licenses/fonts.txt",
    sourceUrl: "https://github.com/JetBrains/JetBrainsMono",
    package: "@fontsource-variable/jetbrains-mono",
  },
  {
    name: "Space Grotesk",
    author: "The Space Grotesk Project Authors",
    licence: "SIL Open Font License 1.1",
    spdx: "OFL-1.1",
    licenceUrl: "/licenses/fonts.txt",
    sourceUrl: "https://github.com/floriankarsten/space-grotesk",
    package: "@fontsource/space-grotesk",
  },
];

/** @type {SidecarCredit[]} */
export const SIDECARS = [
  {
    name: "PostgreSQL",
    service: "orbit-db",
    image: "postgres:18-alpine",
    author: "The PostgreSQL Global Development Group",
    licence: "PostgreSQL License",
    spdx: "PostgreSQL",
    licenceUrl: "https://www.postgresql.org/about/licence/",
    sourceUrl: "https://www.postgresql.org/",
  },
  {
    name: "Apache Tika",
    service: "orbit-tika",
    image: "apache/tika:4.1.0-full",
    author: "The Apache Software Foundation",
    licence: "Apache License 2.0",
    spdx: "Apache-2.0",
    licenceUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    sourceUrl: "https://tika.apache.org/",
  },
  {
    name: "ClamAV",
    service: "orbit-clamav",
    image: "clamav/clamav:1.5.4-debian",
    author: "Cisco Systems, Inc.",
    licence: "GNU General Public License 2.0",
    spdx: "GPL-2.0-only",
    licenceUrl: "https://www.gnu.org/licenses/old-licenses/gpl-2.0.html",
    sourceUrl: "https://github.com/Cisco-Talos/clamav",
  },
  {
    name: "Ollama",
    service: "orbit-ollama",
    image: "ollama/ollama:0.35.1",
    author: "Ollama",
    licence: "MIT License",
    spdx: "MIT",
    licenceUrl: "https://spdx.org/licenses/MIT.html",
    sourceUrl: "https://github.com/ollama/ollama",
  },
];
