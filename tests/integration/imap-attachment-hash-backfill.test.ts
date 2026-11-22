import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { metadataDamageSightings, metadataKeys } from "@/db/schema";
import { log } from "@/lib/logger";
import { flushMetadataDamageSightings, resetMetadataDamageSightingsForTests } from "@/server/metadata/damage-sightings";
import { runDocumentMaintenanceCycle } from "@/server/document-worker";
import { getImapReview } from "@/server/mail-in/imap-inbox";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { resetMetadataKeyCacheForTests } from "@/server/metadata/keys";
import { syntheticPdf } from "../support/synthetic-documents";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import {
  attachmentColumns, indexFor, openSeal, seedAttachment, seedReceipt, sha256Of, stubPdfinfo, type SealScope,
} from "./support/imap-attachment-hash";

/* #1778, build note E (design note 58551): the backfill.
   `src/server/document-maintenance/imap-attachment-hash-backfill.ts`, shaped
   on `content-index-backfill.ts`: a bounded batch (200) per maintenance cycle,
   never at boot or in a migration, a cursor, damage reported once, a locked
   scope passed over without using the batch. Work: attachment rows with
   `content_sha256 IS NOT NULL`, joined to their message for `household_id`;
   one UPDATE sets `content_index` (instance key, over <messageId>:<sha256>),
   `content_sha256_sealed` (receipt scope of the CURRENT household: instance
   while unattributed) and `content_sha256 = NULL`, guarded
   `WHERE id = ? AND content_sha256 = <value read>`.

   The note does not name the exported function; this file assumes
   `backfillImapAttachmentHashes(limit = 200): Promise<number>` (rows fixed),
   as `backfillDocumentContentIndexes` does. Written from the note alone. */

const { POST: attachToItem } = await loadRoute("households/[householdId]/items/[itemId]/documents");

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));

const unstubPdfinfo = stubPdfinfo();

afterAll(async () => {
  unstubPdfinfo();
  await cleanupIntegrationEnvironment();
});

