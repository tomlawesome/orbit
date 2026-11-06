import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/* #1468 test-bed defect: the Add form asks the engine (a dry run) as soon as a
   name is typed and a section picked, before an importance is chosen. The engine
   throws a ZodError for a new item with no importance (#1463), and the dry run's
   verdict turns any ZodError into the generic "The submitted data is invalid".
   The member must be told what is missing, in the engine's words, or not
   be refused before submit: the answer is never that generic line. */

const { POST: applyWorkspaceCommand } = await loadRoute("workspace/commands");
const commandUrl = "http://127.0.0.1:3000/api/workspace/commands";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

describe("a dry run of a new item that has a name and a section but no importance", () => {
  it("is not refused with the generic 'submitted data is invalid'", async () => {
    const fixture = await createIntegrationFixture("dry-run-no-importance");
    const owner = await fixture.session("owner");
    const id = randomUUID();
    const response = await callRouteForSession(applyWorkspaceCommand, owner, {
      url: commandUrl, method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "item.upsert", householdId: fixture.household.id, dryRun: true,
        item: { id, sectionId: fixture.section.id, title: "Boiler service", currency: "GBP", recurrenceMonths: 0, reminderDays: [14, 3] },
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { refusal?: { code: string, message: string } };
    expect(JSON.stringify(body)).not.toMatch(/submitted data is invalid/i);
    expect(body.refusal?.code ?? "").not.toBe("validation_failed");
    await fixture.cleanup();
  });
});
