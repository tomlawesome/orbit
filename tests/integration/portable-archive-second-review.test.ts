import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { portableArchiveImports } from "@/db/schema";
import { householdOwnerLockKey } from "@/lib/auth/authority-locks";
import { importPortableArchive, rollBackStaleUnfinishedPortableImports } from "@/server/portable-archive-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";

/**
 * #1390 second review, F3: the stale-import rollback chooses its rows outside
 * the household lock and, once inside it, must look again. An import that is
 * live (its heartbeat renewed between the selection and the lock) must not be
 * rolled back, whichever path chose it: the document worker's sweep or the
 * stale sweep in front of a new import.
 *
 * The pause is the household lock itself: the test holds the same advisory
 * lock the rollback takes, so the rollback is stopped after its selection and
 * before its checks; the heartbeat is renewed in the lock holder's
 * transaction; the lock is released.
 */
afterAll(cleanupIntegrationEnvironment);

type Fixture = IntegrationFixture;
const realDelay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function expiredOpenRow(fixture: Fixture): Promise<string> {
  const [row] = await getDb().insert(portableArchiveImports).values({
    householdId: fixture.household.id,
    actorUserId: fixture.users.owner.id,
    startedAt: new Date(Date.now() - 3 * 60 * 60_000),
    finishedAt: null,
    createdSectionIds: [],
    createdItemIds: [],
  }).returning({ id: portableArchiveImports.id });
  await getDb().execute(sql`update portable_archive_imports set lease_renewed_at = now() - interval '2 hours' where id = ${row.id}`);
  return row.id;
}

/** Runs `sweep` while the household lock is held; renews the heartbeat while it waits; then lets it go. */
async function renewWhileSweepWaits(fixture: Fixture, rowId: string, sweep: () => Promise<unknown>): Promise<void> {
  let sweeping!: Promise<unknown>;
  await getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${householdOwnerLockKey(fixture.household.id)}, 0))`);
    sweeping = sweep().catch(() => undefined);
    // The sweep has chosen the row and is waiting for the lock.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await transaction.execute(sql`select 1 from pg_locks where locktype = 'advisory' and not granted`);
      if (waiting.length > 0) break;
      await realDelay(100);
    }
    await realDelay(300);
    await transaction.execute(sql`update portable_archive_imports set lease_renewed_at = now() where id = ${rowId}`);
  });
  await sweeping;
}

async function stateOf(rowId: string) {
  const [row] = await getDb().execute(sql`select finished_at, outcome from portable_archive_imports where id = ${rowId}`) as unknown as Array<{ finished_at: Date | null; outcome: string | null }>;
  return row;
}

describe("F3: a live import is not rolled back by a sweep that chose it before its heartbeat renewed", () => {
  it("the document worker's sweep leaves an import whose heartbeat renewed between the selection and the lock", async () => {
    // Catches a rollback that, once inside the lock, checks only finishedAt: it undoes an import that is alive.
    const fixture = await createIntegrationFixture("arch1390-f3-worker");
    const rowId = await expiredOpenRow(fixture);

    await renewWhileSweepWaits(fixture, rowId, () => rollBackStaleUnfinishedPortableImports());

    expect(await stateOf(rowId)).toMatchObject({ finished_at: null, outcome: null });
  }, 120_000);

  it("the sweep in front of a new import for the same household leaves it too", async () => {
    // The household's own path: importPortableArchive sweeps its stale row before it starts (it then fails on the junk archive; that is not the point).
    const fixture = await createIntegrationFixture("arch1390-f3-household");
    const rowId = await expiredOpenRow(fixture);
    const junk = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8)); controller.close(); } });

    await renewWhileSweepWaits(fixture, rowId, () => importPortableArchive({
      userId: fixture.users.owner.id, householdId: fixture.household.id, archive: junk, passphrase: "correct-horse-battery-staple", conflictItemIds: [],
    }));

    expect(await stateOf(rowId)).toMatchObject({ finished_at: null, outcome: null });
  }, 120_000);

  it("control: a row whose lease really is expired is still rolled back", async () => {
    // Catches a fix that stops rolling back anything.
    const fixture = await createIntegrationFixture("arch1390-f3-control");
    const rowId = await expiredOpenRow(fixture);

    await rollBackStaleUnfinishedPortableImports();

    expect(await stateOf(rowId)).toMatchObject({ outcome: "rolled_back" });
  }, 120_000);
});
