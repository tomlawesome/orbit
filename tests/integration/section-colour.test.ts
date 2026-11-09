import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { sections } from "@/db/schema";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/* #1466 (colour part): a section's own colour. `sections.colour` is nullable
   text, one of home | vehicles | devices | services (option-colour.js
   SECTION_COLOURS); null means "follows the mark" and is what every existing
   row holds. `sections.replace` carries it per section: one of the four or
   null sets it, anything else is a 422 validation_failed, and a section that
   does not mention it keeps what it had. Every read of the workspace carries
   it. Written from the specification before the code; the column is read with
   raw SQL so the file does not depend on the schema's property name. */

const { POST: applyWorkspaceCommand } = await loadRoute("workspace/commands");
const COMMAND_URL = "http://127.0.0.1:3000/api/workspace/commands";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;

function send(session: Session, body: Record<string, unknown>) {
  return callRouteForSession(applyWorkspaceCommand, session, {
    url: COMMAND_URL,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The fixture household's one section, as the command carries it, plus any extra field. */
const replaceWith = (fixture: Fixture, extra: Record<string, unknown>) => ({
  type: "sections.replace",
  householdId: fixture.household.id,
  sections: [{ id: fixture.section.id, name: "Documents", icon: "home", accent: "sage", visible: true, ...extra }],
});

async function storedColour(fixture: Fixture): Promise<string | null> {
  const rows = await getDb().execute(sql`select colour from sections where id = ${fixture.section.id}`);
  return (rows as unknown as Array<{ colour: string | null }>)[0].colour;
}

async function colourInReply(response: Response, fixture: Fixture) {
  const body = await response.json() as { workspace: { households: Array<{ id: string; sections: Array<{ id: string; colour?: string | null }> }> } };
  const household = body.workspace.households.find((one) => one.id === fixture.household.id);
  return household?.sections.find((one) => one.id === fixture.section.id)?.colour;
}

describe("the section update takes a colour", () => {
  it("reads back null for a row that existed before the column", async () => {
    const fixture = await createIntegrationFixture("section-colour-existing");
    expect(await storedColour(fixture)).toBeNull();
  });

  it.each(["home", "vehicles", "devices", "services"])("accepts %s, stores it and returns it", async (colour) => {
    const fixture = await createIntegrationFixture(`section-colour-${colour}`);
    const owner = await fixture.session("owner");
    const response = await send(owner, replaceWith(fixture, { colour }));
    expect(response.status).toBe(200);
    expect(await colourInReply(response, fixture)).toBe(colour);
    expect(await storedColour(fixture)).toBe(colour);
  });

  it("accepts null, which clears a stored colour", async () => {
    const fixture = await createIntegrationFixture("section-colour-null");
    const owner = await fixture.session("owner");
    expect((await send(owner, replaceWith(fixture, { colour: "devices" }))).status).toBe(200);
    const cleared = await send(owner, replaceWith(fixture, { colour: null }));
    expect(cleared.status).toBe(200);
    expect(await colourInReply(cleared, fixture)).toBeNull();
    expect(await storedColour(fixture)).toBeNull();
  });

  it.each([["'sage'", "sage"], ["the empty string", ""], ["the number 1", 1]])("refuses %s with a 422 validation_failed and stores nothing", async (_label, colour) => {
    const fixture = await createIntegrationFixture("section-colour-bad");
    const owner = await fixture.session("owner");
    const response = await send(owner, replaceWith(fixture, { colour }));
    expect(response.status).toBe(422);
    const { error } = await response.json() as { error: { code: string } };
    expect(error.code).toBe("validation_failed");
    expect(await storedColour(fixture)).toBeNull();
  });

  it("leaves the colour as it was when the update does not mention it", async () => {
    const fixture = await createIntegrationFixture("section-colour-unmentioned");
    const owner = await fixture.session("owner");
    expect((await send(owner, replaceWith(fixture, { colour: "services" }))).status).toBe(200);
    const renamed = await send(owner, replaceWith(fixture, { name: "Papers" }));
    expect(renamed.status).toBe(200);
    expect(await colourInReply(renamed, fixture)).toBe("services");
    expect(await storedColour(fixture)).toBe("services");
    const [row] = await getDb().select({ name: sections.name }).from(sections).where(eq(sections.id, fixture.section.id));
    expect(row.name).toBe("Papers");
  });

  it("is refused to a member who cannot edit sections, and stores nothing", async () => {
    const fixture = await createIntegrationFixture("section-colour-member");
    const member = await fixture.session("member");
    const response = await send(member, replaceWith(fixture, { colour: "vehicles" }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await storedColour(fixture)).toBeNull();
  });

  it("answers a dry run with a 200 verdict, as the route does for every dry run, and writes nothing", async () => {
    const fixture = await createIntegrationFixture("section-colour-dry");
    const owner = await fixture.session("owner");
    const dry = await send(owner, { ...replaceWith(fixture, { colour: "vehicles" }), dryRun: true });
    expect(dry.status).toBe(200);
    expect(await storedColour(fixture)).toBeNull();
    // The route's contract (commands/+server.js `verdict`): a dry run is always a 200, a refusal in its body.
    const bad = await send(owner, { ...replaceWith(fixture, { colour: "sage" }), dryRun: true });
    expect(bad.status).toBe(200);
    const { refusal } = await bad.json() as { refusal: { code: string } };
    expect(refusal.code).toBe("validation_failed");
    expect(await storedColour(fixture)).toBeNull();
  });
});

describe("a household made or set up with a section colour keeps it (#1466 review)", () => {
  const colours = async (householdId: string) => {
    const rows = await getDb().execute(sql`select name, colour from sections where household_id = ${householdId} order by position`);
    return (rows as unknown as Array<{ name: string; colour: string | null }>).map((row) => [row.name, row.colour]);
  };
  const wire = (name: string, extra: Record<string, unknown> = {}) => ({ id: randomUUID(), name, icon: "home", accent: "sage", visible: true, ...extra });

  it("household.create stores each section's colour, null when it brings none, and returns them", async () => {
    const fixture = await createIntegrationFixture("section-colour-create");
    const owner = await fixture.session("owner");
    const id = randomUUID();
    const response = await send(owner, {
      type: "household.create",
      household: { id, name: "Coloured", timezone: "Europe/London", currency: "GBP", onboardingComplete: true, sections: [wire("Garden", { colour: "services" }), wire("Shed")] },
    });
    expect(response.status).toBe(200);
    expect(await colours(id)).toEqual([["Garden", "services"], ["Shed", null]]);
    const body = await response.json() as { workspace: { households: Array<{ id: string; sections: Array<{ name: string; colour?: string | null }> }> } };
    expect(body.workspace.households.find((one) => one.id === id)?.sections.map((one) => [one.name, one.colour])).toEqual([["Garden", "services"], ["Shed", null]]);
  });

  it("household.setup stores the colour of a section it updates and of one it adds", async () => {
    const fixture = await createIntegrationFixture("section-colour-setup");
    const owner = await fixture.session("owner");
    const response = await send(owner, {
      type: "household.setup", householdId: fixture.household.id, name: "Set up", timezone: "Europe/London", currency: "GBP",
      sections: [{ id: fixture.section.id, name: "Documents", icon: "home", accent: "sage", visible: true, colour: "devices" }, wire("Extra", { colour: "vehicles" })],
    });
    expect(response.status).toBe(200);
    expect(await colours(fixture.household.id)).toEqual([["Documents", "devices"], ["Extra", "vehicles"]]);
  });
});