afterEach(() => {
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

/* Loaded when a test runs, so the module not existing yet fails those tests by
   name instead of stopping the whole file. */
const BACKFILL_MODULE = "@/server/document-maintenance/imap-attachment-hash-backfill";
async function backfill(limit?: number): Promise<number> {
  const module = await import(/* @vite-ignore */ BACKFILL_MODULE) as { backfillImapAttachmentHashes: (limit?: number) => Promise<number> };
  return module.backfillImapAttachmentHashes(limit);
}

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;
const pdf = (label: string) => syntheticPdf(`attachment hash backfill ${label}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const household = (fixture: Fixture, which: "first" | "second" = "first"): SealScope => ({ household: which === "first" ? fixture.household.id : fixture.secondHousehold.id });

async function attachmentUpdatedAt(id: string): Promise<number> {
  const rows = await getDb().execute<{ at: string }>(sql`select updated_at as at from imap_ingestion_attachments where id = ${id}`);
  return new Date(rows[0]!.at).getTime();
}
async function plainCount(): Promise<number> {
  const rows = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from imap_ingestion_attachments where content_sha256 is not null`);
  return Number(rows[0]!.n);
}
/** Runs the backfill until no plain attachment hash is left anywhere, so a bounded batch can only reach the rows a test plants. */
async function drainAll() {
  for (let guard = 0; guard < 200 && await plainCount() > 0; guard += 1) await backfill();
  expect(await plainCount(), "no imap_ingestion_attachments row keeps a plain hash").toBe(0);
}

async function legacyAttachment(fixture: Fixture, householdId: string | null, sha: string, id?: string) {
  const receiptId = await seedReceipt({ userId: fixture.users.member.id, householdId });
  const attachmentId = await seedAttachment(receiptId, { id, sha256: sha, plain: true });
  return { receiptId, attachmentId };
}

async function expectBackfilled(scope: SealScope, receiptId: string, attachmentId: string, sha: string) {
  const row = await attachmentColumns(attachmentId);
  expect(row.plain, "the plain column is emptied").toBeNull();
  expect(row.sealed, "a sealed hash is stored").not.toBeNull();
  expect(row.sealed).not.toContain(sha);
  expect(await openSeal(scope, attachmentId, row.sealed)).toEqual({ ok: true, sha256: sha });
  expect(row.contentIndex, "the index is the instance key's over <messageId>:<sha256>").toBe(await indexFor(receiptId, sha));
  return row;
}

describe("the mail-in attachment hash backfill (#1778)", () => {
  it("seals a plain-hashed row, indexes it, and empties the plain column; an unattributed message seals under the instance key", async () => {
    const fixture = await createIntegrationFixture("attach-backfill-instance");
    try {
      await drainAll();
      const sha = sha256Of("backfill instance");
      const { receiptId, attachmentId } = await legacyAttachment(fixture, null, sha);
      expect((await attachmentColumns(attachmentId)).sealed).toBeNull();
      expect(await backfill()).toBeGreaterThanOrEqual(1);
      await expectBackfilled("instance", receiptId, attachmentId, sha);
      expect((await openSeal(household(fixture), attachmentId, (await attachmentColumns(attachmentId)).sealed)).ok).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("an attributed message seals under its current household's key, with the index still under the instance key", async () => {
    const fixture = await createIntegrationFixture("attach-backfill-household");
    try {
      await drainAll();
      const sha = sha256Of("backfill household");
      const { receiptId, attachmentId } = await legacyAttachment(fixture, fixture.household.id, sha);
      await backfill();
      await expectBackfilled(household(fixture), receiptId, attachmentId, sha);
      expect((await openSeal("instance", attachmentId, (await attachmentColumns(attachmentId)).sealed)).ok).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("a second pass changes nothing", async () => {
    const fixture = await createIntegrationFixture("attach-backfill-idempotent");
    try {
      await drainAll();
      const { attachmentId } = await legacyAttachment(fixture, fixture.household.id, sha256Of("backfill twice"));
      await backfill();
      const first = await attachmentColumns(attachmentId);
      expect(first.sealed).not.toBeNull();
      expect(await backfill()).toBe(0);
      expect(await backfill()).toBe(0);
      expect(await attachmentColumns(attachmentId)).toEqual(first);
    } finally {
      await fixture.cleanup();
    }
  });

  it("works a bounded batch per call: a batch of 2 leaves the third row for a later call, and every row is done in the end", async () => {
    const fixture = await createIntegrationFixture("attach-backfill-batch");
    try {
      await drainAll();
      const shas = [0, 1, 2, 3, 4].map((n) => sha256Of(`backfill batch ${n}`));
      const made = [];
      for (const sha of shas) made.push(await legacyAttachment(fixture, fixture.household.id, sha));
      expect(await backfill(2)).toBeLessThanOrEqual(2);
      expect(await plainCount(), "one call did not take the whole backlog").toBeGreaterThan(0);
      await drainAll();
      for (const [position, one] of made.entries()) await expectBackfilled(household(fixture), one.receiptId, one.attachmentId, shas[position]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("passes over a household whose key will not open without using the batch, seals the others, never empties the skipped row, and seals it once the key opens", async () => {
    const fixture = await createIntegrationFixture("attach-backfill-locked");
    try {
      await drainAll();
      const lockedId = fixture.household.id;
      const lockedShas = [sha256Of("backfill locked 1"), sha256Of("backfill locked 2")];
      /* Ids picked so the locked rows come first in id order: if skipping them used up the batch, the open row would wait. */
      const lockedRows = [] as Array<{ receiptId: string; attachmentId: string }>;
      for (const sha of lockedShas) lockedRows.push(await legacyAttachment(fixture, lockedId, sha, `0${randomUUID().slice(1)}`));
      const openSha = sha256Of("backfill open");
      const open = await legacyAttachment(fixture, fixture.secondHousehold.id, openSha, `f${randomUUID().slice(1)}`);
      const [key] = await getDb().select({ wrapAuthTag: metadataKeys.wrapAuthTag }).from(metadataKeys)
        .where(and(eq(metadataKeys.scope, "household"), eq(metadataKeys.householdId, lockedId)));
      expect(key, "the fixture minted the household's key").toBeTruthy();
      try {
        await getDb().execute(sql`update metadata_keys set wrap_auth_tag = ${randomBytes(16).toString("base64")} where scope = 'household' and household_id = ${lockedId}`);
        resetMetadataKeyCacheForTests();

        await backfill(1); // does not throw, and the one-row batch still reaches the open household's row
        await expectBackfilled(household(fixture, "second"), open.receiptId, open.attachmentId, openSha);
        for (const [position, one] of lockedRows.entries()) {
          const row = await attachmentColumns(one.attachmentId);
          expect(row.plain, "the skipped row is neither emptied nor failed").toBe(lockedShas[position]);
          expect(row.sealed).toBeNull();
        }
        await backfill();
        for (const one of lockedRows) expect((await attachmentColumns(one.attachmentId)).plain).not.toBeNull();
      } finally {
        await getDb().update(metadataKeys).set({ wrapAuthTag: key.wrapAuthTag })
          .where(and(eq(metadataKeys.scope, "household"), eq(metadataKeys.householdId, lockedId)));
        resetMetadataKeyCacheForTests();
      }
      await drainAll();
      for (const [position, one] of lockedRows.entries()) await expectBackfilled(household(fixture), one.receiptId, one.attachmentId, lockedShas[position]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("writes only when the plain value is still the one it read: a hash changed under it is never replaced by a seal of the old one", async () => {
    const fixture = await createIntegrationFixture("attach-backfill-guard");
    try {
      await drainAll();
      const oldSha = sha256Of("backfill guard old");
      const newSha = sha256Of("backfill guard new");
      const { receiptId, attachmentId } = await legacyAttachment(fixture, fixture.household.id, oldSha);

      /* Another writer holds the row, changes its hash, and lets go only once the backfill is waiting on it. */
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const holder = getDb().transaction(async (transaction) => {
        await transaction.execute(sql`select 1 from imap_ingestion_attachments where id = ${attachmentId} for update`);
        locked();
        await gate;
        await transaction.execute(sql`update imap_ingestion_attachments set content_sha256 = ${newSha} where id = ${attachmentId}`);
      });
      await lockTaken;
      const running = backfill();
      for (let waited = 0; waited < 5_000; waited += 50) {
        const rows = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
        if (Number(rows[0]!.n) > 0) break;
        await sleep(50);
      }
      release();
      await holder;
      await running;

      const mid = await attachmentColumns(attachmentId);
      if (mid.sealed !== null) {
        expect(await openSeal(household(fixture), attachmentId, mid.sealed), "never a seal of the stale hash").toEqual({ ok: true, sha256: newSha });
      } else {
        expect(mid.plain, "the changed hash is still there to be sealed").toBe(newSha);
      }
      await drainAll();
      await expectBackfilled(household(fixture), receiptId, attachmentId, newSha);
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports a plain value that is not a SHA-256 once, then clears it (plain, sealed and index all NULL) without blocking the rows behind it (#1931)", async () => {
    const fixture = await createIntegrationFixture("attach-backfill-odd");
    const warn = vi.spyOn(log, "warn");
    try {
      await drainAll();
      await getDb().delete(metadataDamageSightings);
      resetMetadataDamageSightingsForTests();
      const odd = await legacyAttachment(fixture, fixture.household.id, "not-a-hash", `0${randomUUID().slice(1)}`);
      const shas = [0, 1, 2].map((n) => sha256Of(`backfill behind odd ${n}`));
      const behind = [] as Array<{ receiptId: string; attachmentId: string }>;
      for (const sha of shas) behind.push(await legacyAttachment(fixture, fixture.household.id, sha));
      const before = await attachmentUpdatedAt(odd.attachmentId);
      let fixed = 0;
      for (let call = 0; call < 10; call += 1) fixed += await backfill(1);
      const row = await attachmentColumns(odd.attachmentId);
      expect(row.plain, "the plain column is cleared").toBeNull();
      expect(row.sealed, "no seal of garbage").toBeNull();
      expect(row.contentIndex, "no index of garbage").toBeNull();
      expect(fixed, "the clearing counts as a fix: the odd row and the three behind it").toBe(4);
      expect(await attachmentUpdatedAt(odd.attachmentId), "updated_at moves with the clear").toBeGreaterThan(before);
      for (const [position, one] of behind.entries()) await expectBackfilled(household(fixture), one.receiptId, one.attachmentId, shas[position]);

      await flushMetadataDamageSightings();
      const sightings = await getDb().select().from(metadataDamageSightings).where(eq(metadataDamageSightings.rowId, odd.attachmentId));
      expect(sightings, "one damage sighting").toHaveLength(1);
      expect(sightings[0]).toMatchObject({ tableName: "imap_ingestion_attachments", columnName: "content_sha256" });
      const reports = () => warn.mock.calls.filter(([entry]) => (entry as { event?: string }).event === "metadata.integrity" && JSON.stringify(entry).includes(odd.attachmentId)).length;
      expect(reports(), "reported once").toBe(1);
      const settled = await attachmentColumns(odd.attachmentId);
      expect(await backfill()).toBe(0);
      expect(await backfill()).toBe(0);
      expect(reports(), "not reported again").toBe(1);
      expect(await attachmentColumns(odd.attachmentId), "and not touched").toEqual(settled);
      await getDb().execute(sql`delete from imap_ingestion_attachments where id = ${odd.attachmentId}`);
    } finally {
      warn.mockRestore();
      await fixture.cleanup();
    }
  });

  it("leaves a damaged plain value alone when it changed between the read and the write (#1931 guard)", async () => {
    const fixture = await createIntegrationFixture("attach-backfill-odd-guard");
    try {
      await drainAll();
      const newSha = sha256Of("backfill odd guard new");
      const { receiptId, attachmentId } = await legacyAttachment(fixture, fixture.household.id, "not-a-hash");
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const holder = getDb().transaction(async (transaction) => {
        await transaction.execute(sql`select 1 from imap_ingestion_attachments where id = ${attachmentId} for update`);
        locked();
        await gate;
        await transaction.execute(sql`update imap_ingestion_attachments set content_sha256 = ${newSha} where id = ${attachmentId}`);
      });
      await lockTaken;
      const running = backfill();
      for (let waited = 0; waited < 3_000; waited += 50) {
        const rows = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
        if (Number(rows[0]!.n) > 0) break;
        await sleep(50);
      }
      release();
      await holder;
      await running;
      const mid = await attachmentColumns(attachmentId);
      if (mid.sealed !== null) {
        expect(await openSeal(household(fixture), attachmentId, mid.sealed)).toEqual({ ok: true, sha256: newSha });
      } else {
        expect(mid.plain, "the changed value is untouched by the clear").toBe(newSha);
      }
      await drainAll();
      await expectBackfilled(household(fixture), receiptId, attachmentId, newSha);
    } finally {
      await fixture.cleanup();
    }
  });

  it("is part of the maintenance cycle, not of boot or of the migration", async () => {
    const fixture = await createIntegrationFixture("attach-backfill-cycle");
    try {
      await drainAll();
      const sha = sha256Of("backfill cycle");
      const { receiptId, attachmentId } = await legacyAttachment(fixture, fixture.household.id, sha);
      /* Nothing has run since the row was written, so it is exactly as an old row is. */
      expect((await attachmentColumns(attachmentId)).sealed).toBeNull();
      for (let guard = 0; guard < 200 && (await attachmentColumns(attachmentId)).plain !== null; guard += 1) await runDocumentMaintenanceCycle();
      await expectBackfilled(household(fixture), receiptId, attachmentId, sha);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("backfill edge cases (#1778)", () => {
  it("never seals a row under a household the receipt has moved away from: attributed to B between the read and the write, it is not left sealed under A", async () => {
    const fixture = await createIntegrationFixture("attach-backfill-moved");
    try {
      await drainAll();
      const sha = sha256Of("backfill moved");
      const { receiptId, attachmentId } = await legacyAttachment(fixture, fixture.household.id, sha);

      /* Another writer holds the receipt row and moves the receipt to the second household, letting go only once the backfill is waiting. */
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const holder = getDb().transaction(async (transaction) => {
        await transaction.execute(sql`select 1 from imap_ingestion_messages where id = ${receiptId} for update`);
        locked();
        await gate;
        await transaction.execute(sql`update imap_ingestion_messages set household_id = ${fixture.secondHousehold.id} where id = ${receiptId}`);
      });
      await lockTaken;
      const running = backfill();
      for (let waited = 0; waited < 5_000; waited += 50) {
        const rows = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
        if (Number(rows[0]!.n) > 0) break;
        await sleep(50);
      }
      release();
      await holder;
      await running;

      const mid = await attachmentColumns(attachmentId);
      if (mid.sealed !== null) {
        expect((await openSeal(household(fixture), attachmentId, mid.sealed)).ok, "never sealed under the household it left").toBe(false);
        expect((await openSeal(household(fixture, "second"), attachmentId, mid.sealed)).ok).toBe(true);
      } else {
        expect(mid.plain, "left for a later pass").toBe(sha);
      }
      await drainAll();
      await expectBackfilled(household(fixture, "second"), receiptId, attachmentId, sha);
    } finally {
      await fixture.cleanup();
    }
  });

  it("with no plain attachment hash anywhere it returns 0 and opens or creates no metadata key", async () => {
    await drainAll();
    await getDb().execute(sql`delete from metadata_keys`);
    resetMetadataKeyCacheForTests();
    expect(await backfill()).toBe(0);
    expect(await backfill()).toBe(0);
    const [{ n }] = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from metadata_keys`);
    expect(n, "no instance key and no household key appeared").toBe(0);
  });
});

/* ---- 'already held' before and after ---- */

async function upload(fixture: Fixture, session: Session, body: Buffer) {
  const documentId = randomUUID();
  const response = await callRouteForSession(attachToItem, session, {
    url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${fixture.item.id}/documents`,
    method: "POST",
    headers: {
      "content-length": String(body.length),
      "content-type": "application/pdf",
      "x-orbit-filename": encodeURIComponent("Service history.pdf"),
      "x-orbit-document-id": documentId,
    },
    body: new Uint8Array(body),
    params: { householdId: fixture.household.id, itemId: fixture.item.id },
  });
  expect(response.status).toBe(201);
  return documentId;
}

describe("'already held' matches before and after the backfill (#1778)", () => {
  it("an attributed receipt's held attachment is marked while its hash is plain and again once it is sealed", async () => {
    const fixture = await createIntegrationFixture("attach-backfill-held");
    try {
      await drainAll();
      const member = await fixture.session("member");
      const bytes = pdf("held");
      const documentId = await upload(fixture, member, bytes);
      const { receiptId, attachmentId } = await legacyAttachment(fixture, fixture.household.id, sha256Of(bytes));
      type Reviewed = { attachments: Array<{ id: string; alreadyHeld?: { documentId: string } | null }> };
      const before = await getImapReview(member.userId, receiptId, fixture.household.id) as unknown as Reviewed;
      expect(before.attachments.find((one) => one.id === attachmentId)?.alreadyHeld, "marked from the plain hash").toMatchObject({ documentId });

      await drainAll();
      const row = await attachmentColumns(attachmentId);
      expect(row.plain).toBeNull();
      expect(row.sealed).not.toBeNull();
      const after = await getImapReview(member.userId, receiptId, fixture.household.id) as unknown as Reviewed;
      expect(after.attachments.find((one) => one.id === attachmentId)?.alreadyHeld, "marked from the sealed hash").toMatchObject({ documentId });
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);
});

/* #1945: a damaged plain value is cleared only in the transaction that writes
   its damage sighting (record, then clear). Written from the spec alone. */
describe("the backfill records a damaged hash's sighting before it clears the value (#1945)", () => {
  it("a sighting insert that fails leaves the plain value in place", async () => {
    const fixture = await createIntegrationFixture("attach-backfill-clear-unrecorded");
    try {
      await drainAll();
      await getDb().delete(metadataDamageSightings);
      resetMetadataDamageSightingsForTests();
      const odd = await legacyAttachment(fixture, fixture.household.id, "not-a-hash-1945", `0${randomUUID().slice(1)}`);
      await getDb().execute(sql.raw(`
        create or replace function orbit_test_refuse_sighting_1945() returns trigger language plpgsql as $$
        begin
          if new.row_id::text = '${odd.attachmentId}' then raise exception 'sighting write refused by the #1945 test'; end if;
          return new;
        end $$`));
      await getDb().execute(sql.raw(`
        create trigger orbit_test_refuse_sighting_1945 before insert on metadata_damage_sightings
        for each row execute function orbit_test_refuse_sighting_1945()`));
      try {
        // Either shape of a fix is fine: the backfill may throw or skip the row; it must not clear it.
        await backfill().catch(() => 0);
        await flushMetadataDamageSightings();
        const sightings = await getDb().select().from(metadataDamageSightings).where(eq(metadataDamageSightings.rowId, odd.attachmentId));
        expect(sightings, "the trigger let the sighting through, so the test proves nothing").toHaveLength(0);
        expect((await attachmentColumns(odd.attachmentId)).plain, "the damaged value was cleared with no sighting recorded").toBe("not-a-hash-1945");
      } finally {
        await getDb().execute(sql.raw("drop trigger if exists orbit_test_refuse_sighting_1945 on metadata_damage_sightings"));
        await getDb().execute(sql.raw("drop function if exists orbit_test_refuse_sighting_1945()"));
        resetMetadataDamageSightingsForTests();
        await getDb().execute(sql`delete from imap_ingestion_attachments where id = ${odd.attachmentId}`);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("a damaged row that is cleared has its sighting as soon as the call returns, with no flush", async () => {
    const fixture = await createIntegrationFixture("attach-backfill-clear-recorded");
    try {
      await drainAll();
      await getDb().delete(metadataDamageSightings);
      resetMetadataDamageSightingsForTests();
      const odd = await legacyAttachment(fixture, fixture.household.id, "not-a-hash-1945", `0${randomUUID().slice(1)}`);
      try {
        await backfill();
        expect((await attachmentColumns(odd.attachmentId)).plain, "the damaged value is cleared").toBeNull();
        // No flushMetadataDamageSightings() here: the sighting must already be committed.
        const sightings = await getDb().select().from(metadataDamageSightings).where(eq(metadataDamageSightings.rowId, odd.attachmentId));
        expect(sightings, "the sighting is already in the table").toHaveLength(1);
        expect(sightings[0]).toMatchObject({ tableName: "imap_ingestion_attachments", columnName: "content_sha256" });
      } finally {
        resetMetadataDamageSightingsForTests();
        await getDb().execute(sql`delete from imap_ingestion_attachments where id = ${odd.attachmentId}`);
      }
    } finally {
      await fixture.cleanup();
    }
  });
});
