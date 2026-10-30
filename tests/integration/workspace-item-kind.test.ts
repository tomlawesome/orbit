import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { items } from "@/db/schema";
import { kindOfItem } from "@/lib/item-kind";
import type { WorkspaceState } from "@/lib/workspace";
import { readWorkspace } from "@/server/workspace-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture, encryptedItemColumns } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/**
 * #1346 (from #1328, WI-16): the engine sends each item's kind, so the browser
 * stops inferring it. Every item in the workspace payload carries `kind`, and
 * it is the answer `src/lib/item-kind.ts` gives for that item, whatever
 * subtype text a household stored (a free-text "MOT", a legacy row with no
 * subtype, a kind named in the subtype itself, a row that is no kind at all).
 */

const { GET: readWorkspaceRoute } = await loadRoute("workspace");
const workspaceUrl = "http://127.0.0.1:3000/api/workspace";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type PayloadItem = WorkspaceState["households"][number]["items"][number] & { kind?: string | null };

const day = "2026-12-01";

/** A stored row, by the columns that decide its kind: its subtype text and which date it keeps. */
const rows = [
  { label: "inspection by subtype", subtype: "inspection", serviceDate: day, expected: "inspection" },
  { label: "free-text subtype on a service", subtype: "MOT", serviceDate: day, expected: "service" },
  { label: "renewal with no subtype", subtype: null, renewalDate: day, expected: "renewal" },
  { label: "free-text subtype on a renewal", subtype: "Car insurance", renewalDate: day, expected: "renewal" },
  { label: "expiry reads as a document", subtype: "Passport", expiryDate: day, expected: "document" },
  { label: "document by subtype, no date", subtype: "document", expected: "document" },
  { label: "suggestion by subtype, no date", subtype: "suggestion", expected: "suggestion" },
  { label: "service by subtype, no date", subtype: "service", expected: "service" },
  { label: "no subtype, no date: no kind", subtype: null, expected: null },
  { label: "free-text subtype, no date: no kind", subtype: "Odd job", expected: null },
  { label: "a cancelled item still has its kind", subtype: "renewal", renewalDate: day, status: "cancelled" as const, expected: "renewal" },
] as const;

type Row = (typeof rows)[number];

async function seed(fixture: Fixture): Promise<Map<string, Row>> {
  const db = getDb();
  const seeded = new Map<string, Row>();
  for (const row of rows) {
    const id = randomUUID();
    await db.insert(items).values({
      id,
      householdId: fixture.household.id,
      sectionId: fixture.section.id,
      subtype: row.subtype,
      ...await encryptedItemColumns(fixture.household.id, id, { title: row.label }),
      currency: "GBP",
      serviceDate: "serviceDate" in row ? row.serviceDate : null,
      renewalDate: "renewalDate" in row ? row.renewalDate : null,
      expiryDate: "expiryDate" in row ? row.expiryDate : null,
      status: "status" in row ? row.status : "active",
    });
    seeded.set(id, row);
  }
  return seeded;
}

function check(payloadItems: PayloadItem[], seeded: Map<string, Row>) {
  for (const [id, row] of seeded) {
    const item = payloadItems.find((entry) => entry.id === id);
    expect(item, row.label).toBeDefined();
    // The payload's kind is the engine's own answer for the item as sent...
    expect(item!.kind ?? null, `${row.label}: kind equals the engine's answer`).toBe(kindOfItem(item!));
    // ...and that answer is the one the household's data means.
    expect(item!.kind ?? null, row.label).toBe(row.expected);
    // A kind is always sent when the engine has one.
    if (row.expected !== null) expect(item, row.label).toHaveProperty("kind", row.expected);
  }
  // Every other item in the payload too (the fixture's own bare item).
  for (const item of payloadItems) expect(item.kind ?? null).toBe(kindOfItem(item));
}

describe("workspace payload items carry their kind (#1346)", () => {
  it("readWorkspace gives every item the kind the engine reads it as", async () => {
    const fixture = await createIntegrationFixture("item-kind-read");
    const seeded = await seed(fixture);
    const session = await fixture.session("member");
    const workspace = await readWorkspace(fixture.users.member.id, session.sessionId);
    const household = workspace.households.find((entry) => entry.id === fixture.household.id);
    expect(household).toBeDefined();
    check(household!.items as PayloadItem[], seeded);
    await fixture.cleanup();
  });

  it("GET /api/workspace sends the kind over the wire", async () => {
    const fixture = await createIntegrationFixture("item-kind-wire");
    const seeded = await seed(fixture);
    const owner = await fixture.session("owner");
    const response = await callRouteForSession(readWorkspaceRoute, owner, { url: workspaceUrl });
    expect(response.status).toBe(200);
    const body = await response.json() as { workspace: WorkspaceState };
    const household = body.workspace.households.find((entry) => entry.id === fixture.household.id);
    expect(household).toBeDefined();
    check(household!.items as PayloadItem[], seeded);
    await fixture.cleanup();
  });
});
