import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  NOTES_MAX, PROVIDER_MAX, REFERENCE_MAX, TITLE_MAX,
  defaultSections, sectionAccents, sectionIcons,
} from "../../src/lib/domain.ts";
import { parseWorkspaceCommand, workspaceSectionSchema } from "../../src/lib/workspace.ts";
import { documentJobKind, documentJobStatus } from "../../src/db/schema.ts";
import { HOUSEHOLD_NAME_LIMIT } from "../../src/server/admin-repository.ts";
import { detectDocumentMediaType } from "../../src/server/documents/validation.ts";

import { MARKS, PEN_ORDER, SHIPPED_MARKS, SHIPPED_SECTION_IDS, inkOf } from "../../web/src/lib/marks.js";
import { SECTION_COLOURS, sectionColourOf } from "../../web/src/lib/option-colour.js";
import { DEFAULT_SECTIONS, NAME_LIMIT } from "../../web/src/lib/arrival/stage.js";
import { DOCUMENT_ACCEPT } from "../../web/src/lib/data/document-read.js";
import { JOB_KINDS, JOB_REASONS, JOB_STATES } from "../../web/src/routes/administration/words.js";

/*
 * #1348 (from #1328 WI-18): the browser keeps its own copies of vocabularies
 * the engine owns -- section marks, field lengths, admin job words, the types
 * an upload may be. Each says "keep in step". This pins them: every
 * assertion imports the real value from BOTH sides (or reads the one place a
 * side only states it in markup), so editing one side alone fails here.
 *
 * Two engine values are not exported, so they are read the only way left
 * without touching product code (stated at each use):
 *   - the accepted document types: probed through detectDocumentMediaType,
 *     and the type union is cross-checked against validation.ts's source;
 *   - the admin failure codes: the `documentFailureCodes` Set literal in
 *     admin-operations.ts, read from source text.
 * Browser lengths that live only as `maxlength` in a .svelte template are
 * read from that source by element id, like the repo's other source-reading
 * unit tests (door-locked-redirect, section-removal-asks-where).
 */

const root = path.resolve(import.meta.dirname, "../..");
const source = (relative) => readFileSync(path.join(root, relative), "utf8");

const sameSet = (actual, expected) => expect([...actual].sort()).toEqual([...expected].sort());

describe("section marks, accents and defaults (marks.js, option-colour.js, stage.js vs domain.ts)", () => {
  it("draws exactly the engine's twelve icons, in the engine's order", () => {
    expect(Object.keys(MARKS)).toEqual([...sectionIcons]);
  });

  it("splits them as the engine does: the first five shipped, the rest the pen's asterisms in order", () => {
    expect([...SHIPPED_MARKS]).toEqual(sectionIcons.slice(0, 5));
    expect(PEN_ORDER).toEqual(sectionIcons.slice(5));
  });

  it("prints every icon in an accent the engine accepts, and uses every accent the engine has", () => {
    for (const icon of sectionIcons) {
      expect(sectionAccents, `ink of ${icon}`).toContain(MARKS[icon].ink);
      expect(inkOf(icon)).toBe(MARKS[icon].ink);
    }
    sameSet(new Set(Object.values(MARKS).map((mark) => mark.ink)), sectionAccents);
  });

  it("agrees with the engine's default sections: ids, names, icon, accent", () => {
    sameSet(SHIPPED_SECTION_IDS, defaultSections.map((section) => section.id));
    expect(DEFAULT_SECTIONS).toEqual(defaultSections.map((section) => section.name));
    for (const section of defaultSections) {
      expect(SHIPPED_MARKS.has(section.icon), `${section.id} wears a shipped mark`).toBe(true);
      expect(inkOf(section.icon), `${section.id} accent`).toBe(section.accent);
    }
  });

  it("colours every engine icon by its place in the engine's list, cycling the four section colours", () => {
    sectionIcons.forEach((icon, place) => {
      expect(sectionColourOf({ icon }), icon).toBe(SECTION_COLOURS[place % SECTION_COLOURS.length]);
    });
    expect(sectionColourOf({ icon: "not-a-mark" })).toBeNull();
  });

  it("gives each default section the colour of its own mark, by id", () => {
    for (const section of defaultSections) {
      expect(sectionColourOf({ id: section.id, icon: section.icon }), section.id)
        .toBe(sectionColourOf({ icon: section.icon }));
    }
  });
});

/*
 * The opening tag of the first <input>/<textarea> carrying `id="<id>"`.
 * Braces and quotes are tracked so `>` inside an attribute expression does
 * not end the tag early.
 */
function tagWithId(svelte, id) {
  const at = svelte.indexOf(`id="${id}"`);
  if (at < 0) throw new Error(`no element id="${id}"`);
  const start = Math.max(svelte.lastIndexOf("<input", at), svelte.lastIndexOf("<textarea", at));
  if (start < 0) throw new Error(`id="${id}" is not on an input or textarea`);
  let depth = 0;
  let quote = "";
  for (let i = start; i < svelte.length; i += 1) {
    const ch = svelte[i];
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return svelte.slice(start, i + 1);
  }
  throw new Error(`unterminated tag for id="${id}"`);
}

