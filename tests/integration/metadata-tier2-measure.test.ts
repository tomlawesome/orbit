/**
 * Measures the in-app path Tier 2 traded the database query for (#963), so
 * "household-scale data makes fetch-decrypt-compute viable" is a number rather
 * than an assumption. The owner's decision of 2026-08-13 rests on that
 * premise; this is what checks it.
 *
 *     ORBIT_MEASURE_TIER2=1 node scripts/test-integration.mjs
 *
 * Gated, like `document-kek-rotation-measure.test.ts`, because it seeds
 * hundreds of rows per run: a measurement to re-take when the read path
 * changes, not a check for every pipeline.
 *
 * Two scales are reported. 100 items is a realistic household. 500 is the
 * ceiling `workspaceItemSchema` already imposes on one household's item list,
 * so it is the worst case the product can reach, not an extrapolation.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { items } from "@/db/schema";
import { readWorkspace } from "@/server/workspace-repository";
import { openMetadataReader, requireMetadataWriter } from "@/server/metadata/fields";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const PROVIDERS = ["Admiral", "Warm & Co.", "HyperNet", "ProtectPlus", "Northern Water"];

/** Seeds encrypted items directly, so the measurement times reads, not writes. */
async function seedItems(householdId: string, sectionId: string, count: number): Promise<string[]> {
  const cipher = await requireMetadataWriter(householdId);
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    rows.push({
      id,
      householdId,
      sectionId,
      title: null,
      titleEnc: cipher.encryptText("items.title", id, `Measured item ${index} renewal`),
      provider: null,
      providerEnc: cipher.encryptText("items.provider", id, PROVIDERS[index % PROVIDERS.length]),
      reference: null,
      referenceEnc: cipher.encryptText("items.reference", id, `MEAS-${index}`),
      referenceIndex: cipher.referenceIndex(`MEAS-${index}`),
      notes: null,
      notesEnc: cipher.encryptText("items.notes", id, `A note of some length about item ${index}, as a real one would be.`),
      costMinor: null,
      costMinorEnc: cipher.encryptNumber("items.cost_minor", id, 1_000 + index),
      currency: "GBP",
      renewalDate: "2027-01-01",
    });
  }
  for (let offset = 0; offset < rows.length; offset += 100) {
    await getDb().insert(items).values(rows.slice(offset, offset + 100));
  }
  return rows.map((row) => row.id);
}

describe.runIf(process.env.ORBIT_MEASURE_TIER2 === "1")("the in-app Tier 2 path, measured (#963)", () => {
  it("reads, decrypts, searches and totals a household at 100 and 500 items", async () => {
    const fixture = await createIntegrationFixture("tier2-measure");
    const [section] = await getDb().select({ id: items.sectionId }).from(items).where(eq(items.id, fixture.item.id));
    const session = await fixture.session("member");

    const seeded: string[] = [];
    for (const scale of [100, 500]) {
      seeded.push(...await seedItems(fixture.household.id, section.id, scale - seeded.length));

      // Warm once, so the figure is the steady-state read rather than the
      // first-touch cost of connections and the DEK unwrap.
      await readWorkspace(fixture.users.member.id, session.sessionId);

      const runs = 10;
      const startedAt = process.hrtime.bigint();
      let total = 0;
      let matches = 0;
      for (let run = 0; run < runs; run += 1) {
        const workspace = await readWorkspace(fixture.users.member.id, session.sessionId);
        const household = workspace.households.find((candidate) => candidate.id === fixture.household.id)!;
        // The two jobs the decision moved into the application, done on every
        // run so the figure covers them, not just the decryption.
        total = household.items.reduce((sum, item) => sum + (item.costMinor ?? 0), 0);
        matches = household.items.filter((item) => item.title.toLowerCase().includes("renewal")).length;
      }
      const millis = Number(process.hrtime.bigint() - startedAt) / 1e6 / runs;

      expect(total).toBeGreaterThan(0);
      expect(matches).toBeGreaterThanOrEqual(scale - 1);

      // The figure above is the whole request, most of which the database and
      // the rest of `readWorkspace` were already spending. This second one
      // isolates what encryption actually added: the decrypt-and-scan itself,
      // over the same rows, with the query taken out.
      const rows = await getDb().select({ id: items.id, titleEnc: items.titleEnc, providerEnc: items.providerEnc, costMinorEnc: items.costMinorEnc })
        .from(items).where(eq(items.householdId, fixture.household.id));
      const reader = await openMetadataReader(fixture.household.id);
      const scanStartedAt = process.hrtime.bigint();
      for (let run = 0; run < runs; run += 1) {
        const decrypted = rows.map((row) => ({
          title: reader.text("items.title", row.id, { encrypted: row.titleEnc, plaintext: null }).value ?? "",
          provider: reader.text("items.provider", row.id, { encrypted: row.providerEnc, plaintext: null }).value,
          costMinor: reader.number("items.cost_minor", row.id, { encrypted: row.costMinorEnc, plaintext: null }).value,
        }));
        total = decrypted.reduce((sum, item) => sum + (item.costMinor ?? 0), 0);
        matches = decrypted.filter((item) => item.title.toLowerCase().includes("renewal")).length;
      }
      const scanMillis = Number(process.hrtime.bigint() - scanStartedAt) / 1e6 / runs;
      expect(total).toBeGreaterThan(0);

      // The tool's own output — the numbers the issue and the docs cite.
      console.log(`[tier2-measure] ${scale} items: ${millis.toFixed(1)} ms per full read+decrypt+total+search; decrypt-and-scan alone ${scanMillis.toFixed(2)} ms`);
    }

    for (let offset = 0; offset < seeded.length; offset += 100) {
      await getDb().delete(items).where(inArray(items.id, seeded.slice(offset, offset + 100)));
    }
  }, 600_000);
});
