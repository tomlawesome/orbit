import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { documentJobs } from "@/db/schema";
import { getDocumentHealth } from "@/server/document-health";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

/*
 * #1803 L-health: `previewsPending` counted every preview job that was not
 * `completed`, so a job an administrator discarded (`cancelled`) stayed in the
 * count for good. A `failed` job still counts: its pages are undrawn and an
 * administrator can retry it. Measured as a before/after difference so other
 * tests' jobs in the shared database do not matter.
 */

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const pending = async () => Number((await getDocumentHealth() as unknown as { previewsPending: number }).previewsPending);

describe("previewsPending (#1803 L-health)", () => {
  it("counts a failed and a pending preview job, and not a cancelled one", async () => {
    const fixture = await createIntegrationFixture("health-previews-pending");
    const before = await pending();
    await getDb().insert(documentJobs).values([
      { documentId: fixture.document.id, kind: "preview", generation: 9001, status: "cancelled" },
      { documentId: fixture.document.id, kind: "preview", generation: 9002, status: "failed" },
      { documentId: fixture.document.id, kind: "preview", generation: 9003, status: "pending" },
    ]);
    expect(await pending() - before).toBe(2);
  });
});
