import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { households } from "@/db/schema";
import { GET as listDocuments } from "@/app/api/households/[householdId]/items/[itemId]/documents/route";
import { POST as applyWorkspaceCommand } from "@/app/api/workspace/commands/route";
import { createIntegrationFixture, cleanupIntegrationEnvironment, sessionHeaders } from "./support/fixtures";

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

    const validResponse = await applyWorkspaceCommand(new NextRequest("http://127.0.0.1:3000/api/workspace/commands", {
      method: "POST",
      headers: { ...session.headers, "content-type": "application/json" },
      body: JSON.stringify(command),
    }));
    expect(validResponse.status).toBe(200);
    expect(validResponse.headers.get("cache-control")).toBe("no-store");
    expect((await validResponse.json()).workspace.households[0].name).toBe(command.name);

    const invalidHeaders = { ...session.headers, "x-csrf-token": "wrong-token" };
    const invalidResponse = await applyWorkspaceCommand(new NextRequest("http://127.0.0.1:3000/api/workspace/commands", {
      method: "POST",
      headers: { ...invalidHeaders, "content-type": "application/json" },
      body: JSON.stringify({ ...command, name: "Must Not Persist" }),
    }));
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
    const context = { params: Promise.resolve({ householdId: fixture.household.id, itemId: fixture.item.id }) };

    const memberResponse = await listDocuments(new NextRequest(routeUrl, { headers: sessionHeaders(member) }), context);
    expect(memberResponse.status).toBe(200);
    expect(memberResponse.headers.get("cache-control")).toBe("no-store");
    expect((await memberResponse.json()).documents).toEqual([
      expect.objectContaining({ id: fixture.document.id, displayName: fixture.document.displayName }),
    ]);

    const outsiderResponse = await listDocuments(new NextRequest(routeUrl, { headers: sessionHeaders(outsider) }), context);
    expect(outsiderResponse.status).toBe(404);
    expect((await outsiderResponse.json()).error).toEqual({
      code: "item_not_found",
      message: "That item is not available",
    });
  });
});
