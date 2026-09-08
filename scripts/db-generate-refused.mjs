// `pnpm db:generate` refuses to run (#535).
//
// drizzle/meta/ holds snapshots only through 0004, while the journal and
// drizzle/ itself have run far past that. `drizzle-kit generate` diffs the
// current schema against the newest snapshot it can find -- 0004 -- so it
// would emit a migration that recreates almost the whole schema. That looks
// like a normal generated migration; only reading the SQL reveals the drops.
// This session's #263 work hit exactly that and had to delete the generated
// file and hand-write 0027_instance_authority.sql instead.
//
// Nothing in this repository depends on generated migrations (house style is
// hand-written, per the decision on #535), so the safe behaviour is to refuse
// outright rather than backfill the missing snapshots.

const MESSAGE = `db:generate is refused: it would silently regenerate the whole schema (#535).

drizzle/meta/ only has snapshots through 0004, but the migration journal has
moved on far past that. drizzle-kit would diff the current schema against the
stale 0004 snapshot and emit a migration that drops and recreates almost
everything -- and the generated file looks like a normal, correct migration
until someone reads it.

Migrations in this repository are hand-written instead. See docs/testing.md,
section "Hand-writing a migration", for the procedure, and
drizzle/0027_instance_authority.sql as the model to follow.
`;

export function main(write = process.stderr.write.bind(process.stderr)) {
  write(MESSAGE);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
