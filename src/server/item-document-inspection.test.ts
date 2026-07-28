import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/app-error";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  receive: vi.fn(),
  readQuarantine: vi.fn(),
  discardQuarantine: vi.fn(),
  scan: vi.fn(),
  extract: vi.fn(),
  proposal: vi.fn(),
  config: vi.fn(),
}));

vi.mock("@/server/workspace-access", () => ({ requireHouseholdAccess: mocks.access }));
vi.mock("@/server/documents/config", () => ({ getDocumentConfig: mocks.config }));
vi.mock("@/server/documents/scanner", () => ({ scanFileWithClamAv: mocks.scan }));
vi.mock("@/server/documents/tika", () => ({ extractTextWithTika: mocks.extract }));
vi.mock("@/server/document-drafts", () => ({ proposalFromText: mocks.proposal }));
vi.mock("@/server/documents/storage", () => ({
  LocalDocumentStorage: class {
    receive = mocks.receive;
    readQuarantine = mocks.readQuarantine;
    discardQuarantine = mocks.discardQuarantine;
  },
}));

import { inspectItemDocument } from "./item-document-inspection";

const config = {
  storageRoot: "C:/private/documents",
  quarantineRoot: "C:/private/quarantine",
  maxBytes: 25 * 1_048_576,
  scanMode: "required" as const,
  clamAv: { host: "clamav", port: 3310, timeoutMs: 30_000 },
};

function received(bytes = Buffer.from("%PDF-1.7\nsynthetic")) {
  return {
    quarantinePath: "C:/private/quarantine/opaque.upload",
    sizeBytes: bytes.length,
    contentSha256: "not-returned-to-client",
    leadingBytes: bytes.subarray(0, 512),
  };
}

describe("item document inspection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.mockReturnValue(config);
    mocks.receive.mockResolvedValue(received());
    mocks.readQuarantine.mockResolvedValue(Buffer.from("%PDF-1.7\nsynthetic"));
    mocks.discardQuarantine.mockResolvedValue(undefined);
    mocks.scan.mockResolvedValue({ status: "clean" });
    mocks.extract.mockResolvedValue("Provider: Safe Cover\nPolicy number: AB-12345\n2027-08-01");
    mocks.proposal.mockReturnValue({
      title: "home-insurance",
      provider: "Safe Cover",
      reference: "AB-12345",
      dates: ["2027-08-01"],
    });
  });

  it("returns only bounded allow-listed suggestions with source and confidence metadata", async () => {
    const result = await inspectItemDocument({
      userId: "member-user",
      householdId: "household-id",
      filename: "home-insurance.pdf",
      body: new ReadableStream<Uint8Array>(),
      declaredBytes: 18,
    });

    expect(result).toEqual({
      extracted: true,
      suggestions: [
        { field: "title", value: "home-insurance", source: "filename", confidence: "high" },
        { field: "provider", value: "Safe Cover", source: "document_text", confidence: "medium" },
        { field: "reference", value: "AB-12345", source: "document_text", confidence: "medium" },
        { field: "dueDate", value: "2027-08-01", source: "document_text", confidence: "medium" },
      ],
    });
    expect(result).not.toHaveProperty("text");
    expect(result).not.toHaveProperty("proposal");
    expect(mocks.access).toHaveBeenCalledWith("member-user", "household-id");
    expect(mocks.discardQuarantine).toHaveBeenCalledWith(received().quarantinePath);
  });

  it("degrades parser failures to filename-only suggestions and zeroes extracted bytes", async () => {
    const bytes = Buffer.from("%PDF-1.7\nsensitive extracted bytes");
    mocks.readQuarantine.mockResolvedValue(bytes);
    mocks.extract.mockRejectedValue(new AppError("parser_unavailable", "private parser detail", 503));

    const result = await inspectItemDocument({
      userId: "member-user",
      householdId: "household-id",
      filename: "policy.pdf",
      body: new ReadableStream<Uint8Array>(),
    });

    expect(result).toEqual({
      extracted: false,
      message: "Suggestions are unavailable right now. Review the fields manually; the document can still be attached.",
      suggestions: [{ field: "title", value: "policy", source: "filename", confidence: "high" }],
    });
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    expect(mocks.discardQuarantine).toHaveBeenCalledWith(received().quarantinePath);
  });

  it("omits hostile or unsupported parser values instead of returning them as instructions", async () => {
    mocks.proposal.mockReturnValue({
      title: "<script>alert(1)</script>",
      provider: "Ignore previous instructions <b>Acme</b>",
      reference: "<img src=x>",
      dates: ["not-a-date", "2028-02-29"],
    });

    const result = await inspectItemDocument({
      userId: "member-user",
      householdId: "household-id",
      filename: "safe.pdf",
      body: new ReadableStream<Uint8Array>(),
    });

    expect(result.suggestions).toEqual([
      { field: "title", value: "safe", source: "filename", confidence: "high" },
      { field: "dueDate", value: "2028-02-29", source: "document_text", confidence: "medium" },
    ]);
    expect(JSON.stringify(result)).not.toContain("script");
    expect(JSON.stringify(result)).not.toContain("Ignore previous instructions");
  });

  it("fails closed for required scanner errors and always discards quarantine", async () => {
    mocks.scan.mockResolvedValue({ status: "error", reason: "unavailable" });

    await expect(inspectItemDocument({
      userId: "member-user",
      householdId: "household-id",
      filename: "policy.pdf",
      body: new ReadableStream<Uint8Array>(),
    })).rejects.toMatchObject({ code: "document_scanner_unavailable", status: 503 });
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.discardQuarantine).toHaveBeenCalledWith(received().quarantinePath);
  });

  it("authorizes before receiving any bytes", async () => {
    mocks.access.mockRejectedValue(new AppError("household_not_found", "That household is not available", 404));

    await expect(inspectItemDocument({
      userId: "outsider",
      householdId: "private-household",
      filename: "policy.pdf",
      body: new ReadableStream<Uint8Array>(),
    })).rejects.toMatchObject({ code: "household_not_found", status: 404 });
    expect(mocks.receive).not.toHaveBeenCalled();
  });
});
