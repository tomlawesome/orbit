import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { households, items, sections } from "@/db/schema";
import { hardDeleteHousehold, requestHouseholdDeletion } from "@/server/household-lifecycle";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/* #1332 (from #1328 WI-2), decided by the owner on 2026-10-09: two household
   rules the browser knew and the engine missed.

   1. The typed deletion confirmation is normalised (trim, collapse inner
      spaces) before it is compared, so "Lawson  Home " matches "Lawson Home";
      a genuinely different name is still refused.
   2. `sections.replace` refuses to drop a section that still holds items
      unless the command names a destination section for them, and moves the
      items there when it does. The refusal is reachable through the dry run
      like every other refusal.

   Written from the issue alone, before the code. The two names below are the
   builder's to confirm or rename: the issue does not fix them. */

/** The command field naming where a dropped section's items go. One place. */
const DESTINATION_FIELD = "moveItemsTo";
/** The refusal code for dropping a section that still holds items with no destination. */
const SECTION_HAS_ITEMS = "section_has_items";

const { POST: applyWorkspaceCommand } = await loadRoute("workspace/commands");
const { POST: lifecycle } = await loadRoute("households/[householdId]/lifecycle");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;

describe("the deletion confirmation is normalised before it is compared", () => {
  /** "Integration a-b" -> " Integration   a-b " (leading, inner and trailing spaces). */
  const untidy = (name: string) => ` ${name.replace(/ /g, "   ")}  `;

  async function deletionRequestedAt(id: string) {
    const [row] = await getDb().select({ at: households.deletionRequestedAt }).from(households).where(eq(households.id, id));
    return row?.at ?? null;
  }

  it("schedules deletion when the typed name has stray spaces round it", async () => {
    const fixture = await createIntegrationFixture("confirm-trim");
    await requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, ` ${fixture.household.name} `);
    expect(await deletionRequestedAt(fixture.household.id)).toBeInstanceOf(Date);
  });

  it("schedules deletion when spaces inside the typed name are doubled", async () => {
    const fixture = await createIntegrationFixture("confirm-collapse");
    expect(untidy(fixture.household.name)).not.toBe(fixture.household.name);
    await requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, untidy(fixture.household.name));
    expect(await deletionRequestedAt(fixture.household.id)).toBeInstanceOf(Date);
  });

  it("accepts the untidy name through the lifecycle route too", async () => {
    const fixture = await createIntegrationFixture("confirm-route");
    const owner = await fixture.session("owner");
    const response = await callRouteForSession(lifecycle, owner, {
      url: "http://127.0.0.1:3000/api/households/lifecycle",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete", confirmation: untidy(fixture.household.name) }),
      params: { householdId: fixture.household.id },
    });
    expect(response.status).toBeLessThan(300);
    expect(await deletionRequestedAt(fixture.household.id)).toBeInstanceOf(Date);
  });

  it("still refuses a genuinely different name, and writes nothing", async () => {
    const fixture = await createIntegrationFixture("confirm-different");
    const before = await fixture.auditCount(fixture.household.id);
    for (const typed of [
      `${fixture.household.name} too`,
      fixture.household.name.replace(/ /g, ""),
      "Somebody Else's Home",
      "   ",
      "",
    ]) {
      await expect(requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, typed))
        .rejects.toMatchObject({ code: "household_confirmation_failed" });
    }
    expect(await deletionRequestedAt(fixture.household.id)).toBeNull();
    expect(await fixture.auditCount(fixture.household.id)).toBe(before);
  });

  it("applies the same normalisation to the permanent-delete confirmation", async () => {
    const fixture = await createIntegrationFixture("confirm-hard");
    await requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, fixture.household.name);

    await expect(hardDeleteHousehold(fixture.users.admin.id, fixture.household.id, `${fixture.household.name} too`))
      .rejects.toMatchObject({ code: "household_hard_delete_confirmation_failed" });
    expect(await getDb().select({ id: households.id }).from(households).where(eq(households.id, fixture.household.id))).toHaveLength(1);

    await hardDeleteHousehold(fixture.users.admin.id, fixture.household.id, untidy(fixture.household.name));
    expect(await getDb().select({ id: households.id }).from(households).where(eq(households.id, fixture.household.id))).toHaveLength(0);
  });
});

