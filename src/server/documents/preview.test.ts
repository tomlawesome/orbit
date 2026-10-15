import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "@/lib/logger";
import { useScratchTemporaryDirectory, type ScratchDirectory } from "../../../tests/support/scratch-directory";
import { syntheticPdf } from "../../../tests/support/synthetic-documents";
import { syntheticNumberedPageWidth, syntheticPdfWithNumberedPages } from "../../../tests/support/generated-pdf-documents";
import { setPdfStructureSandboxLimitsForTests } from "./pdf-structure-sandbox";
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

/**
 * A content-stream bomb: page one's /Contents is a FlateDecode stream of
 * `megabytes` of spaces behind one drawing operator. The file is a few hundred
 * kilobytes; only drawing the page decodes the stream.
 */
function pdfWithContentStreamBomb(megabytes: number): Buffer {
  const raw = Buffer.alloc(megabytes * 1024 * 1024, 0x20);
  raw.write("0 0 1 rg 10 10 100 100 re f\n", 0, "latin1");
  const packed = deflateSync(raw, { level: 9 });
  const parts: Buffer[] = [];
  const offsets: Record<number, number> = {};
  let length = 0;
  const push = (piece: Buffer | string): void => {
    const buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece, "latin1");
    parts.push(buffer);
    length += buffer.length;
  };
  push("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
  offsets[1] = length;
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  offsets[2] = length;
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  offsets[3] = length;
  push("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n");
  offsets[4] = length;
  push(`4 0 obj\n<< /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`);
  push(packed);
  push("\nendstream\nendobj\n");
  const xref = length;
  push("xref\n0 5\n0000000000 65535 f \n");
  for (let index = 1; index <= 4; index += 1) push(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/** A one-page PDF: an A4 JPEG "scan" at `dpi`, drawn full page as a DCTDecode image. */
function scannedA4Pdf(dpi: number): Buffer {
  const width = Math.round(8.27 * dpi);
  const height = Math.round(11.69 * dpi);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#f4f1e8";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#222222";
  context.font = `${dpi / 4}px sans-serif`;
  for (let y = dpi; y < height; y += dpi / 2) {
    context.fillText(`Lorem ipsum dolor sit amet, consectetur adipiscing elit ${y}`, dpi / 2, y);
  }
  const jpeg = canvas.toBuffer("image/jpeg", 85);
  const parts: Buffer[] = [];
  const offsets: Record<number, number> = {};
  let length = 0;
  const push = (piece: Buffer | string): void => {
    const buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece, "latin1");
    parts.push(buffer);
    length += buffer.length;
  };
  const content = "q 595 0 0 842 0 0 cm /Im0 Do Q\n";
  push("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
  offsets[1] = length;
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  offsets[2] = length;
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  offsets[3] = length;
  push("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n");
  offsets[4] = length;
  push(`4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  offsets[5] = length;
  push(`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push("\nendstream\nendobj\n");
  const xref = length;
  push("xref\n0 6\n0000000000 65535 f \n");
  for (let index = 1; index <= 5; index += 1) push(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

const MB = 1024 * 1024;

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

      // The page is drawn in the sandbox worker, which pins its own canvas
      // globals; the server thread's global is left exactly as it was.
      expect(globals.Path2D).toBe(foreignPath2D);
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

  describe("the page is drawn in the sandbox, never on the server's own thread (#1427)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      setPdfStructureSandboxLimitsForTests(undefined);
    });

    it("refuses a 128 MB content-stream bomb as a failed preview, quickly, with this thread free and the process not growing", async () => {
      const bomb = pdfWithContentStreamBomb(128);
      // Small on the wire, huge once decoded: the point of the fixture.
      expect(bomb.length).toBeLessThan(1_000_000);
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
      }, 50);
      const rssBefore = process.memoryUsage().rss;
      let peakRss = rssBefore;
      const sampler = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }, 15);
      const started = Date.now();

      try {
        await expect(renderDocumentPagePreview(bomb, "application/pdf"))
          .rejects.toMatchObject({ code: "document_preview_failed", status: 422 });
      } finally {
        clearInterval(timer);
        clearInterval(sampler);
      }
      peakRss = Math.max(peakRss, process.memoryUsage().rss);

      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(4_000);
      // Free thread: the 50 ms timer keeps ticking for as long as the call
      // takes. A thread busy decoding 128 MB ticks a handful of times at
      // most. Proportional, so a fast refusal is not failed for being fast.
      expect(ticks).toBeGreaterThanOrEqual(Math.floor((elapsed / 50) * 0.6));
      expect(peakRss - rssBefore).toBeLessThan(250 * MB);
    }, 15_000);

    it("draws a 300 dpi A4 scan to a PNG of the page's shape with the scan's pixels in it", async () => {
      const scan = scannedA4Pdf(300);

      const preview = await renderDocumentPagePreview(scan, "application/pdf");

      expect(preview.mediaType).toBe("image/png");
      expect(preview.pageCount).toBe(1);
      // A4 is 595x842 points; the preview scales it to the bounded long edge.
      expect(preview.height).toBe(DOCUMENT_PREVIEW_MAX_EDGE);
      expect(Math.abs(preview.width - Math.round((595 * DOCUMENT_PREVIEW_MAX_EDGE) / 842))).toBeLessThanOrEqual(1);
      expect(pngDimensions(preview.bytes)).toEqual({ width: preview.width, height: preview.height });
      const image = await loadImage(preview.bytes);
      const canvas = createCanvas(image.width, image.height);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      let nonWhite = 0;
      let dark = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset] < 0xf8 || pixels[offset + 1] < 0xf8 || pixels[offset + 2] < 0xf8) nonWhite += 1;
        if (pixels[offset] < 0x80) dark += 1;
      }
      // The scan's paper is off-white and its lines are dark: a blank page has neither.
      expect(nonWhite).toBeGreaterThan(image.width * image.height * 0.5);
      expect(dark).toBeGreaterThan(100);
    }, 30_000);

    it("keeps the render budget, the page-not-found answer and the structure check's reason", async () => {
      setDocumentPreviewRenderBudgetForTests(0);
      try {
        await expect(renderDocumentPagePreview(syntheticPdf("Preview fixture"), "application/pdf"))
          .rejects.toMatchObject({ code: "document_preview_failed", status: 422 });
      } finally {
        setDocumentPreviewRenderBudgetForTests(undefined);
      }
      await expect(renderDocumentPagePreview(syntheticPdfWithNumberedPages(3), "application/pdf", 4))
        .rejects.toMatchObject({ code: "document_preview_page_not_found", status: 404 });
      await expect(renderDocumentPagePreview(syntheticPdf("Preview fixture").subarray(0, 120), "application/pdf", 1))
        .rejects.toMatchObject({ code: "document_preview_unsupported", status: 415 });
    });

    it("logs a memory stop as a bounded record that says memory and carries nothing of the file", async () => {
      const spies = (["error", "warn", "info", "debug"] as const).map((level) =>
        vi.spyOn(log, level).mockImplementation(() => undefined));
      setPdfStructureSandboxLimitsForTests({ wallMs: 8_000, maxOldGenerationSizeMb: 32, externalAllowanceMb: 16 });
      const bomb = pdfWithContentStreamBomb(128);

      await expect(renderDocumentPagePreview(bomb, "application/pdf"))
        .rejects.toMatchObject({ code: "document_preview_failed", status: 422 });

      const recorded = spies.flatMap((spy) => spy.mock.calls);
      const logged = JSON.stringify(recorded);
      expect(recorded.length).toBeGreaterThan(0);
      expect(logged).toMatch(/memory/i);
      expect(logged).not.toMatch(/timeout|timed.?out/i);
      // Nothing of the document: no PDF syntax, no byte dump, no sizes of its streams.
      expect(logged).not.toMatch(/%PDF|\bobj\b|endstream|FlateDecode|MediaBox|\/Contents/i);
      expect(logged.length).toBeLessThan(2_000);
      expect(logged).not.toContain(String(bomb.length));
    }, 15_000);
  });
});
