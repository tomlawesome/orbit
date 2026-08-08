import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { POST as inspectRoute } from "@/app/api/households/[householdId]/item-document-inspection/route";
import { getDb } from "@/db";
import { auditLog, documents, items } from "@/db/schema";
import { requestForSession, createIntegrationFixture } from "./support/fixtures";
import { syntheticPdf as createSyntheticPdf } from "../support/synthetic-documents";

const syntheticPdf = createSyntheticPdf("Provider: Inert Cover\nPolicy number: SAFE-12345\n2030-12-20");

function context(householdId: string) {
  return { params: Promise.resolve({ householdId }) };
}

describe("document-assisted item inspection boundary", () => {
  it("authorizes inspection and creates no durable item, document, or audit before explicit submit", async () => {
    const fixture = await createIntegrationFixture("document-assisted-inspection");
    const member = await fixture.session("member");
    const beforeItems = await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, fixture.household.id));
    const beforeDocuments = await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, fixture.household.id));
    const beforeAudits = await getDb().select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.householdId, fixture.household.id), eq(auditLog.entityType, "item")));
    const url = `http://127.0.0.1:3000/api/households/${fixture.household.id}/item-document-inspection`;

    const response = await inspectRoute(requestForSession(member, url, {
      method: "POST",
      headers: {
        "x-orbit-filename": encodeURIComponent("safe-policy.pdf"),
        "x-orbit-declared-bytes": String(syntheticPdf.length),
        "content-type": "application/pdf",
      },
      body: syntheticPdf,
    }), context(fixture.household.id));

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      extracted: boolean;
      suggestions: Array<{ field: string; value: string; source: string; confidence: string }>;
      attachmentDisposition: "attachable" | "rejected";
      reason: "supported_structure" | "unsupported_structure" | "prohibited_content";
      proposal?: unknown;
      text?: unknown;
    };
    expect(payload).toMatchObject({ extracted: false, attachmentDisposition: "attachable", reason: "supported_structure" });
    expect(payload.suggestions).toContainEqual({ field: "title", value: "safe-policy", source: "filename", confidence: "high" });
    expect(payload).not.toHaveProperty("proposal");
    expect(payload).not.toHaveProperty("text");
    expect(await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, fixture.household.id))).toEqual(beforeItems);
    expect(await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, fixture.household.id))).toEqual(beforeDocuments);
    expect(await getDb().select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.householdId, fixture.household.id), eq(auditLog.entityType, "item")))).toEqual(beforeAudits);
  });

  it("returns a fixed rejected contract without durable writes for an unsupported structure", async () => {
    const fixture = await createIntegrationFixture("document-assisted-rejected-structure");
    const member = await fixture.session("member");
    const beforeItems = await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, fixture.household.id));
    const beforeDocuments = await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, fixture.household.id));
    const beforeAudits = await getDb().select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.householdId, fixture.household.id), eq(auditLog.entityType, "item")));
    const bytes = Buffer.from("%PDF-1.7\ntruncated");
    const url = `http://127.0.0.1:3000/api/households/${fixture.household.id}/item-document-inspection`;

    const response = await inspectRoute(requestForSession(member, url, {
      method: "POST",
      headers: {
        "x-orbit-filename": encodeURIComponent("unsupported.pdf"),
        "x-orbit-declared-bytes": String(bytes.length),
        "content-type": "application/pdf",
      },
      body: bytes,
    }), context(fixture.household.id));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      extracted: false,
      message: "Orbit could not safely inspect this document structure. Choose another PDF, JPEG, or PNG before adding the item.",
      suggestions: [],
      attachmentDisposition: "rejected",
      reason: "unsupported_structure",
    });
    expect(await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, fixture.household.id))).toEqual(beforeItems);
    expect(await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, fixture.household.id))).toEqual(beforeDocuments);
    expect(await getDb().select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.householdId, fixture.household.id), eq(auditLog.entityType, "item")))).toEqual(beforeAudits);
  });

  it("keeps the existing non-disclosing outsider response", async () => {
    const fixture = await createIntegrationFixture("document-assisted-outsider");
    const outsider = await fixture.session("outsider");
    const url = `http://127.0.0.1:3000/api/households/${fixture.household.id}/item-document-inspection`;
    const response = await inspectRoute(requestForSession(outsider, url, {
      method: "POST",
      headers: {
        "x-orbit-filename": encodeURIComponent("private-policy.pdf"),
        "x-orbit-declared-bytes": String(syntheticPdf.length),
      },
      body: syntheticPdf,
    }), context(fixture.household.id));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "household_not_found", message: "That household is not available" } });
  });
});
