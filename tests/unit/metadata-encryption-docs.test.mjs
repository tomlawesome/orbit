import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Metadata-encryption docs (#1316): the docs must match the columns the code
 * really encrypts. The column list is read from the MetadataColumn union in
 * src/server/metadata/crypto.ts, so adding a column there fails here until
 * the threat model names it.
 */

const read = (rel) => readFileSync(resolve(__dirname, "../../", rel), "utf8");
// Prose wraps at arbitrary points; compare on single-spaced text.
const flat = (text) => text.replace(/\s+/g, " ");

const CRYPTO = read("src/server/metadata/crypto.ts");
const THREAT_MODEL = read("docs/document-threat-model.md");
const ADMIN_OPS = read("docs/administrator-operations.md");
const AT_REST = read("docs/encryption-at-rest.md");

const metadataColumns = () => {
  const start = CRYPTO.indexOf("export type MetadataColumn");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = CRYPTO.indexOf(";", start);
  const columns = [...CRYPTO.slice(start, end).matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((m) => m[1]);
  expect(columns.length).toBeGreaterThan(0);
  return columns;
};

// From the section heading to the next top-level heading.
const metadataSection = () => {
  const start = THREAT_MODEL.indexOf("## Household metadata encryption");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = THREAT_MODEL.slice(start + 3);
  const next = rest.search(/\n## /);
  return flat(next === -1 ? rest : rest.slice(0, next));
};

describe("metadata encryption docs (#1316)", () => {
  it("threat model's metadata section names every MetadataColumn", () => {
    const section = metadataSection();
    const missing = metadataColumns().filter((column) => !section.includes(column));
    expect(missing).toEqual([]);
  });

  it("threat model no longer says anything is 'deliberately not encrypted'", () => {
    expect(flat(THREAT_MODEL)).not.toContain("deliberately not encrypted");
  });

  it("administrator-operations lost-key paragraph says 'Tier 1 and Tier 2'", () => {
    const text = flat(ADMIN_OPS);
    const start = text.indexOf("If the key is really gone");
    expect(start).toBeGreaterThanOrEqual(0);
    const paragraph = text.slice(start, start + 500);
    expect(paragraph).toContain("Tier 1 and Tier 2");
  });

  it("encryption-at-rest no longer says 'those four columns'", () => {
    expect(flat(AT_REST)).not.toContain("those four columns");
  });
});
