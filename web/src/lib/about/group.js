/*
 * THE ABOUT PAGE'S CREDITS AND LICENCES, AS ROWS (#1256).
 *
 * Pure: the page hands in the hand-kept lists from ./credits.js and the
 * libraries its bill of materials named (or null when this build carries
 * none), and gets back what cards 2 and 3 draw — four groups, each
 * alphabetical, the A–Z strip for the libraries, and every licence once with
 * how many entries use it.
 */

/**
 * @typedef {{ name: string, version: string, licence: string, author: string, source: string }} Library
 * @typedef {{ text: string, key?: string }} LicencePart  a licence id (with its key) or the words between
 * @typedef {{
 *   id: string, name: string, version?: string, author: string,
 *   licence: LicencePart[], sourceUrl: string, sourceHost: string, changes?: string,
 * }} Entry
 * @typedef {{ id: string, title: string, count: number | null, entries: Entry[] | null }} Group
 * @typedef {{ letter: string, id: string | null }} Letter
 * @typedef {{ key: string, id: string, name: string, href: string, users: number }} Licence
 */

/** @param {string} text */
export function slug(text) {
  return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

/** @param {string} key */
export const licenceId = (key) => `licence-${slug(key)}`;

/** @param {string} name */
const sortKey = (name) => name.replace(/^@/, "").toLowerCase();

/** @param {{ name: string, version?: string }} a @param {{ name: string, version?: string }} b */
const byName = (a, b) =>
  sortKey(a.name).localeCompare(sortKey(b.name), "en") || (a.version ?? "").localeCompare(b.version ?? "", "en");

/** @param {string} url */
export function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** A package's source only when it is a web address someone can open. */
function webAddress(/** @type {unknown} */ url) {
  if (typeof url !== "string") return "";
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
  } catch {
    return "";
  }
}

/** `https://spdx.org/licenses/<id>.html` for an SPDX id; `X WITH Y` and `X+` link X's text. */
export const spdxUrl = (/** @type {string} */ id) =>
  `https://spdx.org/licenses/${encodeURIComponent(id.split(" WITH ")[0].replace(/\+$/, ""))}.html`;

/**
 * An SPDX expression as parts: each licence id (with its key, for the link
 * to card 3) and the words between, lower-cased. "MIT OR Apache-2.0" →
 * MIT · " or " · Apache-2.0. An empty expression is one unlinked "unknown".
 *
 * @param {string} expression
 * @returns {LicencePart[]}
 */
export function licencePartsOf(expression) {
  const tokens = String(expression ?? "").replace(/[()]/g, " ").split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.every((token) => token === "NOASSERTION")) return [{ text: "licence not stated" }];
  /** @type {LicencePart[]} */
  const parts = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "OR" || token === "AND") {
      parts.push({ text: ` ${token.toLowerCase()} ` });
    } else if (tokens[i + 1] === "WITH" && tokens[i + 2]) {
      const key = `${token} WITH ${tokens[i + 2]}`;
      parts.push({ text: key, key });
      i += 2;
    } else {
      parts.push({ text: token, key: token });
    }
  }
  return parts;
}

/** "Person: Jane Doe (jane@…)" → "Jane Doe"; NOASSERTION → "". */
function supplierName(/** @type {unknown} */ supplier) {
  if (typeof supplier !== "string" || supplier === "NOASSERTION") return "";
  return supplier.replace(/^(Person|Organization):\s*/, "").replace(/\s*\(.*\)\s*$/, "").trim();
}

/**
 * The libraries an SPDX 2.3 JSON document names (scripts/about-sbom.mjs
 * writes it into the image). Anything unreadable is null, which the page
 * draws as "this build carries no bill of materials".
 *
 * @param {unknown} document
 * @returns {Library[] | null}
 */
export function librariesOf(document) {
  const packages = /** @type {{ packages?: unknown }} */ (document)?.packages;
  if (!Array.isArray(packages)) return null;
  return packages
    .filter((one) => one && typeof one.name === "string" && typeof one.versionInfo === "string")
    .map((one) => ({
      name: one.name,
      version: one.versionInfo,
      licence: typeof one.licenseDeclared === "string" ? one.licenseDeclared : "",
      author: supplierName(one.supplier),
      source: webAddress(one.homepage) || `https://www.npmjs.com/package/${one.name}`,
    }));
}

