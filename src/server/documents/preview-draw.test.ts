import { createCanvas } from "@napi-rs/canvas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, RetryLaterError } from "@/lib/errors";
import { syntheticPdf } from "../../../tests/support/synthetic-documents";

/**
 * The kept-page draws (#1433 D13, D18, D20, D21) and the answers their
 * refusals give, with the sandbox's answer stood in: what is under test is how
 * each answer maps to a stored drawing, a remembered refusal, or `busy`, and
 * that a remembered refusal answers what the live draw answered. The real
 * renderers are exercised by preview.test.ts and the poppler sandbox suites.
 */

const sandbox = vi.hoisted(() => ({
  pdf: vi.fn(),
  image: vi.fn(),
}));

vi.mock("@/server/documents/pdf-structure-sandbox", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/documents/pdf-structure-sandbox")>();
  return { ...original, renderPdfPageInSandbox: sandbox.pdf, renderImageInSandbox: sandbox.image };
});

const {
  DOCUMENT_PREVIEW_BUSY_RETRY_SECONDS,
  DOCUMENT_PREVIEW_MAX_EDGE,
  drawDocumentPage,
  drawImagePage,
  drawPdfPage,
  drawRefusalError,
  previewBusyError,
  refusedPreviewError,
} = await import("./preview");

const pdf = Buffer.from(syntheticPdf());
const png = createCanvas(2_400, 600).toBuffer("image/png");
const picture = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

beforeEach(() => {
  sandbox.pdf.mockReset();
  sandbox.image.mockReset();
});

function codeAndStatus(error: AppError) {
  return { code: error.code, status: error.status };
}

describe("drawPdfPage", () => {
  it("keeps a drawn page as a JPEG, with the page count when the sandbox read one", async () => {
    sandbox.pdf.mockResolvedValueOnce({ outcome: "drawn", bytes: picture, width: 900, height: 1200, pageCount: 4 });
    expect(await drawPdfPage({ bytes: pdf }, 2, "background", { pageCount: true })).toEqual({
      outcome: "drawn", bytes: picture, mediaType: "image/jpeg", width: 900, height: 1200, pageCount: 4,
    });
    expect(sandbox.pdf).toHaveBeenCalledWith({ bytes: pdf }, expect.objectContaining({ page: 2, maxEdge: DOCUMENT_PREVIEW_MAX_EDGE, pool: "background", pageCount: true }));
  });

  it("leaves the page count out when none was asked for or read", async () => {
    sandbox.pdf.mockResolvedValueOnce({ outcome: "drawn", bytes: picture, width: 900, height: 1200 });
    const draw = await drawPdfPage({ bytes: pdf }, 1, "view");
    expect(draw).not.toHaveProperty("pageCount");
    expect(sandbox.pdf).toHaveBeenCalledWith({ bytes: pdf }, expect.objectContaining({ pageCount: false }));
  });

  it("passes a page past the end through with the document's page count", async () => {
    sandbox.pdf.mockResolvedValueOnce({ outcome: "page_not_found", pageCount: 3 });
    expect(await drawPdfPage({ bytes: pdf }, 7, "background")).toEqual({ outcome: "page_not_found", pageCount: 3 });
  });

  it("remembers a renderer refusal as unsupported, keeping the structure reason", async () => {
    sandbox.pdf.mockResolvedValueOnce({ outcome: "refused", reason: "password_required" });
    expect(await drawPdfPage({ bytes: pdf }, 1, "background")).toEqual({ outcome: "refused", refusal: "unsupported", structure: "password_required" });
  });

  it.each([
    ["timeout", { outcome: "refused", refusal: "timeout" }],
    ["memory", { outcome: "refused", refusal: "memory" }],
    ["crash", { outcome: "refused", refusal: "crash" }],
    [undefined, { outcome: "refused", refusal: "parser" }],
    ["unavailable", { outcome: "busy" }],
  ])("maps a stopped child (%s) to what is remembered, never storing Orbit's own unavailability", async (stop, expected) => {
    sandbox.pdf.mockResolvedValueOnce({ outcome: "failed", stop });
    expect(await drawPdfPage({ bytes: pdf }, 1, "background")).toEqual(expected);
  });
});

