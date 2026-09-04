import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { households } from "@/db/schema";
import { createIntegrationFixture, cleanupIntegrationEnvironment } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

const { GET: listDocuments } = await loadRoute("households/[householdId]/items/[itemId]/documents");
const { POST: applyWorkspaceCommand } = await loadRoute("workspace/commands");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

describe("PostgreSQL service and API integration harness", () => {
  it("proves migrated schema, persisted fixtures and a real session cookie", async () => {
    const fixture = await createIntegrationFixture("migration-session");
    const session = await fixture.session("member");

    expect(fixture.household.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(session.headers.cookie).toContain("orbit-session=");
    expect(session.headers["x-csrf-token"]).toBeTruthy();

    const [persistedHousehold] = await getDb()
      .select({ name: households.name })
      .from(households)
      .where(eq(households.id, fixture.household.id));
    expect(persistedHousehold?.name).toBe(fixture.household.name);
  });

  it("exercises a workspace mutation and rejects CSRF before mutation", async () => {
    const fixture = await createIntegrationFixture("workspace-command");
    const session = await fixture.session("owner");
    const command = {
      type: "household.update",
      householdId: fixture.household.id,
      name: "Updated Integration Household",
      timezone: "Europe/London",
      currency: "GBP",
    } as const;

    const validResponse = await callRouteForSession(applyWorkspaceCommand, session, {
      url: "http://127.0.0.1:3000/api/workspace/commands",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    expect(validResponse.status).toBe(200);
    expect(validResponse.headers.get("cache-control")).toBe("no-store");
    expect((await validResponse.json()).workspace.households[0].name).toBe(command.name);

    const invalidResponse = await callRouteForSession(applyWorkspaceCommand, session, {
      url: "http://127.0.0.1:3000/api/workspace/commands",
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "wrong-token" },
      body: JSON.stringify({ ...command, name: "Must Not Persist" }),
    });
    expect(invalidResponse.status).toBe(403);

    const [persistedHousehold] = await getDb()
      .select({ name: households.name })
      .from(households)
      .where(eq(households.id, fixture.household.id));
    expect(persistedHousehold?.name).toBe(command.name);
  });

  it("exercises household document visibility without disclosing it cross-household", async () => {
    const fixture = await createIntegrationFixture("document-visibility");
    const member = await fixture.session("member");
    const outsider = await fixture.session("outsider");
    const routeUrl = `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${fixture.item.id}/documents`;
    const params = { householdId: fixture.household.id, itemId: fixture.item.id };

    const memberResponse = await callRouteForSession(listDocuments, member, { url: routeUrl, params });
    expect(memberResponse.status).toBe(200);
    expect(memberResponse.headers.get("cache-control")).toBe("no-store");
    expect((await memberResponse.json()).documents).toEqual([
      expect.objectContaining({ id: fixture.document.id, displayName: fixture.document.displayName }),
    ]);

    const outsiderResponse = await callRouteForSession(listDocuments, outsider, { url: routeUrl, params });
    expect(outsiderResponse.status).toBe(404);
    expect((await outsiderResponse.json()).error).toEqual({
      code: "item_not_found",
      message: "That item is not available",
    });
  });
});