/**
 * Cards 2 and 3, from the hand-kept lists and the bill of materials.
 *
 * @param {{
 *   pictures: import("./credits.js").Credit[],
 *   fonts: import("./credits.js").FontCredit[],
 *   sidecars: import("./credits.js").SidecarCredit[],
 *   libraries: Library[] | null,
 * }} input
 * @returns {{ groups: Group[], letters: Letter[], licences: Licence[] }}
 */
export function creditsView({ pictures, fonts, sidecars, libraries }) {
  /** @type {Map<string, Licence>} */
  const licences = new Map();
  const taken = new Set();

  /** @param {string} base */
  const uniqueId = (base) => {
    let id = `credit-${slug(base)}`;
    for (let n = 2; taken.has(id); n++) id = `credit-${slug(base)}-${n}`;
    taken.add(id);
    return id;
  };

  /**
   * One entry's licences, each counted once for it.
   * @param {LicencePart[]} parts
   * @param {(key: string) => { name: string, href: string }} describe
   */
  const use = (parts, describe) => {
    for (const key of new Set(parts.flatMap((part) => (part.key ? [part.key] : [])))) {
      const known = licences.get(key);
      if (known) known.users += 1;
      else licences.set(key, { key, id: licenceId(key), ...describe(key), users: 1 });
    }
    return parts;
  };

  /** @param {{ spdx?: string, licence: string, licenceUrl?: string }} credit */
  const handKept = (credit) => {
    const key = credit.spdx ?? credit.licence;
    return use([{ text: credit.licence, key }], () => ({
      name: key,
      href: credit.licenceUrl ?? (credit.spdx ? spdxUrl(credit.spdx) : ""),
    }));
  };

  /** @type {Entry[]} */
  const pictureEntries = [...pictures].sort(byName).map((credit) => ({
    id: uniqueId(credit.name),
    name: credit.name,
    author: credit.author,
    licence: handKept(credit),
    sourceUrl: credit.sourceUrl,
    sourceHost: hostOf(credit.sourceUrl),
    ...(credit.changes ? { changes: credit.changes } : {}),
  }));
  /** @type {Entry[]} */
  const fontEntries = [...fonts].sort(byName).map((credit) => ({
    id: uniqueId(credit.name),
    name: credit.name,
    author: credit.author,
    licence: handKept(credit),
    sourceUrl: credit.sourceUrl,
    sourceHost: hostOf(credit.sourceUrl),
  }));
  /** @type {Entry[] | null} */
  const libraryEntries = libraries
    ? [...libraries].sort(byName).map((library) => ({
        id: uniqueId(`${library.name}-${library.version}`),
        name: library.name,
        version: library.version,
        author: library.author,
        licence: use(licencePartsOf(library.licence), (key) => ({ name: key, href: spdxUrl(key) })),
        sourceUrl: library.source,
        sourceHost: hostOf(library.source),
      }))
    : null;
  /** @type {Entry[]} */
  const sidecarEntries = [...sidecars].sort(byName).map((credit) => ({
    id: uniqueId(credit.name),
    name: credit.name,
    version: credit.image,
    author: credit.author,
    licence: handKept(credit),
    sourceUrl: credit.sourceUrl,
    sourceHost: hostOf(credit.sourceUrl),
  }));

  /** @type {Letter[]} */
  const letters = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((letter) => ({
    letter,
    id: libraryEntries?.some((entry) => letterOf(entry.name) === letter) ? `libraries-${letter.toLowerCase()}` : null,
  }));

  return {
    groups: [
      { id: "credits-pictures", title: "Pictures", count: pictureEntries.length, entries: pictureEntries },
      { id: "credits-fonts", title: "Fonts", count: fontEntries.length, entries: fontEntries },
      { id: "credits-libraries", title: "Libraries", count: libraryEntries ? libraryEntries.length : null, entries: libraryEntries },
      { id: "credits-sidecars", title: "Sidecar images", count: sidecarEntries.length, entries: sidecarEntries },
    ],
    letters,
    licences: [...licences.values()].sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase(), "en")),
  };
}

/** The A–Z letter a library files under, or "" for one that starts with neither. */
export function letterOf(/** @type {string} */ name) {
  const first = sortKey(name).charAt(0).toUpperCase();
  return first >= "A" && first <= "Z" ? first : "";
}
