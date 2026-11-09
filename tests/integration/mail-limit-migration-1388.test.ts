import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMigrationTestDatabase, runMigrations } from "./support/migration-fixture";

/**
 * #1388, design note 54592: one migration creates `instance_mail_limit` and
 * seeds its one row in the same statement, carrying today's effective mail cap.
 * An upload override set below 25 MiB becomes the mail override; an override of
 * 25 MiB or more (60 MiB here), or none, seeds null (the 25 MiB default). No
 * audit row is written by the migration.
 */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const MIB = 1_048_576;
/** The last tag that existed before #1388, whatever the new migration is called. */
const LAST_BEFORE = "0007_section_colour";

async function migrationsBeforeFeature(): Promise<string> {
  const source = resolve(process.cwd(), "drizzle");
  const target = await mkdtemp(join(tmpdir(), "orbit-mail-limit-migrations-"));
  cleanups.push(() => rm(target, { recursive: true, force: true }));
  await cp(source, target, { recursive: true });
  const journalPath = join(target, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
  const last = journal.entries.findIndex((entry) => entry.tag === LAST_BEFORE);
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n");
  return target;
}

/** An install on the prior schema, with the upload limit row as given, then upgraded. */
async function upgradedWith(label: string, uploadOverride: number | null) {
  const database = await createMigrationTestDatabase(label);
  cleanups.push(() => database.cleanup());
  await runMigrations(database.url, await migrationsBeforeFeature());
  await database.client.unsafe(`UPDATE "instance_upload_limit" SET "max_bytes" = $1`, [uploadOverride]);
  await runMigrations(database.url, resolve(process.cwd(), "drizzle"));
  const rows = await database.client.unsafe(`SELECT "max_bytes", "version" FROM "instance_mail_limit"`);
  return { database, rows };
}

describe("migration: instance_mail_limit (#1388, note 54592)", () => {
  it("carries an upload override of 10 MiB over as a 10 MiB mail override", async () => {
    const { rows } = await upgradedWith("mail_limit_10", 10 * MIB);
    expect(rows).toEqual([{ max_bytes: 10 * MIB, version: "1" }]);
  });

  it("seeds null against an upload override of 60 MiB", async () => {
    const { rows } = await upgradedWith("mail_limit_60", 60 * MIB);
    expect(rows).toEqual([{ max_bytes: null, version: "1" }]);
  });

  it("seeds null against no upload override", async () => {
    const { rows } = await upgradedWith("mail_limit_none", null);
    expect(rows).toEqual([{ max_bytes: null, version: "1" }]);
  });

  it("seeds null against an upload override of exactly 25 MiB (not below it)", async () => {
    const { rows } = await upgradedWith("mail_limit_25", 25 * MIB);
    expect(rows).toEqual([{ max_bytes: null, version: "1" }]);
  });

  it("seeds exactly one row on a fresh database and writes no audit row", async () => {
    const database = await createMigrationTestDatabase("mail_limit_fresh");
    cleanups.push(() => database.cleanup());
    await runMigrations(database.url, resolve(process.cwd(), "drizzle"));
    const rows = await database.client.unsafe(`SELECT "max_bytes", "version" FROM "instance_mail_limit"`);
    expect(rows).toEqual([{ max_bytes: null, version: "1" }]);
    const audits = await database.client.unsafe(`SELECT 1 FROM "audit_log" WHERE "action" LIKE 'instance_mail_limit%'`);
    expect(audits).toHaveLength(0);
  });
});
