import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/app-error";
import { syntheticPdf } from "../../tests/support/synthetic-documents";

/*
 * #1245: the create form's reading lane shows page one of the file the
 * moment it is picked, while the inspection (scan + extraction) runs
 * alongside — so the page cannot wait for an item to exist. This module
 * draws it from the same temporary upload shape `inspectItemDocument` uses:
 * received into quarantine, scanned, rendered through the one renderer
 * (#476), then zeroed and discarded. Nothing is retained.
 */
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  receive: vi.fn(),
  readQuarantine: vi.fn(),
  discardQuarantine: vi.fn(),
  scan: vi.fn(),
  render: vi.fn(),
  config: vi.fn(),
  effectiveLimit: null as number | null,
}));

vi.mock("@/server/workspace-access", () => ({ requireHouseholdAccess: mocks.access }));
vi.mock("@/server/documents/config", () => ({ getDocumentConfig: mocks.config }));
// The administrator's upload limit (#1285) is proven in
// src/server/upload-limit.test.ts; here it answers the configured default
// unless a test sets its own.
vi.mock("@/server/upload-limit", () => ({
  readEffectiveUploadLimit: async (config: { maxBytes: number }) => mocks.effectiveLimit ?? config.maxBytes,
}));
vi.mock("@/server/documents/scanner", () => ({ scanFileWithClamAv: mocks.scan }));
vi.mock("@/server/documents/preview", () => ({ renderDocumentPagePreview: mocks.render }));
vi.mock("@/server/documents/storage", () => ({
  LocalDocumentStorage: class {
    receive = mocks.receive;
    readQuarantine = mocks.readQuarantine;
    discardQuarantine = mocks.discardQuarantine;
  },
}));

import { previewItemDocument } from "./item-document-preview";

const config = {
  storageRoot: "C:/private/documents",
  quarantineRoot: "C:/private/quarantine",
  maxBytes: 25 * 1_048_576,
  scanMode: "required" as const,
  clamAv: { host: "clamav", port: 3310, timeoutMs: 30_000 },
};

const QUARANTINE = "C:/private/quarantine/opaque.upload";

function received(bytes = syntheticPdf()) {
  return {
    quarantinePath: QUARANTINE,
    sizeBytes: bytes.length,
    contentSha256: "not-returned-to-client",
    leadingBytes: bytes.subarray(0, 512),
  };
}

const page = () => ({ bytes: Buffer.from([1, 2, 3]), mediaType: "image/jpeg" as const, width: 10, height: 14 });

const input = () => ({
  userId: "user-1",
  householdId: "11111111-1111-4111-8111-111111111111",
  body: null,
  declaredBytes: 1234,
});

