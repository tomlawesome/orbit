import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableName } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { documentPreviews, documents } from "@/db/schema";

// The kept page previews table v0.3.8 added (#1433 D16, D18), checked two
// ways: the shape the design note specifies, and that each CHECK the schema
// declares renders to exactly the CHECK migration 0015 created, so the
// TypeScript schema and the database cannot drift apart unnoticed.

const dialect = new PgDialect();
const migrationsDir = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Every `CONSTRAINT "name" CHECK (...)` in the migrations, last definition wins. */
function migrationChecks(): Map<string, string> {
  const found = new Map<string, string>();
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    const text = readFileSync(`${migrationsDir}/${file}`, "utf8");
    const pattern = /CONSTRAINT "([^"]+)" CHECK \(/g;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      let depth = 1;
      let end = pattern.lastIndex;
      while (depth > 0 && end < text.length) {
        if (text[end] === "(") depth += 1;
        else if (text[end] === ")") depth -= 1;
        end += 1;
      }
      found.set(match[1], text.slice(pattern.lastIndex, end - 1));
    }
  }
  return found;
}

const fromMigrations = migrationChecks();

function checksOf(table: PgTable): Map<string, string> {
  return new Map(getTableConfig(table).checks.map((check) => [check.name, dialect.sqlToQuery(check.value).sql]));
}

function expectChecksMatchMigrations(table: PgTable, names: string[]): void {
  const checks = checksOf(table);
  for (const name of names) {
    expect(checks.has(name), `${getTableName(table)} declares ${name}`).toBe(true);
    expect(fromMigrations.has(name), `a migration creates ${name}`).toBe(true);
    expect(checks.get(name), name).toBe(fromMigrations.get(name));
  }
}

function foreignKey(table: PgTable, column: string) {
  const match = getTableConfig(table).foreignKeys.find((key) => key.reference().columns.some((c) => c.name === column));
  if (!match) throw new Error(`${getTableName(table)}.${column} has no foreign key`);
  const reference = match.reference();
  return {
    name: match.getName(),
    onDelete: match.onDelete,
    foreignTable: getTableName(reference.foreignTable),
    foreignColumns: reference.foreignColumns.map((c) => c.name),
  };
}

describe("document_previews (#1433 D16, D18)", () => {
  const config = getTableConfig(documentPreviews);

  it("keeps one row per (document, page)", () => {
    expect(config.primaryKeys.map((key) => key.columns.map((c) => c.name))).toEqual([["document_id", "page"]]);
  });

  it("goes with its document: the foreign key cascades on delete", () => {
    expect(foreignKey(documentPreviews, "document_id")).toEqual({
      name: "document_previews_document_id_documents_id_fk",
      onDelete: "cascade",
      foreignTable: getTableName(documents),
      foreignColumns: ["id"],
    });
  });

  it("names each kept object once, and indexes the key id and status the workers look up", () => {
    const storageKey = config.columns.find((column) => column.name === "storage_key");
    expect(storageKey?.isUnique).toBe(true);
    expect(storageKey?.uniqueName).toBe("document_preview_storage_key_unique");
    expect(config.indexes.map((index) => index.config.name).sort()).toEqual(["document_preview_key_idx", "document_preview_status_idx"]);
  });

  it("starts attempts at 1, with the audit timestamps", () => {
    const attempts = config.columns.find((column) => column.name === "attempts");
    expect(attempts?.notNull).toBe(true);
    expect(attempts?.default).toBe(1);
    expect(config.columns.map((column) => column.name)).toEqual(expect.arrayContaining(["created_at", "updated_at"]));
  });

  it("declares the page, status, refusal and shape checks exactly as migration 0015 creates them", () => {
    expectChecksMatchMigrations(documentPreviews, [
      "document_preview_page_positive",
      "document_preview_status_valid",
      "document_preview_refusal_valid",
      "document_preview_shape",
    ]);
    expect(checksOf(documentPreviews).get("document_preview_refusal_valid")).toContain("'memory', 'timeout', 'crash', 'parser', 'unsupported'");
  });
});
