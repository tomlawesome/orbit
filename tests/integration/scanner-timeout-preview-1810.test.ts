/**
 * #1810 W-F2 (note 57316): a scan that times out is load, not an outage, so the
 * create form's preview answers it with its own code and nobody is alerted;
 * the lane stops claiming administrators were told. An unreachable scanner
 * keeps `document_scanner_unreachable`. The preview route calls
 * `raiseAdminAlert` in neither case (only the upload path and the health
 * check do).
 *
 * Real PostgreSQL for the household access check; the scanner and the alert
 * are stood in.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { cleanupIntegrationEnvironment, createIntegrationFixture, withRequiredScanMode } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { syntheticPdf as createSyntheticPdf } from "../support/synthetic-documents";

const mocks = vi.hoisted(() => ({ raiseAdminAlert: vi.fn() }));

vi.mock("@/server/admin-alert", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/admin-alert")>()),
  raiseAdminAlert: mocks.raiseAdminAlert,
}));
vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
  pingClamAv: vi.fn(),
}));

const { POST: preview } = await loadRoute("households/[householdId]/item-document-preview");
const pdf = createSyntheticPdf("synthetic preview document");

async function previewWith(reason: "timeout" | "unavailable") {
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason });
  const fixture = await createIntegrationFixture(`scanner-timeout-preview-${reason}`);
  const session = await fixture.session("member");
  return withRequiredScanMode(() => callRouteForSession(preview, session, {
    url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/item-document-preview`,
    method: "POST",
    headers: {
      "content-length": String(pdf.length),
      "content-type": "application/pdf",
      "x-orbit-filename": encodeURIComponent("policy.pdf"),
    },
    body: pdf,
    params: { householdId: fixture.household.id },
  }));
}

afterEach(() => {
  mocks.raiseAdminAlert.mockReset();
  vi.mocked(scanFileWithClamAv).mockReset();
});
afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

describe("the create preview and a scanner that is slow or away (#1810 W-F2)", () => {
  it("a timeout answers 503 document_scanner_timeout and raises no administrator alert", async () => {
    const response = await previewWith("timeout");
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("document_scanner_timeout");
    expect(mocks.raiseAdminAlert).not.toHaveBeenCalled();
  });

  it("an unavailable scanner keeps document_scanner_unreachable, and the preview route raises no alert", async () => {
    const response = await previewWith("unavailable");
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("document_scanner_unreachable");
    expect(mocks.raiseAdminAlert).not.toHaveBeenCalled();
  });
});