describe("item document preview (pre-attachment page one)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.effectiveLimit = null;
    mocks.config.mockReturnValue(config);
    mocks.access.mockResolvedValue(undefined);
    mocks.receive.mockResolvedValue(received());
    mocks.readQuarantine.mockResolvedValue(syntheticPdf());
    mocks.discardQuarantine.mockResolvedValue(undefined);
    mocks.scan.mockResolvedValue({ status: "clean" });
    mocks.render.mockResolvedValue(page());
  });

  it("scans the temporary upload clean, then renders page one through the one renderer", async () => {
    const result = await previewItemDocument(input());

    expect(mocks.access).toHaveBeenCalledWith("user-1", input().householdId);
    expect(mocks.receive).toHaveBeenCalledWith(null, expect.any(String), config.maxBytes, 1234);
    expect(mocks.scan).toHaveBeenCalledWith(QUARANTINE, config.clamAv);
    expect(mocks.render).toHaveBeenCalledWith(expect.any(Buffer), "application/pdf", 1);
    expect(mocks.scan.mock.invocationCallOrder[0]).toBeLessThan(mocks.render.mock.invocationCallOrder[0]);
    expect(result).toEqual({ ...page(), scanned: true });
  });

  it("draws the page it was asked for, after the same scan (#1300)", async () => {
    await previewItemDocument({ ...input(), page: 3 });

    expect(mocks.render).toHaveBeenCalledWith(expect.any(Buffer), "application/pdf", 3);
    expect(mocks.scan.mock.invocationCallOrder[0]).toBeLessThan(mocks.render.mock.invocationCallOrder[0]);
  });

  it("holds the upload to the administrator's limit, not the configured default (#1285)", async () => {
    mocks.effectiveLimit = 2 * 1_048_576;
    await previewItemDocument(input());
    expect(mocks.receive).toHaveBeenCalledWith(null, expect.any(String), 2 * 1_048_576, 1234);
    expect(mocks.readQuarantine).toHaveBeenCalledWith(QUARANTINE, 2 * 1_048_576);
  });

  it("retains nothing: the quarantine copy is discarded and the bytes zeroed, on success and on refusal", async () => {
    const bytes = syntheticPdf();
    mocks.readQuarantine.mockResolvedValue(bytes);
    await previewItemDocument(input());
    expect(mocks.discardQuarantine).toHaveBeenCalledWith(QUARANTINE);
    expect(bytes.every((byte) => byte === 0)).toBe(true);

    const refused = syntheticPdf();
    mocks.readQuarantine.mockResolvedValue(refused);
    mocks.render.mockRejectedValue(new AppError("document_preview_failed", "no picture", 422));
    await expect(previewItemDocument(input())).rejects.toMatchObject({ code: "document_preview_failed" });
    expect(mocks.discardQuarantine).toHaveBeenCalledTimes(2);
    expect(refused.every((byte) => byte === 0)).toBe(true);
  });

  it("refuses malware before drawing anything, in the upload path's own words", async () => {
    mocks.scan.mockResolvedValue({ status: "infected" });
    await expect(previewItemDocument(input())).rejects.toMatchObject({ code: "document_malware_detected", status: 422 });
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("reports a scanner that cannot be reached as the inspection path does", async () => {
    mocks.scan.mockResolvedValue({ status: "error", reason: "unavailable" });
    await expect(previewItemDocument(input())).rejects.toMatchObject({ code: "document_scanner_unreachable", status: 503 });
    mocks.scan.mockResolvedValue({ status: "error", reason: "protocol" });
    await expect(previewItemDocument(input())).rejects.toMatchObject({ code: "document_scanner_failed", status: 503 });
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("draws the page without a scan where scanning is disabled, and says it did not scan", async () => {
    mocks.config.mockReturnValue({ ...config, scanMode: "disabled" as const });
    const result = await previewItemDocument(input());
    expect(mocks.scan).not.toHaveBeenCalled();
    expect(result.scanned).toBe(false);
  });

  describe("announces the end of the scan, so the reading card can say it moved on (ADR-0033)", () => {
    it("says the scan passed after scanning and before the renderer opens anything", async () => {
      const onScanned = vi.fn();
      await previewItemDocument({ ...input(), onScanned });
      expect(onScanned).toHaveBeenCalledExactlyOnceWith(true);
      expect(mocks.scan.mock.invocationCallOrder[0]).toBeLessThan(onScanned.mock.invocationCallOrder[0]);
      expect(onScanned.mock.invocationCallOrder[0]).toBeLessThan(mocks.readQuarantine.mock.invocationCallOrder[0]);
      expect(onScanned.mock.invocationCallOrder[0]).toBeLessThan(mocks.render.mock.invocationCallOrder[0]);
    });

    it("says nothing was scanned where scanning is disabled", async () => {
      mocks.config.mockReturnValue({ ...config, scanMode: "disabled" as const });
      const onScanned = vi.fn();
      await previewItemDocument({ ...input(), onScanned });
      expect(onScanned).toHaveBeenCalledExactlyOnceWith(false);
    });

    it("never announces a scan that did not pass", async () => {
      mocks.scan.mockResolvedValue({ status: "infected" });
      const onScanned = vi.fn();
      await expect(previewItemDocument({ ...input(), onScanned })).rejects.toMatchObject({ code: "document_malware_detected" });
      expect(onScanned).not.toHaveBeenCalled();
    });
  });

  it("refuses a file that is not a PDF, JPEG or PNG without reading it further", async () => {
    mocks.receive.mockResolvedValue(received(Buffer.from("plain text, not a document")));
    await expect(previewItemDocument(input())).rejects.toMatchObject({ code: "document_type_unsupported", status: 415 });
    expect(mocks.scan).not.toHaveBeenCalled();
    expect(mocks.discardQuarantine).toHaveBeenCalledWith(QUARANTINE);
  });
});
