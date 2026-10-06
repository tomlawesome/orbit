import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CREDITS, FONTS, SIDECARS } from "../../web/src/lib/about/credits.js";
import { creditsView, librariesOf, licencePartsOf, sidecarVersionOf, slug, spdxUrl } from "../../web/src/lib/about/group.js";

/*
 * The About page's cards 2 and 3 (#1256): four groups, each alphabetical;
 * every licence once, with how many entries use it; the libraries' A–Z
 * strip; and the hand-kept lists kept true to what Orbit actually ships.
 */

const LIBRARIES = [
  { name: "zod", version: "4.6.5", licence: "MIT", author: "Colin McDonnell", source: "https://zod.dev/" },
  { name: "@napi-rs/canvas", version: "1.0.9", licence: "MIT", author: "", source: "https://github.com/Brooooooklyn/canvas" },
  { name: "dompurify", version: "3.2.0", licence: "(MPL-2.0 OR Apache-2.0)", author: "Dr.-Ing. Mario Heiderich", source: "https://github.com/cure53/DOMPurify" },
  { name: "Buffer-shim", version: "1.0.0", licence: "", author: "", source: "https://www.npmjs.com/package/Buffer-shim" },
];

const view = (libraries = LIBRARIES) =>
  creditsView({ pictures: CREDITS, fonts: FONTS, sidecars: SIDECARS, libraries });

describe("creditsView (#1256)", () => {
  it("draws the four groups in the record's order, with their counts", () => {
    const { groups } = view();
    expect(groups.map((group) => [group.title, group.count])).toEqual([
      ["Pictures", CREDITS.length],
      ["Fonts", FONTS.length],
      ["Libraries", LIBRARIES.length],
      ["Sidecar images", SIDECARS.length],
    ]);
  });

  it("lists each group alphabetically by name, a scope's @ ignored and case folded", () => {
    for (const group of view().groups) {
      const names = (group.entries ?? []).map((entry) => entry.name.replace(/^@/, "").toLowerCase());
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
    }
    expect(view().groups[2].entries?.map((entry) => entry.name)).toEqual(
      ["Buffer-shim", "dompurify", "@napi-rs/canvas", "zod"]);
  });

  it("gives every entry its own #credit- id", () => {
    const ids = view().groups.flatMap((group) => (group.entries ?? []).map((entry) => entry.id));
    expect(ids.every((id) => id.startsWith("credit-"))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lists every licence once, alphabetically, counting each entry that uses it once", () => {
    const { licences } = view();
    const names = licences.map((licence) => licence.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), "en")));
    const users = Object.fromEntries(licences.map((licence) => [licence.key, licence.users]));
    // Two libraries and Ollama.
    expect(users.MIT).toBe(3);
    // One library, under an OR, and Tika.
    expect(users["Apache-2.0"]).toBe(2);
    expect(users["MPL-2.0"]).toBe(1);
    expect(users["OFL-1.1"]).toBe(FONTS.length);
    // The two NASA pictures share one licence row.
    expect(users["Public domain (NASA imagery is not copyrighted)"]).toBe(2);
  });

  it("links SBOM ids to SPDX, hand-kept licences to their own text, and the fonts to the bundled OFL", () => {
    const byKey = Object.fromEntries(view().licences.map((licence) => [licence.key, licence]));
    expect(byKey["MPL-2.0"].href).toBe("https://spdx.org/licenses/MPL-2.0.html");
    expect(byKey["OFL-1.1"].href).toBe("/licenses/fonts.txt");
    expect(byKey.PostgreSQL.href).toBe("https://www.postgresql.org/about/licence/");
    expect(byKey["MPL-2.0"].id).toBe("licence-mpl-2-0");
  });

  it("links each licence an entry names to that licence's row in card 3", () => {
    const { groups, licences } = view();
    const ids = new Set(licences.map((licence) => licence.key));
    for (const entry of groups.flatMap((group) => group.entries ?? [])) {
      for (const part of entry.licence) if (part.key) expect(ids.has(part.key)).toBe(true);
    }
  });

  it("keeps the Milky Way's change note and ESA's permission exactly as credits.js gives them", () => {
    const galaxy = view().groups[0].entries?.find((entry) => entry.name.startsWith("The Milky Way"));
    const source = CREDITS.find((credit) => credit.name.startsWith("The Milky Way"));
    expect(galaxy?.changes).toBe(source?.changes);
    expect(galaxy?.licence[0].text).toMatch(/commercial use of this picture needs ESA's permission/);
    expect(view().groups[0].entries?.filter((entry) => entry.changes)).toHaveLength(1);
  });

  it("names each Creative Commons work by its title in the name the page shows (CC 3.0 section 4(c))", () => {
    const cc = CREDITS.filter((credit) => /^CC /.test(credit.licence));
    expect(cc.length).toBeGreaterThan(0);
    const galaxy = view().groups[0].entries?.find((entry) => entry.name.startsWith("The Milky Way"));
    expect(galaxy?.name).toContain("Deep Star Maps 2020");
    for (const credit of cc) {
      const entry = view().groups[0].entries?.find((one) => one.id === `credit-${slug(credit.name)}`);
      expect(entry?.name, credit.name).toMatch(/"[^"]+"/);
    }
  });

  it("draws the strip A to Z, linking only the letters that have entries", () => {
    const { letters } = view();
    expect(letters.map((one) => one.letter).join("")).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(letters.filter((one) => one.id).map((one) => one.letter)).toEqual(["B", "D", "N", "Z"]);
    expect(letters.find((one) => one.letter === "N")?.id).toBe("libraries-n");
  });

  it("with no bill of materials, counts the libraries as unknown and links no letter", () => {
    const { groups, letters, licences } = view(null);
    expect(groups[2]).toMatchObject({ title: "Libraries", count: null, entries: null });
    expect(letters.every((one) => one.id === null)).toBe(true);
    // Pictures, fonts and sidecars still carry their licences.
    expect(licences.map((licence) => licence.key)).toContain("GPL-2.0-only");
    expect(licences.map((licence) => licence.key)).not.toContain("MPL-2.0");
  });
});

