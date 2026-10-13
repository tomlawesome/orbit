import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "@/lib/logger";
import { useScratchTemporaryDirectory, type ScratchDirectory } from "../../../tests/support/scratch-directory";
import { syntheticPdf } from "../../../tests/support/synthetic-documents";
import { syntheticNumberedPageWidth, syntheticPdfWithNumberedPages } from "../../../tests/support/generated-pdf-documents";
import {
  DOCUMENT_PREVIEW_MAX_EDGE,
  renderDocumentPagePreview,
  setDocumentPreviewRenderBudgetForTests,
} from "./preview";

/**
 * Page-one preview rendering (#476).
 *
 * These tests exercise the real renderer — PDF.js parsing real PDF bytes into
 * the real Skia canvas — because the whole point of the slice is that a
 * picture comes out. Nothing here is stubbed, so the temporary-directory
 * assertions below are meaningful evidence rather than a rehearsal.
 */

/** A real, decodable raster of the requested size, encoded by the same backend. */
function rasterFixture(mediaType: "image/jpeg" | "image/png", width: number, height: number): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#204070";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#f0c040";
  context.fillRect(0, 0, Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
  return mediaType === "image/jpeg" ? canvas.toBuffer("image/jpeg", 90) : canvas.toBuffer("image/png");
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * A small, valid PDF whose one page draws one flat-colour Flate image of the
 * declared size. The pixels are all one value, so the file stays a few dozen
 * kilobytes while the decoded image is width x height bytes.
 */
function pdfDrawingFlatImage(width: number, height: number): Buffer {
  const pixels = deflateSync(Buffer.alloc(width * height, 0x80), { level: 9 });
  const content = Buffer.from("q 400 0 0 400 100 200 cm /Im0 Do Q");
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>"),
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${pixels.length} >>\nstream\n`),
      pixels,
      Buffer.from("\nendstream"),
    ]),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]),
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n")];
  const offsets: number[] = [];
  let length = parts[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const wrapped = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    parts.push(wrapped);
    length += wrapped.length;
  });
  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  trailer += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  trailer += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(trailer));
  return Buffer.concat(parts);
}

/**
 * The grey level the preview shows at the centre of the square the fixture's
 * image is drawn into (400x400 points at 100,200 on a 612x792 page).
 */
async function greyAtFixtureImageCentre(preview: { bytes: Buffer; width: number }): Promise<number> {
  const image = await loadImage(preview.bytes);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const scale = preview.width / 612;
  return context.getImageData(Math.round(300 * scale), Math.round((792 - 400) * scale), 1, 1).data[0];
}

let scratch: ScratchDirectory;

beforeEach(() => {
  scratch = useScratchTemporaryDirectory("orbit-preview-render");
});

afterEach(() => {
  scratch.restore();
});

describe("renderDocumentPagePreview", () => {
  it("renders page one of a PDF to a bounded PNG without writing anything to disk", async () => {
    const preview = await renderDocumentPagePreview(syntheticPdf("Preview fixture"), "application/pdf");

    expect(preview.mediaType).toBe("image/png");
    expect(Math.max(preview.width, preview.height)).toBe(DOCUMENT_PREVIEW_MAX_EDGE);
    // 612x792pt US Letter, scaled to the long edge.
    expect(preview).toMatchObject({ width: 927, height: DOCUMENT_PREVIEW_MAX_EDGE });
    expect(pngDimensions(preview.bytes)).toEqual({ width: preview.width, height: preview.height });
    expect(preview.bytes.length).toBeGreaterThan(0);
    expect(scratch.entries()).toEqual([]);
  });

  it("draws with its own canvas backend when a foreign Path2D owns the global", async () => {
    // The standalone container image materialises pnpm's symlinked duplicates
    // of @napi-rs/canvas as separate directories, so PDF.js polyfills
    // globalThis.Path2D from a second native Skia addon and every glyph
    // outline it hands the renderer's context is a foreign object Skia refuses
    // ("Value is none of these types `String`, `Path`"). A stand-in with the
    // same surface stands for that second addon here: the renderer must ignore
    // it and still draw the page's text (#476).
    const foreignPath2D = class ForeignPath2D {
      moveTo() { /* accepts the outline, produces nothing Skia knows */ }
      lineTo() {}
      bezierCurveTo() {}
      quadraticCurveTo() {}
      closePath() {}
    };
    const globals = globalThis as unknown as Record<string, unknown>;
    const restore = globals.Path2D;
    globals.Path2D = foreignPath2D;
    try {
      const preview = await renderDocumentPagePreview(syntheticPdf("Preview fixture"), "application/pdf");

      expect(globals.Path2D).not.toBe(foreignPath2D);
      // A blank white page of this size compresses to a few hundred bytes; the
      // drawn text is what pushes it past this.
      expect(preview.bytes.length).toBeGreaterThan(2_000);
    } finally {
      globals.Path2D = restore;
    }
  });

  it("renders a real producer's PDF, drawing content rather than a blank page", async () => {
    const bytes = readFileSync(resolve(import.meta.dirname, "../../../tests/support/fixtures/chromium-synthetic.pdf"));

    const preview = await renderDocumentPagePreview(bytes, "application/pdf");

    expect(preview.mediaType).toBe("image/png");
    expect(Math.max(preview.width, preview.height)).toBe(DOCUMENT_PREVIEW_MAX_EDGE);
    // A blank white page of this size compresses to a few hundred bytes; the
    // rendered fixture's heading, table and rules are what push it past this.
    expect(preview.bytes.length).toBeGreaterThan(5_000);
  });

  it("passes an already-raster PNG through, downscaling to the bounded long edge", async () => {
    const preview = await renderDocumentPagePreview(rasterFixture("image/png", 2_400, 1_200), "image/png");

    expect(preview).toMatchObject({ mediaType: "image/png", width: DOCUMENT_PREVIEW_MAX_EDGE, height: 600 });
    expect(pngDimensions(preview.bytes)).toEqual({ width: DOCUMENT_PREVIEW_MAX_EDGE, height: 600 });
    expect(scratch.entries()).toEqual([]);
  });

  it("passes an already-raster JPEG through as a JPEG", async () => {
    const preview = await renderDocumentPagePreview(rasterFixture("image/jpeg", 1_600, 2_000), "image/jpeg");

    expect(preview).toMatchObject({ mediaType: "image/jpeg", width: 960, height: DOCUMENT_PREVIEW_MAX_EDGE });
    expect(preview.bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it("never upscales a raster smaller than the bound", async () => {
    const preview = await renderDocumentPagePreview(rasterFixture("image/png", 320, 200), "image/png");

    expect(preview).toMatchObject({ width: 320, height: 200 });
  });

  it("answers a bounded unsupported code for bytes that are not a supported document", async () => {
    await expect(renderDocumentPagePreview(Buffer.from("PK not a document"), "application/pdf"))
      .rejects.toMatchObject({
        code: "document_preview_unsupported",
        status: 415,
      });
  });

  it("answers a bounded unsupported code when the bytes disagree with the stored media type", async () => {
    await expect(renderDocumentPagePreview(rasterFixture("image/png", 40, 40), "application/pdf"))
      .rejects.toMatchObject({ code: "document_preview_unsupported", status: 415 });
  });

  it("answers a bounded unsupported code for a document the structure check refuses", async () => {
    const truncated = syntheticPdf("Preview fixture").subarray(0, 120);

    await expect(renderDocumentPagePreview(truncated, "application/pdf"))
      .rejects.toMatchObject({ code: "document_preview_unsupported", status: 415 });
  });

  it("leaves nothing behind on disk after a refusal", async () => {
    await expect(renderDocumentPagePreview(Buffer.alloc(64), "application/pdf")).rejects.toThrow();

    expect(scratch.entries()).toEqual([]);
  });

  describe("any page, not only page one (#1300)", () => {
    /** The preview width a page of the numbered fixture draws at: its own points, scaled to the 792pt height's bound. */
    const drawnWidth = (page: number) => Math.round(syntheticNumberedPageWidth(page) * (DOCUMENT_PREVIEW_MAX_EDGE / 792));

    it("draws page one when no page is asked for, and says how many pages there are", async () => {
      const preview = await renderDocumentPagePreview(syntheticPdfWithNumberedPages(3), "application/pdf");

      expect(preview).toMatchObject({ pageCount: 3, width: drawnWidth(1), height: DOCUMENT_PREVIEW_MAX_EDGE });
    });

    it("draws the page asked for, every one of them, to the last", async () => {
      const bytes = syntheticPdfWithNumberedPages(3);

      for (const page of [1, 2, 3]) {
        const preview = await renderDocumentPagePreview(bytes, "application/pdf", page);
        expect(preview).toMatchObject({ mediaType: "image/png", pageCount: 3, width: drawnWidth(page) });
        expect(pngDimensions(preview.bytes)).toEqual({ width: drawnWidth(page), height: DOCUMENT_PREVIEW_MAX_EDGE });
      }
      expect(scratch.entries()).toEqual([]);
    });

    it("refuses a page past the end in its own words, once the document has passed every check", async () => {
      await expect(renderDocumentPagePreview(syntheticPdfWithNumberedPages(3), "application/pdf", 4))
        .rejects.toMatchObject({ code: "document_preview_page_not_found", status: 404 });
    });

    it("still refuses what upload refused before it looks for any page", async () => {
      const truncated = syntheticPdf("Preview fixture").subarray(0, 120);

      await expect(renderDocumentPagePreview(truncated, "application/pdf", 2))
        .rejects.toMatchObject({ code: "document_preview_unsupported", status: 415 });
    });

    it("still keeps to the render budget for a later page", async () => {
      setDocumentPreviewRenderBudgetForTests(0);
      try {
        await expect(renderDocumentPagePreview(syntheticPdfWithNumberedPages(3), "application/pdf", 3))
          .rejects.toMatchObject({ code: "document_preview_failed", status: 422 });
      } finally {
        setDocumentPreviewRenderBudgetForTests(undefined);
      }
    });

    it("refuses page 0, a negative page and a fraction from a direct caller, drawing nothing", async () => {
      for (const page of [0, -1, 1.5, Number.NaN]) {
        await expect(renderDocumentPagePreview(syntheticPdfWithNumberedPages(3), "application/pdf", page))
          .rejects.toMatchObject({ code: "document_preview_page_invalid", status: 400 });
      }
    });

    it("counts an image as one page, and refuses a second", async () => {
      const png = rasterFixture("image/png", 320, 200);

      await expect(renderDocumentPagePreview(png, "image/png")).resolves.toMatchObject({ pageCount: 1 });
      await expect(renderDocumentPagePreview(png, "image/png", 1)).resolves.toMatchObject({ pageCount: 1 });
      await expect(renderDocumentPagePreview(png, "image/png", 2))
        .rejects.toMatchObject({ code: "document_preview_page_not_found", status: 404 });
    });
  });

  describe("an image bigger than the pixel cap inside a PDF (#1316)", () => {
    // pdf.js refuses the over-cap image, but its render API ends the page at
    // that point and resolves rather than rejecting, so the page comes back
    // without the image instead of as a 422.
    it("leaves out, rather than decodes, a flat-colour 8000x8000 image (64M pixels, over the 40M cap)", async () => {
      const bomb = pdfDrawingFlatImage(8_000, 8_000);
      // Small on the wire, huge once decoded: the point of the fixture.
      expect(bomb.length).toBeLessThan(1_000_000);

      const preview = await renderDocumentPagePreview(bomb, "application/pdf");

      expect(await greyAtFixtureImageCentre(preview)).toBe(0xff);
    });

    it("still draws a page whose image is well under the cap", async () => {
      const preview = await renderDocumentPagePreview(pdfDrawingFlatImage(1_000, 1_000), "application/pdf");

      expect(preview.mediaType).toBe("image/png");
      expect(preview.pageCount).toBe(1);
      expect(await greyAtFixtureImageCentre(preview)).toBe(0x80);
    });
  });

  describe("document.preview logging (#494)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("records a bounded refusal, never the document's bytes or a parser message, for an unsupported type", async () => {
      const info = vi.spyOn(log, "info").mockImplementation(() => undefined);

      await expect(renderDocumentPagePreview(Buffer.from("PK not a document"), "application/pdf")).rejects.toThrow();

      expect(info).toHaveBeenCalledExactlyOnceWith({
        event: "document.preview",
        state: "blocked",
        reason: "unsupported_structure",
        action: "check_parser",
        impact: "none",
      });
    });

    it("records the mismatch reason when sniffed bytes disagree with the stored media type", async () => {
      const info = vi.spyOn(log, "info").mockImplementation(() => undefined);

      await expect(renderDocumentPagePreview(rasterFixture("image/png", 40, 40), "application/pdf")).rejects.toThrow();

      expect(info).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        event: "document.preview",
        reason: "unsupported_structure",
      }));
    });

    it("records the structure check's own reason rather than a generic one", async () => {
      const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
      const truncated = syntheticPdf("Preview fixture").subarray(0, 120);

      await expect(renderDocumentPagePreview(truncated, "application/pdf")).rejects.toThrow();

      expect(info).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        event: "document.preview",
        reason: "unsupported_structure",
      }));
    });

    it("records a warn-level refusal, distinct from the 415 info-level one, when the render budget is exceeded", async () => {
      const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
      const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
      setDocumentPreviewRenderBudgetForTests(0);

      try {
        await expect(renderDocumentPagePreview(syntheticPdf("Preview fixture"), "application/pdf")).rejects.toMatchObject({
          code: "document_preview_failed",
          status: 422,
        });
      } finally {
        setDocumentPreviewRenderBudgetForTests(undefined);
      }

      expect(info).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledExactlyOnceWith({
        event: "document.preview",
        state: "blocked",
        reason: "processing_interrupted",
        action: "none",
        impact: "none",
      });
    });

    it("never logs a bounded document.preview event for a preview that succeeds", async () => {
      const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
      const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

      await renderDocumentPagePreview(syntheticPdf("Preview fixture"), "application/pdf");

      expect(info).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
