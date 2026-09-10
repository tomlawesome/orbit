/**
 * Tier 2 metadata encryption end to end (#963, ADR-0024): `items.title`,
 * `items.provider`, the cost, and the invited member address.
 *
 * Tier 2 adds no key and no cipher — it rides the per-household DEK Tier 1
 * minted — so what is worth proving here is different from #931's: that the
 * plaintext is genuinely gone from the row, that the jobs the tiering decision
 * moved into the application (search, cost totals, duplicate detection) still
 * give the same answers, that the database rule the invitation address carried
 * survived the move to a blind index, and that a KEK rotation covers the new
 * rows — the #955 failure, checked rather than assumed.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { householdInvitations, items, metadataKeys } from "@/db/schema";
import { deriveDocumentKeyId, getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { resetMetadataKeyCacheForTests } from "@/server/metadata/keys";
import { rotationComplete, runKekRotationToCompletion, type RotationKeys } from "@/server/documents/rewrap-worker";
import { runMetadataBackfillBatch } from "@/server/metadata/backfill";
import { readWorkspace, applyWorkspaceCommand } from "@/server/workspace-repository";
import { listHouseholdInvitations, sendHouseholdInvitation } from "@/server/invitations";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;

async function sectionOf(itemId: string): Promise<string> {
  const [row] = await getDb().select({ id: items.sectionId }).from(items).where(eq(items.id, itemId));
  return row.id;
}

async function writeItem(input: {
  userId: string;
  householdId: string;
  sectionId: string;
  title: string;
  provider?: string;
  costMinor?: number;
}): Promise<string> {
  const itemId = randomUUID();
  await applyWorkspaceCommand(input.userId, "metadata-tier2-test", {
    type: "item.upsert",
    householdId: input.householdId,
    item: {
      id: itemId,
      sectionId: input.sectionId,
      title: input.title,
      provider: input.provider,
      costMinor: input.costMinor,
      currency: "GBP",
      status: "active",
    },
  });
  return itemId;
}

async function workspaceItems(fixture: Fixture) {
  const session = await fixture.session("member");
  const workspace = await readWorkspace(fixture.users.member.id, session.sessionId);
  return workspace.households.find((candidate) => candidate.id === fixture.household.id)!.items;
}

describe("Tier 2 values are written and read encrypted (#963)", () => {
  it("leaves no title, provider or cost readable in the row, and reads all three back", async () => {
    const fixture = await createIntegrationFixture("tier2-round-trip");
    const itemId = await writeItem({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      sectionId: await sectionOf(fixture.item.id),
      title: "Car insurance",
      provider: "Admiral",
      costMinor: 58_200,
    });

    const [stored] = await getDb().select().from(items).where(eq(items.id, itemId));
    // The whole point of the tier: a database file leaked from this instance
    // carries none of the three in readable form.
    expect(stored.title).toBeNull();
    expect(stored.provider).toBeNull();
    expect(stored.costMinor).toBeNull();
    expect(stored.titleEnc?.startsWith("mdv1.")).toBe(true);
    expect(stored.providerEnc?.startsWith("mdv1.")).toBe(true);
    expect(stored.costMinorEnc?.startsWith("mdv1.")).toBe(true);
    expect(stored.titleEnc).not.toContain("Car insurance");
    expect(stored.providerEnc).not.toContain("Admiral");
    expect(stored.costMinorEnc).not.toContain("58200");

    // No blind index was built for any of them (ADR-0024 decision 2 asks
    // whether one is needed first): nothing looks an item up by title,
    // provider or cost, so there is no equality to leak.
    const columns = await getDb().execute<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'items'",
    );
    const names = [...columns].map((row) => row.column_name);
    expect(names).toContain("title_enc");
    expect(names).not.toContain("title_index");
    expect(names).not.toContain("provider_index");
    expect(names).not.toContain("cost_minor_index");

    const read = (await workspaceItems(fixture)).find((candidate) => candidate.id === itemId)!;
    expect(read.title).toBe("Car insurance");
    expect(read.provider).toBe("Admiral");
    expect(read.costMinor).toBe(58_200);
    expect(read.metadataStatus).toBeUndefined();

    // Still one DEK for the household: Tier 2 mints no key of its own.
    const keys = await getDb().select().from(metadataKeys).where(eq(metadataKeys.householdId, fixture.household.id));
    expect(keys).toHaveLength(1);
  });

  it("sums cost totals and searches titles in the application, over decrypted values", async () => {
    const fixture = await createIntegrationFixture("tier2-app-side-jobs");
    const sectionId = await sectionOf(fixture.item.id);
    const written = [
      { title: "Car insurance", provider: "Admiral", costMinor: 58_200 },
      { title: "Boiler service", provider: "Warm & Co.", costMinor: 10_900 },
      { title: "Broadband contract", provider: "HyperNet", costMinor: 4_200 },
    ];
    for (const item of written) {
      await writeItem({ userId: fixture.users.member.id, householdId: fixture.household.id, sectionId, ...item });
    }

    // Nothing in this household still holds a plaintext cost, so a SQL sum
    // could not produce this figure — the application's own sum over the
    // decrypted values is what does (#365, owner 2026-08-13).
    expect(await getDb().select({ id: items.id }).from(items)
      .where(and(eq(items.householdId, fixture.household.id), isNotNull(items.costMinor))))
      .toHaveLength(0);

    const visible = await workspaceItems(fixture);
    const total = visible.reduce((sum, item) => sum + (item.costMinor ?? 0), 0);
    expect(total).toBe(73_300);

    // Decrypt-and-scan search, at household scale, is the trade the decision
    // named: the same substring match a SQL `ilike` used to be able to do.
    const matches = visible.filter((item) => item.title.toLowerCase().includes("insur"));
    expect(matches.map((item) => item.title)).toEqual(["Car insurance"]);
    const byProvider = visible.filter((item) => item.provider?.toLowerCase() === "hypernet");
    expect(byProvider.map((item) => item.title)).toEqual(["Broadband contract"]);
  });

  it("keeps one household's title unreadable with another household's key", async () => {
    const fixture = await createIntegrationFixture("tier2-household-isolation");
    const itemId = await writeItem({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      sectionId: await sectionOf(fixture.item.id),
      title: "Private title",
    });
    const [stored] = await getDb().select({ titleEnc: items.titleEnc }).from(items).where(eq(items.id, itemId));

    // Writing in the second household is what mints its key.
    await writeItem({
      userId: fixture.users.secondOwner.id,
      householdId: fixture.secondHousehold.id,
      sectionId: await sectionOf(fixture.secondItem.id),
      title: "Private title",
    });
    const { openMetadataReader } = await import("@/server/metadata/fields");
    const otherReader = await openMetadataReader(fixture.secondHousehold.id);
    expect(otherReader.text("items.title", itemId, { encrypted: stored.titleEnc, plaintext: null }).state)
      .toBe("metadata_integrity_failed");
  });
});

describe("the backfill converts pre-existing Tier 2 plaintext (#963)", () => {
  it("encrypts a row written before the release and clears every plaintext column in the same statement", async () => {
    const fixture = await createIntegrationFixture("tier2-backfill");
    // Straight to SQL, which is exactly the shape of a row that predates the
    // expand release: plaintext present, ciphertext absent.
    const legacyId = randomUUID();
    await getDb().insert(items).values({
      id: legacyId,
      householdId: fixture.household.id,
      sectionId: await sectionOf(fixture.item.id),
      title: "Legacy item",
      provider: "Legacy provider",
      costMinor: 1_234,
      reference: "LEG-1",
      notes: "legacy notes",
      currency: "GBP",
    });

    // Readable before the backfill runs: the dual read is what makes the
    // expand release safe, and a row it has not reached is not broken.
    const before = (await workspaceItems(fixture)).find((candidate) => candidate.id === legacyId)!;
    expect(before.title).toBe("Legacy item");
    expect(before.costMinor).toBe(1_234);

    let guard = 0;
    while (guard++ < 20) {
      const batch = await runMetadataBackfillBatch(100);
      if (batch.items === 0 && batch.receipts === 0 && batch.invitations === 0) break;
    }

    const [converted] = await getDb().select().from(items).where(eq(items.id, legacyId));
    expect(converted.title).toBeNull();
    expect(converted.provider).toBeNull();
    expect(converted.costMinor).toBeNull();
    expect(converted.reference).toBeNull();
    expect(converted.notes).toBeNull();
    expect(converted.titleEnc?.startsWith("mdv1.")).toBe(true);
    expect(converted.providerEnc?.startsWith("mdv1.")).toBe(true);
    expect(converted.costMinorEnc?.startsWith("mdv1.")).toBe(true);

    const after = (await workspaceItems(fixture)).find((candidate) => candidate.id === legacyId)!;
    expect(after.title).toBe("Legacy item");
    expect(after.provider).toBe("Legacy provider");
    expect(after.costMinor).toBe(1_234);
  });
});

describe("the invited address is encrypted, and its database rule survives (#963)", () => {
  it("stores the address as an envelope, keeps one open invitation per address, and still lists it", async () => {
    const fixture = await createIntegrationFixture("tier2-invitations");
    const address = "invited.person@example.com";
    await sendHouseholdInvitation(fixture.users.owner.id, fixture.household.id, address, { mailer: null });

    const [stored] = await getDb().select().from(householdInvitations)
      .where(eq(householdInvitations.householdId, fixture.household.id));
    expect(stored.email).toBeNull();
    expect(stored.emailEnc?.startsWith("mdv1.")).toBe(true);
    expect(stored.emailEnc).not.toContain("invited.person");
    expect(stored.emailIndex).toBeTruthy();
    expect(stored.emailIndex).not.toContain("invited.person");

    // The list still shows the address to a member who may see it.
    const listed = await listHouseholdInvitations(fixture.users.owner.id, fixture.household.id);
    expect(listed.map((row) => row.email)).toEqual([address]);

    // A resend for the same address, differently cased, still finds the one
    // open invitation and REPLACES it rather than opening a second — which is
    // the rule the blind index carried across from the plaintext index.
    await sendHouseholdInvitation(fixture.users.owner.id, fixture.household.id, "Invited.Person@Example.com", { mailer: null });
    const open = await getDb().select({ id: householdInvitations.id }).from(householdInvitations)
      .where(and(
        eq(householdInvitations.householdId, fixture.household.id),
        isNull(householdInvitations.redeemedAt),
        isNull(householdInvitations.revokedAt),
      ));
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(stored.id);

    // And a different address does open a second one, so the rule has not
    // simply become "one invitation per household".
    await sendHouseholdInvitation(fixture.users.owner.id, fixture.household.id, "someone.else@example.com", { mailer: null });
    expect(await listHouseholdInvitations(fixture.users.owner.id, fixture.household.id)).toHaveLength(2);
  });
});

describe("a KEK rotation covers the Tier 2 rows (#963, ADR-0017's contract, the #955 failure)", () => {
  it("re-reads every Tier 2 value after a full rotation, with no value rewritten", async () => {
    const fixture = await createIntegrationFixture("tier2-rotation-drill");
    const sectionId = await sectionOf(fixture.item.id);
    const itemId = await writeItem({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      sectionId,
      title: "Rotated item",
      provider: "Rotated provider",
      costMinor: 4_242,
    });
    await sendHouseholdInvitation(fixture.users.owner.id, fixture.household.id, "rotation@example.com", { mailer: null });

    const [beforeItem] = await getDb().select({ titleEnc: items.titleEnc, providerEnc: items.providerEnc, costMinorEnc: items.costMinorEnc })
      .from(items).where(eq(items.id, itemId));
    const [beforeInvitation] = await getDb().select({ emailEnc: householdInvitations.emailEnc, emailIndex: householdInvitations.emailIndex })
      .from(householdInvitations).where(eq(householdInvitations.householdId, fixture.household.id));
    const [beforeKey] = await getDb().select().from(metadataKeys).where(eq(metadataKeys.householdId, fixture.household.id));

    const current = getDocumentConfig();
    const originalKek = process.env.DOCUMENT_KEK;
    const nextKek = randomBytes(32);
    const nextHex = nextKek.toString("hex");
    const keys: RotationKeys = {
      currentKek: current.keyEncryptionKey,
      currentKeyId: current.keyId,
      nextKek,
      nextKeyId: deriveDocumentKeyId(nextKek),
    };

    try {
      process.env.DOCUMENT_KEK_NEXT = nextHex;
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();

      expect(rotationComplete(await runKekRotationToCompletion(keys))).toBe(true);

      // Step 4 of the operator's procedure: promote the next key, drop the
      // overlay. This is the moment a rotation that had skipped Tier 2 would
      // show it — the old KEK is gone.
      process.env.DOCUMENT_KEK = nextHex;
      delete process.env.DOCUMENT_KEK_NEXT;
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();
      expect(getDocumentConfig().keyId).toBe(keys.nextKeyId);

      const read = (await workspaceItems(fixture)).find((candidate) => candidate.id === itemId)!;
      expect(read.title).toBe("Rotated item");
      expect(read.provider).toBe("Rotated provider");
      expect(read.costMinor).toBe(4_242);
      expect(read.metadataStatus).toBeUndefined();
      const listed = await listHouseholdInvitations(fixture.users.owner.id, fixture.household.id);
      expect(listed.map((row) => row.email)).toEqual(["rotation@example.com"]);

      // Only the wrapping changed. Not one value was rewritten and not one
      // index was rebuilt, which is what makes the rotation O(households)
      // rather than O(rows) (ADR-0024 decision 4).
      const [afterItem] = await getDb().select({ titleEnc: items.titleEnc, providerEnc: items.providerEnc, costMinorEnc: items.costMinorEnc })
        .from(items).where(eq(items.id, itemId));
      expect(afterItem).toEqual(beforeItem);
      const [afterInvitation] = await getDb().select({ emailEnc: householdInvitations.emailEnc, emailIndex: householdInvitations.emailIndex })
        .from(householdInvitations).where(eq(householdInvitations.householdId, fixture.household.id));
      expect(afterInvitation).toEqual(beforeInvitation);

      // The key row itself did move, and to the new key id.
      const [afterKey] = await getDb().select().from(metadataKeys).where(eq(metadataKeys.householdId, fixture.household.id));
      expect(afterKey.keyId).toBe(keys.nextKeyId);
      expect(afterKey.wrappedDek).not.toBe(beforeKey.wrappedDek);
    } finally {
      if (originalKek === undefined) delete process.env.DOCUMENT_KEK;
      else process.env.DOCUMENT_KEK = originalKek;
      delete process.env.DOCUMENT_KEK_NEXT;
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();
    }
  }, 120_000);
});
