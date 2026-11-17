import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CONTRACT_PRECONDITIONS } from "./contract-preconditions";

// Guard (#1854 A-R1): a precondition is skipped when its migrationTag is not
// in the image's drizzle folder, so a drop generated under any other tag
// would leave the gate silently off. The drop must carry exactly the tag.
const drizzleDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../drizzle");

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function dropsColumn(sql: string, table: string, column: string): boolean {
  const name = (id: string) => `"?${escapeRegExp(id)}"?`;
  const pattern = new RegExp(`ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?(?:"?public"?\\.)?${name(table)}\\s+[^;]*?DROP\\s+COLUMN\\s+(?:IF\\s+EXISTS\\s+)?${name(column)}(?![\\w"])`, "iu");
  return pattern.test(sql);
}

describe("contract precondition migration tags", () => {
  const journal = JSON.parse(readFileSync(join(drizzleDir, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const files = readdirSync(drizzleDir).filter((file) => file.endsWith(".sql"));

  it.each(CONTRACT_PRECONDITIONS.map((entry) => [entry.column, entry] as const))("any migration dropping %s is named exactly its migrationTag", (_column, precondition) => {
    const [table, column] = precondition.column.split(".") as [string, string];
    const droppers = files.filter((file) => dropsColumn(readFileSync(join(drizzleDir, file), "utf8"), table, column));
    for (const file of droppers) expect(file).toBe(`${precondition.migrationTag}.sql`);
    if (droppers.length > 0) expect(journal.entries.map((entry) => entry.tag)).toContain(precondition.migrationTag);
  });

  it("lists a drop migration's tag in the journal", () => {
    // Applies whenever the drop exists; checked above. Here: every journal
    // tag has its file, so the journal cannot name a tag the folder lacks.
    for (const entry of journal.entries) expect(files).toContain(`${entry.tag}.sql`);
  });

  it("recognises quoted, unquoted and mixed-case drops", () => {
    expect(dropsColumn('ALTER TABLE "documents" DROP COLUMN "content_sha256";', "documents", "content_sha256")).toBe(true);
    expect(dropsColumn("alter table documents drop column content_sha256;", "documents", "content_sha256")).toBe(true);
    expect(dropsColumn('ALTER TABLE "documents" DROP COLUMN "content_sha256_x";', "documents", "content_sha256")).toBe(false);
    expect(dropsColumn('ALTER TABLE "other" DROP COLUMN "content_sha256";', "documents", "content_sha256")).toBe(false);
  });
});