describe("licence expressions and the bill of materials (#1256)", () => {
  it("splits an SPDX expression into linked ids and plain words", () => {
    expect(licencePartsOf("(MIT OR Apache-2.0)")).toEqual([
      { text: "MIT", key: "MIT" }, { text: " or " }, { text: "Apache-2.0", key: "Apache-2.0" },
    ]);
    expect(licencePartsOf("Apache-2.0 WITH LLVM-exception")).toEqual([
      { text: "Apache-2.0 WITH LLVM-exception", key: "Apache-2.0 WITH LLVM-exception" },
    ]);
    expect(licencePartsOf("")).toEqual([{ text: "licence not stated" }]);
    expect(licencePartsOf("NOASSERTION")).toEqual([{ text: "licence not stated" }]);
    expect(spdxUrl("EUPL-1.1+")).toBe("https://spdx.org/licenses/EUPL-1.1.html");
  });

  it("reads an SPDX document's packages, dropping supplier labels and non-web sources", () => {
    expect(librariesOf({
      packages: [
        { name: "jose", versionInfo: "6.2.12", licenseDeclared: "MIT", supplier: "Person: Filip Skokan", homepage: "https://github.com/panva/jose" },
        { name: "left-pad", versionInfo: "1.3.0", licenseDeclared: "NOASSERTION", supplier: "NOASSERTION", homepage: "NOASSERTION" },
        { name: "broken" },
      ],
    })).toEqual([
      { name: "jose", version: "6.2.12", licence: "MIT", author: "Filip Skokan", source: "https://github.com/panva/jose" },
      { name: "left-pad", version: "1.3.0", licence: "NOASSERTION", author: "", source: "https://www.npmjs.com/package/left-pad" },
    ]);
    expect(librariesOf({})).toBeNull();
    expect(librariesOf(null)).toBeNull();
  });

  it("makes ids from plain slugs", () => {
    expect(slug("@napi-rs/canvas-1.0.9")).toBe("napi-rs-canvas-1-0-9");
    expect(slug("CC BY-NC 3.0 IGO (commercial use…)")).toBe("cc-by-nc-3-0-igo-commercial-use");
  });
});

describe("the hand-kept credits match what ships (#1256)", () => {
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");

  it("names each sidecar at the tag docker-compose.yml pins", () => {
    for (const sidecar of SIDECARS) {
      const block = compose.split(/\n  (?=[a-z])/).find((one) => one.startsWith(`${sidecar.service}:`));
      expect(block, `${sidecar.service} is a compose service`).toBeDefined();
      expect(block).toMatch(new RegExp(`\\n    image: ${sidecar.image.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}@sha256:`));
    }
  });

  it("names each font the bundled licence file is written for", () => {
    const collector = readFileSync(new URL("../../web/scripts/collect-font-licences.mjs", import.meta.url), "utf8");
    for (const font of FONTS) expect(collector).toContain(`"${font.package}"`);
  });

  it("credits pictures that are really shipped", () => {
    for (const file of CREDITS.flatMap((credit) => credit.files)) {
      expect(existsSync(new URL(`../../web/static/${file}`, import.meta.url)), file).toBe(true);
    }
  });
});

describe("a sidecar's version on card 1 (#1256)", () => {
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  /** The tag docker-compose.yml itself pins for a service, read from the file, not from credits.js. */
  const composeTag = (service) => {
    const block = compose.split(/\n  (?=[a-z])/).find((one) => one.startsWith(`${service}:`));
    return /\n    image: [^\s@]+:([^\s@]+)@sha256:/.exec(block ?? "")?.[1];
  };
  const SERVICES = { postgres: "orbit-db", tika: "orbit-tika", clamav: "orbit-clamav", ollama: "orbit-ollama" };

  it("shows the sidecar's own answer when it gave one", () => {
    expect(sidecarVersionOf({ id: "tika", state: "running", version: "4.1.0" }, SIDECARS))
      .toEqual({ kind: "live", text: "4.1.0" });
  });

  it("falls back to the tag the compose file pins, marked as pinned, when the call failed", () => {
    for (const id of Object.keys(SERVICES)) {
      const shown = sidecarVersionOf({ id, state: "running", version: null }, SIDECARS);
      expect(composeTag(SERVICES[id]), `${id} is pinned in compose`).toBeDefined();
      expect(shown).toEqual({ kind: "pinned", text: composeTag(SERVICES[id]) });
    }
  });

  it("says 'not known' only when neither a version nor a pin exists", () => {
    expect(sidecarVersionOf({ id: "tika", state: "running", version: null }, []))
      .toEqual({ kind: "unknown", text: "not known" });
    expect(sidecarVersionOf({ id: "mystery", state: "running", version: null }, SIDECARS))
      .toEqual({ kind: "unknown", text: "not known" });
  });

  it("keeps 'not running' for a sidecar that is off, whatever is pinned", () => {
    expect(sidecarVersionOf({ id: "ollama", state: "off", version: null }, SIDECARS))
      .toEqual({ kind: "off", text: "not running" });
  });
});