describe("drawImagePage (D21)", () => {
  it("draws within the bounded edge, never upscaling, as one page in the image's own type", async () => {
    sandbox.image.mockResolvedValueOnce({ outcome: "drawn", bytes: picture, width: 1200, height: 300 });
    expect(await drawImagePage(png, "image/png", "background")).toEqual({
      outcome: "drawn", bytes: picture, mediaType: "image/png", width: 1200, height: 300, pageCount: 1,
    });
    expect(sandbox.image).toHaveBeenCalledWith(png, expect.objectContaining({ mediaType: "image/png", declared: { width: 2400, height: 600 }, width: 1200, height: 300, pool: "background" }));
  });

  it("refuses an image the header fence rejects without starting a child", async () => {
    expect(await drawImagePage(Buffer.from("not an image"), "image/png", "background")).toEqual({
      outcome: "refused", refusal: "unsupported", structure: "unsupported_structure",
    });
    expect(sandbox.image).not.toHaveBeenCalled();
  });

  it("remembers the child's refusal and its stops as the PDF draw does", async () => {
    sandbox.image.mockResolvedValueOnce({ outcome: "refused", reason: "unsupported_structure" });
    expect(await drawImagePage(png, "image/png", "view")).toEqual({ outcome: "refused", refusal: "unsupported", structure: "unsupported_structure" });
    sandbox.image.mockResolvedValueOnce({ outcome: "failed", stop: "memory" });
    expect(await drawImagePage(png, "image/png", "view")).toEqual({ outcome: "refused", refusal: "memory" });
    sandbox.image.mockResolvedValueOnce({ outcome: "failed", stop: "unavailable" });
    expect(await drawImagePage(png, "image/png", "view")).toEqual({ outcome: "busy" });
  });
});

describe("drawDocumentPage", () => {
  it("refuses a page that is not a positive whole number before anything is identified", async () => {
    for (const page of [0, -1, 1.5]) {
      await expect(drawDocumentPage(pdf, "application/pdf", page, "background")).rejects.toMatchObject({ status: 400 });
    }
    expect(sandbox.pdf).not.toHaveBeenCalled();
  });

  it("refuses (415) bytes that are no supported document, or not the stored media type, before any child starts", async () => {
    await expect(drawDocumentPage(Buffer.from("plain text"), "application/pdf", 1, "background")).rejects.toMatchObject({ code: "document_preview_unsupported", status: 415 });
    await expect(drawDocumentPage(pdf, "image/png", 1, "background")).rejects.toMatchObject({ code: "document_preview_unsupported", status: 415 });
    expect(sandbox.pdf).not.toHaveBeenCalled();
    expect(sandbox.image).not.toHaveBeenCalled();
  });

  it("sends a PDF to the page draw, passing the page-count request on", async () => {
    sandbox.pdf.mockResolvedValueOnce({ outcome: "page_not_found", pageCount: 1 });
    expect(await drawDocumentPage(pdf, "application/pdf", 2, "background", { pageCount: true })).toEqual({ outcome: "page_not_found", pageCount: 1 });
    expect(sandbox.pdf).toHaveBeenCalledWith({ bytes: pdf }, expect.objectContaining({ page: 2, pageCount: true }));
  });

  it("counts an image as one page: page 2 is not found and draws nothing", async () => {
    expect(await drawDocumentPage(png, "image/png", 2, "background")).toEqual({ outcome: "page_not_found", pageCount: 1 });
    expect(sandbox.image).not.toHaveBeenCalled();
    sandbox.image.mockResolvedValueOnce({ outcome: "drawn", bytes: picture, width: 1200, height: 300 });
    expect(await drawDocumentPage(png, "image/png", 1, "background")).toMatchObject({ outcome: "drawn", pageCount: 1 });
  });
});

describe("the answers a refusal gives (D18, D20)", () => {
  it("answers a remembered unsupported page 415, and every other refusal 422", () => {
    expect(codeAndStatus(refusedPreviewError("unsupported"))).toEqual({ code: "document_preview_unsupported", status: 415 });
    for (const refusal of ["memory", "timeout", "crash", "parser"] as const) {
      expect(codeAndStatus(refusedPreviewError(refusal)), refusal).toEqual({ code: "document_preview_failed", status: 422 });
    }
  });

  it("answers a first drawing's refusal as every later view will", () => {
    expect(codeAndStatus(drawRefusalError({ outcome: "refused", refusal: "unsupported", structure: "password_required" })))
      .toEqual({ code: "document_preview_unsupported", status: 415 });
    expect(codeAndStatus(drawRefusalError({ outcome: "refused", refusal: "timeout" })))
      .toEqual(codeAndStatus(refusedPreviewError("timeout")));
  });

  it("answers Orbit's own unavailability 503 with a retry, never a refusal", () => {
    const error = previewBusyError();
    expect(error).toBeInstanceOf(RetryLaterError);
    expect(error).toMatchObject({ code: "document_preview_busy", status: 503, retryAfterSeconds: DOCUMENT_PREVIEW_BUSY_RETRY_SECONDS });
  });
});