/** The element's `maxlength`: a literal number, or the named constant it is bound to. */
function maxlengthOf(svelte, id, constants = {}) {
  const tag = tagWithId(svelte, id);
  const literal = tag.match(/\bmaxlength="(\d+)"/);
  if (literal) return Number(literal[1]);
  const bound = tag.match(/\bmaxlength=\{(\w+)\}/);
  if (bound && bound[1] in constants) return constants[bound[1]];
  throw new Error(`id="${id}" has no maxlength this test can read: ${tag}`);
}

/** The longest string of "x" the engine's own check accepts, probed at its edge. */
function longestAccepted(accepts, limit = 400) {
  let longest = 0;
  for (let length = 1; length <= limit; length += 1) {
    if (accepts("x".repeat(length))) longest = length;
    else break;
  }
  expect(longest, "the engine bound should be found below the probe limit").toBeLessThan(limit);
  return longest;
}

describe("field maxlength hints vs the engine's bounds", () => {
  const entryForm = source("web/src/routes/create/EntryForm.svelte");

  it("the entry form's name, provider, reference and notes use the item bounds", () => {
    expect(maxlengthOf(entryForm, "{uid}-name")).toBe(TITLE_MAX);
    expect(maxlengthOf(entryForm, "{uid}-provider")).toBe(PROVIDER_MAX);
    expect(maxlengthOf(entryForm, "{uid}-reference")).toBe(REFERENCE_MAX);
    expect(maxlengthOf(entryForm, "{uid}-notes")).toBe(NOTES_MAX);
  });

  const householdNameBound = longestAccepted((name) => {
    try {
      parseWorkspaceCommand({
        type: "household.update", householdId: "h", name, timezone: "Europe/London", currency: "GBP",
      });
      return true;
    } catch { return false; }
  });
  const sectionNameBound = longestAccepted((name) => workspaceSectionSchema.safeParse({
    id: "s", name, icon: "home", accent: "sage", visible: true,
  }).success);

  it("the engine's two household-name bounds agree with each other", () => {
    expect(householdNameBound).toBe(HOUSEHOLD_NAME_LIMIT);
  });

  it("every system-name field, on desk, phone, arrival and administration, holds the household-name bound", () => {
    const constants = { NAME_LIMIT };
    expect(NAME_LIMIT).toBe(householdNameBound);
    expect(maxlengthOf(source("web/src/routes/household/[id]/+page.svelte"), "hhname")).toBe(householdNameBound);
    expect(maxlengthOf(source("web/src/routes/household/[id]/pocket.svelte"), "hh-name")).toBe(householdNameBound);
    expect(maxlengthOf(source("web/src/lib/arrival/CreateSystem.svelte"), "hhname", constants)).toBe(householdNameBound);
    expect(maxlengthOf(source("web/src/routes/administration/+page.svelte"), "newsystem-name", constants)).toBe(householdNameBound);
    expect(maxlengthOf(source("web/src/routes/administration/pocket.svelte"), "ad-sys-name", constants)).toBe(householdNameBound);
  });

  it("the section-name fields, on desk and phone, hold the section-name bound", () => {
    expect(maxlengthOf(source("web/src/routes/household/[id]/+page.svelte"), "secname-{row.id}")).toBe(sectionNameBound);
    expect(maxlengthOf(source("web/src/routes/household/[id]/pocket.svelte"), "hh-secname")).toBe(sectionNameBound);
  });
});

describe("admin document-job words vs the engine's code sets", () => {
  it("names every job kind the engine stores, and no other", () => {
    sameSet(Object.keys(JOB_KINDS), documentJobKind.enumValues);
  });

  it("names every job state the engine stores, and no other, each with its own rank", () => {
    sameSet(Object.keys(JOB_STATES), documentJobStatus.enumValues);
    const ranks = Object.values(JOB_STATES).map((state) => state.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("says every failure code the engine reports, plus 'unknown' for the rest", () => {
    // `documentFailureCodes` in admin-operations.ts is module-private: read its Set literal from source.
    const literal = source("src/server/admin-operations.ts").match(/const documentFailureCodes = new Set\(\[([\s\S]*?)\]\)/);
    expect(literal, "documentFailureCodes literal found").not.toBeNull();
    const engineCodes = [...literal[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
    expect(engineCodes.length).toBeGreaterThan(0);
    expect(JOB_REASONS.unknown).toBeTruthy();
    sameSet(Object.keys(JOB_REASONS).filter((code) => code !== "unknown"), engineCodes);
  });
});

describe("the upload accept attribute vs the engine's accepted media types", () => {
  // The engine exports no value for its accepted types (SupportedDocumentMediaType is a type and
  // mediaExtensions is private), so they are what detectDocumentMediaType returns for each type's
  // magic bytes, and the union in validation.ts's source must name no type the probes miss.
  const probes = [
    Buffer.from("%PDF-1.7\n"),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ];
  const engineTypes = probes.map((bytes) => detectDocumentMediaType(bytes));

  it("the probes cover the type union the engine declares", () => {
    const union = source("src/server/documents/validation.ts").match(/export type SupportedDocumentMediaType =([^;]*);/);
    expect(union, "SupportedDocumentMediaType found").not.toBeNull();
    sameSet(engineTypes, [...union[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]));
    expect(() => detectDocumentMediaType(Buffer.from("GIF89a"))).toThrow();
  });

  it("lists exactly the engine's media types (no wildcard, none missing)", () => {
    const tokens = DOCUMENT_ACCEPT.split(",").map((token) => token.trim());
    sameSet(tokens.filter((token) => token.includes("/")), engineTypes);
  });
});
