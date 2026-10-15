import { createHash, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { documents, items, memberships, sections } from "@/db/schema";
import { openMetadataReader } from "@/server/metadata/fields";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/* #1316 (owner, 2026-10-13): creating an item with a document is
   all-or-nothing. The document is staged first (a document row with no item
   and a `delete_after` about 24 hours ahead); `item.upsert` then carries
   `documentIds` and the engine binds them to the item in the same transaction,
   clearing `delete_after`. If any id cannot be bound -- unknown, another
   household's, rejected, or already bound to a different item -- the whole
   command is refused and no item is kept. The dry run (ADR-0034) answers the
   same refusal and writes nothing.

   Amendment "sealing context for staged uploads": a staged row records the
   draft item id its ciphertext was sealed under (`documents.sealed_item_id`),
   and binding refuses a document unless `coalesce(sealed_item_id, item_id)` is
   the item being saved. That is what stops a forged or other-draft id from
   attaching a document that could never be opened.

   The staged rows are made here with SQL, not through the stage route, so
   this file tests the binding on its own; the route has its own file. */

const { POST: applyWorkspaceCommand } = await loadRoute("workspace/commands");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const commandUrl = "http://127.0.0.1:3000/api/workspace/commands";
const DAY_MS = 86_400_000;
type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;

function send(session: Session, body: Record<string, unknown>) {
  return callRouteForSession(applyWorkspaceCommand, session, {
    url: commandUrl,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A create of a brand-new item (no version), carrying `documentIds` when given. */
function create(fixture: Fixture, itemId: string, documentIds?: string[], extra: Record<string, unknown> = {}) {
  return {
    type: "item.upsert",
    householdId: fixture.household.id,
    kind: "inspection",
    item: { id: itemId, sectionId: fixture.section.id, title: "Boiler cover", currency: "GBP", dueDate: "2026-11-02", recurrenceMonths: 12 },
    ...(documentIds ? { documentIds } : {}),
    ...extra,
  };
}

/** A staged upload sealed under draft item `itemId`: stored, no item, due to be
 *  tidied away in about a day. `sealed_item_id` is written with SQL so a
 *  missing column is a plain failure rather than a silently dropped field. */
async function stagedDocument(
  householdId: string,
  userId: string,
  itemId: string,
  overrides: Partial<typeof documents.$inferInsert> = {},
) {
  const id = randomUUID();
  const deleteAfter = new Date(Date.now() + DAY_MS);
  await getDb().insert(documents).values({
    id,
    householdId,
    itemId: null,
    uploadedByUserId: userId,
    displayName: "policy.pdf",
    mediaType: "application/pdf",
    sizeBytes: 128,
    contentSha256: createHash("sha256").update(id).digest("hex"),
    lifecycle: "available",
    scanStatus: "skipped",
    availableAt: new Date(),
    deleteAfter,
    ...overrides,
  });
  await getDb().execute(sql`update documents set sealed_item_id = ${itemId} where id = ${id}`);
  return { id, deleteAfter };
}

async function documentRow(id: string) {
  const [found] = await getDb().select({
    itemId: documents.itemId, deleteAfter: documents.deleteAfter, lifecycle: documents.lifecycle,
  }).from(documents).where(eq(documents.id, id));
  return found;
}

async function itemRow(id: string) {
  const [found] = await getDb().select({ id: items.id }).from(items).where(eq(items.id, id));
  return found;
}

describe("item.upsert with documentIds binds staged documents in the same transaction", () => {
  it("binds one staged document to the new item and clears its delete_after", async () => {
    const fixture = await createIntegrationFixture("bind-one");
    const owner = await fixture.session("owner");
    const itemId = randomUUID();
    const staged = await stagedDocument(fixture.household.id, fixture.users.owner.id, itemId);

    const response = await send(owner, create(fixture, itemId, [staged.id]));
    expect(response.status).toBe(200);
    expect(await itemRow(itemId)).toBeDefined();
    expect(await documentRow(staged.id)).toMatchObject({ itemId, deleteAfter: null });
  });

  it("binds several staged documents at once", async () => {
    const fixture = await createIntegrationFixture("bind-several");
    const owner = await fixture.session("owner");
    const itemId = randomUUID();
    const first = await stagedDocument(fixture.household.id, fixture.users.owner.id, itemId);
    const second = await stagedDocument(fixture.household.id, fixture.users.owner.id, itemId);

    const response = await send(owner, create(fixture, itemId, [first.id, second.id]));
    expect(response.status).toBe(200);
    expect(await documentRow(first.id)).toMatchObject({ itemId, deleteAfter: null });
    expect(await documentRow(second.id)).toMatchObject({ itemId, deleteAfter: null });
  });

  it("still creates an item that carries no documentIds, and an empty list", async () => {
    const fixture = await createIntegrationFixture("bind-none");
    const owner = await fixture.session("owner");
    const bare = randomUUID();
    const empty = randomUUID();
    expect((await send(owner, create(fixture, bare))).status).toBe(200);
    expect((await send(owner, create(fixture, empty, []))).status).toBe(200);
    expect(await itemRow(bare)).toBeDefined();
    expect(await itemRow(empty)).toBeDefined();
  });

  it("accepts at most five documentIds, and every one must be a uuid", async () => {
    const fixture = await createIntegrationFixture("bind-limits");
    const owner = await fixture.session("owner");
    const tooMany = randomUUID();
    const five = randomUUID();
    const six = await Promise.all(
      Array.from({ length: 6 }, () => stagedDocument(fixture.household.id, fixture.users.owner.id, tooMany)),
    );
    const fiveStaged = await Promise.all(
      Array.from({ length: 5 }, () => stagedDocument(fixture.household.id, fixture.users.owner.id, five)),
    );
    const refusedMany = await send(owner, create(fixture, tooMany, six.map((one) => one.id)));
    expect(refusedMany.status).toBe(400);
    expect((await refusedMany.json()).error).toMatchObject({ code: "invalid_command" });
    expect(await itemRow(tooMany)).toBeUndefined();

    const notUuid = randomUUID();
    const refusedShape = await send(owner, create(fixture, notUuid, ["not-a-uuid"]));
    expect(refusedShape.status).toBe(400);
    expect(await itemRow(notUuid)).toBeUndefined();

    expect((await send(owner, create(fixture, five, fiveStaged.map((one) => one.id)))).status).toBe(200);
  });

  it("accepts a document already bound to this very item when the item is saved again", async () => {
    const fixture = await createIntegrationFixture("bind-already-this-item");
    const owner = await fixture.session("owner");
    const response = await send(owner, {
      type: "item.upsert",
      householdId: fixture.household.id,
      kind: "inspection",
      item: { id: fixture.item.id, sectionId: fixture.section.id, title: "MOT", currency: "GBP", dueDate: "2026-11-02", recurrenceMonths: 12, version: 2 },
      documentIds: [fixture.document.id],
      activity: { id: randomUUID(), itemId: fixture.item.id, occurredAt: new Date().toISOString() },
    });
    expect(response.status).toBe(200);
    expect(await documentRow(fixture.document.id)).toMatchObject({ itemId: fixture.item.id });
  });

  it("a second send of the same create is the existing version_required, and the first bind stands", async () => {
    const fixture = await createIntegrationFixture("bind-retry-after-landing");
    const owner = await fixture.session("owner");
    const itemId = randomUUID();
    const staged = await stagedDocument(fixture.household.id, fixture.users.owner.id, itemId);
    expect((await send(owner, create(fixture, itemId, [staged.id]))).status).toBe(200);

    const again = await send(owner, create(fixture, itemId, [staged.id]));
    expect((await again.json()).error).toMatchObject({ code: "version_required" });
    expect(await documentRow(staged.id)).toMatchObject({ itemId, deleteAfter: null });
  });

  it("a second send with no documentIds is still the existing version_required", async () => {
    const fixture = await createIntegrationFixture("bind-retry-no-documents");
    const owner = await fixture.session("owner");
    const itemId = randomUUID();
    const staged = await stagedDocument(fixture.household.id, fixture.users.owner.id, itemId);
    expect((await send(owner, create(fixture, itemId, [staged.id]))).status).toBe(200);

    const again = await send(owner, create(fixture, itemId));
    expect((await again.json()).error).toMatchObject({ code: "version_required" });
    expect(await documentRow(staged.id)).toMatchObject({ itemId, deleteAfter: null });
  });

  /* The first Add landed but its answer was lost; the member swaps the file and
     presses Add again with the same draft id. The new file is staged but cannot
     be bound, so the retry must say so (item_already_saved), not version_required,
     which the forms read as "the earlier send landed with its file". */
  describe("a second send of the create that carries a file the item does not have", () => {
    async function landedFirst(label: string) {
      const fixture = await createIntegrationFixture(label);
      const owner = await fixture.session("owner");
      const itemId = randomUUID();
      const first = await stagedDocument(fixture.household.id, fixture.users.owner.id, itemId);
      expect((await send(owner, create(fixture, itemId, [first.id]))).status).toBe(200);
      const second = await stagedDocument(fixture.household.id, fixture.users.owner.id, itemId);
      const [item] = await getDb().select({ version: items.version }).from(items).where(eq(items.id, itemId));
      return {
        fixture, owner, itemId, first, second,
        itemVersion: item?.version,
        secondBefore: await documentRow(second.id),
      };
    }

    async function expectRefusedAndUntouched(
      ran: Awaited<ReturnType<typeof landedFirst>>,
      documentIds: string[],
    ) {
      const again = await send(ran.owner, create(ran.fixture, ran.itemId, documentIds));
      const body = await again.json();
      expect(body.error).toMatchObject({ code: "item_already_saved" });
      expect(again.status).toBe(409);
      expect(await documentRow(ran.first.id), "the first file is still bound").toMatchObject({ itemId: ran.itemId, deleteAfter: null });
      const secondNow = await documentRow(ran.second.id);
      expect(secondNow, "the new file stays staged and unbound").toEqual(ran.secondBefore);
      expect(secondNow?.itemId).toBeNull();
      expect(secondNow?.deleteAfter?.getTime()).toBe(ran.second.deleteAfter.getTime());
      const [item] = await getDb().select({ version: items.version }).from(items).where(eq(items.id, ran.itemId));
      expect(item?.version, "the item is unchanged").toBe(ran.itemVersion);
    }

    it("with only the new file is refused as item_already_saved, and nothing changes", async () => {
      const ran = await landedFirst("bind-retry-swapped-file");
      await expectRefusedAndUntouched(ran, [ran.second.id]);
    });

    it("with the first file and the new one is refused the same way", async () => {
      const ran = await landedFirst("bind-retry-added-file");
      await expectRefusedAndUntouched(ran, [ran.first.id, ran.second.id]);
    });
  });
});

/* #1316: the pocket form keeps its draft id when the member switches household
   after a send whose answer was lost. The item already exists in the first
   household, and items.id is a global key, so the send under the second
   household must be refused as item_conflict (409; the dry run answers the
   same refusal) rather than hit the key and answer 500. */
describe("a create sent again under another household (the member switched household after a lost answer)", () => {
  async function landedUnderFirst(label: string) {
    const fixture = await createIntegrationFixture(label);
    const owner = await fixture.session("owner");
    await getDb().insert(memberships).values({
      householdId: fixture.secondHousehold.id, userId: fixture.users.owner.id, role: "member",
    });
    const [secondSection] = await getDb().select({ id: sections.id }).from(sections)
      .where(eq(sections.householdId, fixture.secondHousehold.id));
    expect(secondSection, "the fixture makes a section in the second household").toBeDefined();
    const itemId = randomUUID();
    expect((await send(owner, create(fixture, itemId))).status).toBe(200);
    return { fixture, owner, itemId, secondSectionId: secondSection.id };
  }

  function underSecond(ran: Awaited<ReturnType<typeof landedUnderFirst>>, documentIds?: string[], extra: Record<string, unknown> = {}) {
    const first = create(ran.fixture, ran.itemId, documentIds, extra);
    return {
      ...first,
      householdId: ran.fixture.secondHousehold.id,
      item: { ...(first.item as Record<string, unknown>), sectionId: ran.secondSectionId },
    };
  }

  async function expectOnlyInFirst(ran: Awaited<ReturnType<typeof landedUnderFirst>>) {
    const rows = await getDb().select({ householdId: items.householdId, version: items.version })
      .from(items).where(eq(items.id, ran.itemId));
    expect(rows, "one items row, still in the first household at version 1").toEqual([
      { householdId: ran.fixture.household.id, version: 1 },
    ]);
  }

  it("is refused as item_conflict, and the item stays in the first household", async () => {
    const ran = await landedUnderFirst("other-household-resend");
    const again = await send(ran.owner, underSecond(ran));
    const body = await again.json();
    expect(body.error).toMatchObject({ code: "item_conflict" });
    expect(again.status).toBe(409);
    await expectOnlyInFirst(ran);
  });

  it("with a staged file in the second household is the same refusal, and the file stays staged", async () => {
    const ran = await landedUnderFirst("other-household-resend-file");
    const staged = await stagedDocument(ran.fixture.secondHousehold.id, ran.fixture.users.owner.id, ran.itemId);
    const before = await documentRow(staged.id);
    const again = await send(ran.owner, underSecond(ran, [staged.id]));
    const body = await again.json();
    expect(body.error).toMatchObject({ code: "item_conflict" });
    expect(again.status).toBe(409);
    const after = await documentRow(staged.id);
    expect(after).toEqual(before);
    expect(after?.itemId).toBeNull();
    expect(after?.deleteAfter?.getTime()).toBe(staged.deleteAfter.getTime());
    await expectOnlyInFirst(ran);
  });

  it("in the dry run gives the same refusal and writes nothing", async () => {
    const ran = await landedUnderFirst("other-household-resend-dry");
    const dry = await send(ran.owner, underSecond(ran, undefined, { dryRun: true }));
    // A dry run is a question: it answers 200 with the real call's refusal.
    expect(dry.status).toBe(200);
    expect((await dry.json()).refusal).toMatchObject({ code: "item_conflict" });
    await expectOnlyInFirst(ran);
  });

  describe("guards", () => {
    it("a same-household resend is still version_required", async () => {
      const ran = await landedUnderFirst("other-household-guard-same");
      const again = await send(ran.owner, create(ran.fixture, ran.itemId));
      expect((await again.json()).error).toMatchObject({ code: "version_required" });
      await expectOnlyInFirst(ran);
    });

    it("a create under the second household with a brand-new id lands", async () => {
      const ran = await landedUnderFirst("other-household-guard-new");
      const fresh = randomUUID();
      const response = await send(ran.owner, underSecond({ ...ran, itemId: fresh }));
      expect(response.status).toBe(200);
      const [row] = await getDb().select({ householdId: items.householdId }).from(items).where(eq(items.id, fresh));
      expect(row?.householdId).toBe(ran.fixture.secondHousehold.id);
    });
  });
});

describe("a document that cannot be bound refuses the whole command and leaves no item", () => {
  const WORDS = /no longer available/iu;

  async function expectRefusedWhole(
    fixture: Fixture,
    session: Session,
    itemId: string,
    documentIds: string[],
    untouched: { id: string; before: Awaited<ReturnType<typeof documentRow>> }[],
  ) {
    const response = await send(session, create(fixture, itemId, documentIds));
    expect(response.status).toBe(422);
    const { error } = await response.json();
    expect(error.message, "the engine's words, naming the document").toMatch(WORDS);
    expect(await itemRow(itemId), "no item is kept").toBeUndefined();
    for (const one of untouched) expect(await documentRow(one.id), "no document was bound").toEqual(one.before);
    return error as { code: string; message: string };
  }

  it("an unknown document id", async () => {
    const fixture = await createIntegrationFixture("refuse-unknown");
    const owner = await fixture.session("owner");
    await expectRefusedWhole(fixture, owner, randomUUID(), [randomUUID()], []);
  });

  it("another household's document, in the same words as an unknown one", async () => {
    const fixture = await createIntegrationFixture("refuse-foreign");
    const owner = await fixture.session("owner");
    const itemId = randomUUID();
    // Sealed under the very item id being saved, so only the household check can refuse it.
    const foreign = await stagedDocument(fixture.secondHousehold.id, fixture.users.secondOwner.id, itemId);
    const before = await documentRow(foreign.id);
    const foreignError = await expectRefusedWhole(fixture, owner, itemId, [foreign.id], [{ id: foreign.id, before }]);
    const unknownError = await expectRefusedWhole(fixture, owner, randomUUID(), [randomUUID()], []);
    expect(foreignError).toEqual(unknownError);
  });

  it("a rejected document", async () => {
    const fixture = await createIntegrationFixture("refuse-rejected");
    const owner = await fixture.session("owner");
    const itemId = randomUUID();
    const rejected = await stagedDocument(fixture.household.id, fixture.users.owner.id, itemId, {
      lifecycle: "rejected", scanStatus: "infected", failureCode: "malware_detected", availableAt: null,
    });
    await expectRefusedWhole(fixture, owner, itemId, [rejected.id], [{ id: rejected.id, before: await documentRow(rejected.id) }]);
  });

  it("a staged document already queued for deletion or deleted (amendment: lifecycle not rejected/deleted/pending_deletion)", async () => {
    const fixture = await createIntegrationFixture("refuse-retired");
    const owner = await fixture.session("owner");
    for (const lifecycle of ["pending_deletion", "deleted"] as const) {
      const itemId = randomUUID();
      const retired = await stagedDocument(fixture.household.id, fixture.users.owner.id, itemId, {
        lifecycle, scanStatus: "clean", ...(lifecycle === "deleted" ? { deletedAt: new Date(), availableAt: null } : {}),
      });
      await expectRefusedWhole(fixture, owner, itemId, [retired.id], [{ id: retired.id, before: await documentRow(retired.id) }]);
    }
  });

  it("a document already bound to a different item", async () => {
    const fixture = await createIntegrationFixture("refuse-bound-elsewhere");
    const owner = await fixture.session("owner");
    const before = await documentRow(fixture.document.id);
    expect(before?.itemId).toBe(fixture.item.id);
    await expectRefusedWhole(fixture, owner, randomUUID(), [fixture.document.id], [{ id: fixture.document.id, before }]);
  });

  it("one bad id among good ones binds none of them", async () => {
    const fixture = await createIntegrationFixture("refuse-mixed");
    const owner = await fixture.session("owner");
    const itemId = randomUUID();
    const good = await stagedDocument(fixture.household.id, fixture.users.owner.id, itemId);
    const before = await documentRow(good.id);
    await expectRefusedWhole(fixture, owner, itemId, [good.id, randomUUID()], [{ id: good.id, before }]);
    expect(before).toMatchObject({ itemId: null });
    expect(before?.deleteAfter).not.toBeNull();
  });

  it("a document sealed under a different draft item id (amendment)", async () => {
    const fixture = await createIntegrationFixture("refuse-sealed-elsewhere");
    const owner = await fixture.session("owner");
    const draftA = randomUUID();
    const itemB = randomUUID();
    const sealedToA = await stagedDocument(fixture.household.id, fixture.users.owner.id, draftA);
    const before = await documentRow(sealedToA.id);
    await expectRefusedWhole(fixture, owner, itemB, [sealedToA.id], [{ id: sealedToA.id, before }]);
    // It is the same words as for an unknown id: the member learns nothing about other drafts.
    const sealedError = await expectRefusedWhole(fixture, owner, itemB, [sealedToA.id], [{ id: sealedToA.id, before }]);
    const unknownError = await expectRefusedWhole(fixture, owner, itemB, [randomUUID()], []);
    expect(sealedError).toEqual(unknownError);
  });

  it("a mismatched id among good ones binds none of them", async () => {
    const fixture = await createIntegrationFixture("refuse-sealed-mixed");
    const owner = await fixture.session("owner");
    const itemId = randomUUID();
    const good = await stagedDocument(fixture.household.id, fixture.users.owner.id, itemId);
    const other = await stagedDocument(fixture.household.id, fixture.users.owner.id, randomUUID());
    await expectRefusedWhole(fixture, owner, itemId, [good.id, other.id], [
      { id: good.id, before: await documentRow(good.id) },
      { id: other.id, before: await documentRow(other.id) },
    ]);
  });

  it("an upload that has no sealing record and no item (a row the sealed check cannot vouch for)", async () => {
    const fixture = await createIntegrationFixture("refuse-unsealed");
    const owner = await fixture.session("owner");
    const itemId = randomUUID();
    const unsealed = await stagedDocument(fixture.household.id, fixture.users.owner.id, itemId);
    await getDb().execute(sql`update documents set sealed_item_id = null where id = ${unsealed.id}`);
    await expectRefusedWhole(fixture, owner, itemId, [unsealed.id], [{ id: unsealed.id, before: await documentRow(unsealed.id) }]);
  });

  it("refuses an edit of an existing item the same way, and leaves the item's other fields alone", async () => {
    const fixture = await createIntegrationFixture("refuse-on-edit");
    const owner = await fixture.session("owner");
    const response = await send(owner, {
      type: "item.upsert",
      householdId: fixture.household.id,
      kind: "inspection",
      item: { id: fixture.item.id, sectionId: fixture.section.id, title: "Renamed by a refused save", currency: "GBP", dueDate: "2026-11-02", recurrenceMonths: 12, version: 2 },
      documentIds: [randomUUID()],
      activity: { id: randomUUID(), itemId: fixture.item.id, occurredAt: new Date().toISOString() },
    });
    expect(response.status).toBe(422);
    const [stored] = await getDb().select({ titleEnc: items.titleEnc }).from(items).where(eq(items.id, fixture.item.id));
    const reader = await openMetadataReader(fixture.household.id);
    expect(reader.text("items.title", fixture.item.id, { encrypted: stored.titleEnc }).value).not.toBe("Renamed by a refused save");
  });
});

describe("the dry run checks documentIds the same way and writes nothing", () => {
  it("answers the refusal as a 200 verdict for an unbindable id, creating no item", async () => {
    const fixture = await createIntegrationFixture("dry-refuses");
    const owner = await fixture.session("owner");
    const itemId = randomUUID();
    const dry = await send(owner, { ...create(fixture, itemId, [randomUUID()]), dryRun: true });
    expect(dry.status).toBe(200);
    const verdict = await dry.json();
    expect(verdict.refusal.message).toMatch(/no longer available/iu);

    const real = await send(owner, create(fixture, itemId, [randomUUID()]));
    expect(real.status).toBe(422);
    expect((await real.json()).error).toEqual(verdict.refusal);
    expect(await itemRow(itemId)).toBeUndefined();
  });

  it("refuses a foreign, a rejected and a bound-elsewhere document in the dry run too", async () => {
    const fixture = await createIntegrationFixture("dry-refuses-each");
    const owner = await fixture.session("owner");
    const itemId = randomUUID();
    const foreign = await stagedDocument(fixture.secondHousehold.id, fixture.users.secondOwner.id, itemId);
    const rejected = await stagedDocument(fixture.household.id, fixture.users.owner.id, itemId, {
      lifecycle: "rejected", scanStatus: "infected", failureCode: "malware_detected", availableAt: null,
    });
    const sealedElsewhere = await stagedDocument(fixture.household.id, fixture.users.owner.id, randomUUID());
    for (const id of [foreign.id, rejected.id, fixture.document.id, sealedElsewhere.id]) {
      const dry = await send(owner, { ...create(fixture, itemId, [id]), dryRun: true });
      expect(dry.status).toBe(200);
      const verdict = await dry.json();
      expect(verdict.refusal?.message).toMatch(/no longer available/iu);
      expect(await itemRow(itemId)).toBeUndefined();

      // ADR-0034: the real call refuses with the very words the dry run gave.
      const real = await send(owner, create(fixture, itemId, [id]));
      expect(real.status, `real call for ${id}`).toBe(422);
      expect((await real.json()).error).toEqual(verdict.refusal);
      expect(await itemRow(itemId)).toBeUndefined();
    }
  });

  it("a dry run of a staged document sealed under another draft is refused, though the same document would bind under its own draft", async () => {
    const fixture = await createIntegrationFixture("dry-sealed-guard");
    const owner = await fixture.session("owner");
    const draftA = randomUUID();
    const itemB = randomUUID();
    const staged = await stagedDocument(fixture.household.id, fixture.users.owner.id, draftA);

    const wrong = await send(owner, { ...create(fixture, itemB, [staged.id]), dryRun: true });
    expect(wrong.status).toBe(200);
    expect((await wrong.json()).refusal?.message).toMatch(/no longer available/iu);

    const right = await send(owner, { ...create(fixture, draftA, [staged.id]), dryRun: true });
    expect(right.status).toBe(200);
    expect(await right.json()).toEqual({});
    expect(await documentRow(staged.id)).toMatchObject({ itemId: null });
  });

  it("passes a bindable document and binds nothing", async () => {
    const fixture = await createIntegrationFixture("dry-accepts");
    const owner = await fixture.session("owner");
    const itemId = randomUUID();
    const staged = await stagedDocument(fixture.household.id, fixture.users.owner.id, itemId);
    const dry = await send(owner, { ...create(fixture, itemId, [staged.id]), dryRun: true });
    expect(dry.status).toBe(200);
    expect(await dry.json()).toEqual({});
    expect(await itemRow(itemId)).toBeUndefined();
    const stored = await documentRow(staged.id);
    expect(stored?.itemId).toBeNull();
    expect(stored?.deleteAfter?.getTime()).toBe(staged.deleteAfter.getTime());
  });

  it("leaves every staged document unbound after a refused real call", async () => {
    const fixture = await createIntegrationFixture("refused-leaves-staged");
    const owner = await fixture.session("owner");
    const itemId = randomUUID();
    const staged = await stagedDocument(fixture.household.id, fixture.users.owner.id, itemId);
    const response = await send(owner, create(fixture, itemId, [staged.id], {
      item: { id: itemId, sectionId: fixture.section.id, title: "  ", currency: "GBP" },
    }));
    expect(response.status).toBe(422);
    const [{ itemId: boundTo, deleteAfter }] = await getDb().select({ itemId: documents.itemId, deleteAfter: documents.deleteAfter })
      .from(documents).where(inArray(documents.id, [staged.id]));
    expect(boundTo).toBeNull();
    expect(deleteAfter?.getTime()).toBe(staged.deleteAfter.getTime());
  });
});
