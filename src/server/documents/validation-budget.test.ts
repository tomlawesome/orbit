import { afterEach, describe, expect, it, vi } from "vitest";
import { syntheticPdf } from "../../../tests/support/synthetic-documents";

const mocks = vi.hoisted(() => ({ getDocument: vi.fn() }));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: mocks.getDocument,
  VerbosityLevel: { ERRORS: 0 },
}));

import {
  classifyDocumentStructure,
  PDF_STRUCTURE_INSPECTION_BUDGET_MS,
  PDF_STRUCTURE_MAX_PAGES,
} from "./validation";

describe("bounded PDF inspection", () => {
  afterEach(() => {
    mocks.getDocument.mockReset();
    vi.useRealTimers();
  });

  it("maps PDFs over the page cap to unsupported_structure", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    mocks.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: PDF_STRUCTURE_MAX_PAGES + 1 }),
      destroy,
    });

    await expect(classifyDocumentStructure(syntheticPdf(), "application/pdf"))
      .resolves.toBe("unsupported_structure");
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("maps an asynchronous parser budget expiry to unsupported_structure and destroys the task", async () => {
    vi.useFakeTimers();
    const destroy = vi.fn().mockResolvedValue(undefined);
    mocks.getDocument.mockReturnValue({
      promise: new Promise(() => undefined),
      destroy,
    });

    const result = classifyDocumentStructure(syntheticPdf(), "application/pdf");
    await vi.advanceTimersByTimeAsync(PDF_STRUCTURE_INSPECTION_BUDGET_MS + 1);

    await expect(result).resolves.toBe("unsupported_structure");
    expect(destroy).toHaveBeenCalledOnce();
  });
});
