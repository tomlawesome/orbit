/*
 * CREDITS FOR THE PICTURES ORBIT SHIPS (#1253).
 *
 * Data only: the About page that will show these is its own issue, so nothing
 * here is rendered yet. One entry per work, each meeting its own licence's
 * terms and no more:
 *
 *   · `changes` is filled only where the licence requires adaptations to be
 *     marked (Creative Commons: the Milky Way). NASA's pictures are not
 *     copyrighted, so they carry the credit NASA asks for and nothing else.
 *   · `licenceUrl` is given for every entry under a licence; for NASA it is
 *     NASA's own guidelines for using its imagery.
 *
 * `files` are the shipped copies, under web/static. They came from orbit-site
 * (assets/img, commit c189d38), whose tools made them from these sources.
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
    name: "The gold moon the flight passes",
    source: "NASA's CGI Moon Kit (LRO colour and LOLA elevation)",
    author: "NASA's Scientific Visualization Studio",
    licence: "Public domain (NASA imagery is not copyrighted)",
    licenceUrl: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
    sourceUrl: "https://svs.gsfc.nasa.gov/4720",
    files: ["flight/world/moon.webp"],
  },
  {
    name: "The Milky Way behind the flight",
    source: "NASA's Deep Star Maps 2020, from Gaia DR2 data",
    author: "NASA/Goddard Space Flight Center Scientific Visualization Studio; Gaia DR2: ESA/Gaia/DPAC",
    licence: "CC BY-NC 3.0 IGO (commercial use of this picture needs ESA's permission)",
    licenceUrl: "https://creativecommons.org/licenses/by-nc/3.0/igo/",
    sourceUrl: "https://svs.gsfc.nasa.gov/4851",
    changes: "Reduced in size and brought down from HDR (tone-mapped) for Orbit's flight, by orbit-site's tools/galaxy.py",
    files: ["flight/world/galaxy-2k.webp"],
  },
];