describe("removing a section that still has items asks where they go", () => {
  const commandUrl = "http://127.0.0.1:3000/api/workspace/commands";

  function send(session: Session, body: Record<string, unknown>) {
    return callRouteForSession(applyWorkspaceCommand, session, {
      url: commandUrl,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** A section as the command carries it. */
  const wire = (id: string, name: string) => ({ id, name, icon: "home", accent: "sage", visible: true });

  /** The fixture household has one section ("Documents", holding one item); add more. */
  async function addSection(fixture: Fixture, name: string, position: number) {
    const [row] = await getDb().insert(sections).values({
      householdId: fixture.household.id,
      slug: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
      name,
      position,
    }).returning({ id: sections.id });
    return row.id;
  }

  async function addItem(fixture: Fixture, sectionId: string, title: string) {
    const [row] = await getDb().insert(items).values({
      householdId: fixture.household.id, sectionId, title, currency: "GBP",
    }).returning({ id: items.id });
    return row.id;
  }

  async function sectionOf(itemId: string) {
    const [row] = await getDb().select({ sectionId: items.sectionId }).from(items).where(eq(items.id, itemId));
    return row?.sectionId;
  }

  /** The command: the whole list that is to remain, and optionally where items go. */
  function replace(fixture: Fixture, remaining: Array<{ id: string; name: string }>, destination?: string, extra: Record<string, unknown> = {}) {
    return {
      type: "sections.replace",
      householdId: fixture.household.id,
      sections: remaining.map((one) => wire(one.id, one.name)),
      ...(destination === undefined ? {} : { [DESTINATION_FIELD]: destination }),
      ...extra,
    };
  }

  async function sectionIdsInReply(response: Response, fixture: Fixture) {
    const body = await response.json() as { workspace: { households: Array<{ id: string; sections: Array<{ id: string }> }> } };
    return body.workspace.households.find((one) => one.id === fixture.household.id)?.sections.map((one) => one.id);
  }

  /** Documents (with one item), Spare (empty), Garage (empty); the owner's session. */
  async function setup(label: string) {
    const fixture = await createIntegrationFixture(label);
    const owner = await fixture.session("owner");
    const spare = await addSection(fixture, "Spare", 1);
    const garage = await addSection(fixture, "Garage", 2);
    return {
      fixture, owner,
      documents: { id: fixture.section.id, name: "Documents" },
      spare: { id: spare, name: "Spare" },
      garage: { id: garage, name: "Garage" },
    };
  }

  it("refuses dropping a section that holds items when no destination is named", async () => {
    const { fixture, owner, spare, garage } = await setup("sections-refuse");
    const audits = await fixture.auditCount(fixture.household.id);

    const response = await send(owner, replace(fixture, [spare, garage]));
    expect(response.status).toBe(422);
    const { error } = await response.json() as { error: { code: string; message: string } };
    expect(error.code).toBe(SECTION_HAS_ITEMS);
    expect(error.message).toEqual(expect.any(String));
    expect(error.message.length).toBeGreaterThan(0);

    // Nothing moved, nothing removed.
    expect(await sectionOf(fixture.item.id)).toBe(fixture.section.id);
    const still = await getDb().select({ id: sections.id }).from(sections)
      .where(and(eq(sections.householdId, fixture.household.id)));
    expect(still.map((row) => row.id)).toContain(fixture.section.id);
    expect(await fixture.auditCount(fixture.household.id)).toBe(audits);
  });

  it("gives the same refusal through the dry run, as a 200 verdict, and writes nothing", async () => {
    const { fixture, owner, spare, garage } = await setup("sections-dry-refuse");

    const dry = await send(owner, replace(fixture, [spare, garage], undefined, { dryRun: true }));
    expect(dry.status).toBe(200);
    const { refusal } = await dry.json() as { refusal: { code: string; message: string } };
    expect(refusal.code).toBe(SECTION_HAS_ITEMS);

    const real = await send(owner, replace(fixture, [spare, garage]));
    expect((await real.json() as { error: { code: string; message: string } }).error).toEqual(refusal);

    expect(await sectionOf(fixture.item.id)).toBe(fixture.section.id);
  });

  it("moves the items to the named destination, which need not be the first section", async () => {
    const { fixture, owner, spare, garage } = await setup("sections-move");
    const second = await addItem(fixture, fixture.section.id, "Second document");

    const response = await send(owner, replace(fixture, [spare, garage], garage.id));
    expect(response.status).toBe(200);
    expect(await sectionOf(fixture.item.id)).toBe(garage.id);
    expect(await sectionOf(second)).toBe(garage.id);
    expect(await sectionIdsInReply(response, fixture)).toEqual([spare.id, garage.id]);
  });

  it("moves the items of every dropped section to the one destination, and leaves kept sections alone", async () => {
    const { fixture, owner, documents, spare, garage } = await setup("sections-move-many");
    const inSpare = await addItem(fixture, spare.id, "In spare");
    const inGarage = await addItem(fixture, garage.id, "In garage");

    const response = await send(owner, replace(fixture, [documents, garage], garage.id));
    expect(response.status).toBe(200);
    expect(await sectionOf(inSpare)).toBe(garage.id);
    expect(await sectionOf(inGarage)).toBe(garage.id);
    expect(await sectionOf(fixture.item.id)).toBe(fixture.section.id);
    expect(await sectionIdsInReply(response, fixture)).toEqual([documents.id, garage.id]);
  });

  it("answers a dry run with a destination as an empty success, and writes nothing", async () => {
    const { fixture, owner, spare, garage } = await setup("sections-dry-move");
    const dry = await send(owner, replace(fixture, [spare, garage], garage.id, { dryRun: true }));
    expect(dry.status).toBe(200);
    expect(await dry.json()).toEqual({});
    expect(await sectionOf(fixture.item.id)).toBe(fixture.section.id);
  });

  it("needs no destination to drop a section that is empty", async () => {
    const { fixture, owner, documents, garage } = await setup("sections-drop-empty");
    const response = await send(owner, replace(fixture, [documents, garage]));
    expect(response.status).toBe(200);
    expect(await sectionIdsInReply(response, fixture)).toEqual([documents.id, garage.id]);
    expect(await sectionOf(fixture.item.id)).toBe(fixture.section.id);
  });

  it("refuses a destination that is not a section the household keeps, and moves nothing", async () => {
    const { fixture, owner, documents, spare, garage } = await setup("sections-bad-destination");

    // A section of another household.
    const foreign = await send(owner, replace(fixture, [spare, garage], (await createIntegrationFixture("sections-foreign")).section.id));
    expect(foreign.status).toBe(422);
    expect((await foreign.json() as { error: { code: string } }).error.code).toBe("section_not_found");

    // The section being dropped is no destination for its own items.
    const dropped = await send(owner, replace(fixture, [spare, garage], documents.id));
    expect(dropped.status).toBe(422);

    expect(await sectionOf(fixture.item.id)).toBe(fixture.section.id);
  });
});
