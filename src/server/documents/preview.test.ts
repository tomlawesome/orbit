import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "@/lib/logger";
import { useScratchTemporaryDirectory, type ScratchDirectory } from "../../../tests/support/scratch-directory";
import { syntheticPdf } from "../../../tests/support/synthetic-documents";
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
