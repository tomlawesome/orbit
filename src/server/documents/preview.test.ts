import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "@/lib/logger";
import { AT_CAP_EDGE, progressive40Mpx } from "../../../tests/support/image-fixtures";
import { jpegFrameSize, NEEDS_POPPLER, popplerIt } from "../../../tests/support/poppler-sandbox";
import { useScratchTemporaryDirectory, type ScratchDirectory } from "../../../tests/support/scratch-directory";
import { syntheticPdf } from "../../../tests/support/synthetic-documents";
import { syntheticNumberedPageWidth, syntheticPdfWithNumberedPages } from "../../../tests/support/generated-pdf-documents";
import { syntheticUserPasswordPdf } from "../../../tests/support/encrypted-pdf-documents";
import {
  lastPdfSandboxChildPidForTests,
  pdfStructureSandboxInFlightForTests,
  setPdfStructureSandboxLimitsForTests,
} from "./pdf-structure-sandbox";
import {
  DOCUMENT_PREVIEW_MAX_EDGE,
  renderDocumentPagePreview,
  setDocumentPreviewRenderBudgetForTests,
} from "./preview";

// Counts the child processes the sandbox starts (#1572): a preview is one child
// run, with the gate inside, not a check followed by a draw. Everything passes through.
const spawned = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      spawned.count += 1;
      return (actual.spawn as (...all: unknown[]) => ReturnType<typeof actual.spawn>)(...args);
    },
  };
});

/**
 * Page previews (#476, #1436).
 *
 * These tests exercise the real renderers: poppler's pdftoppm for a PDF, the
 * Skia canvas for an image. The PDF cases are `popplerIt`, skipped outside CI
 * where poppler is missing and failed in CI. The poppler-specific ceilings,
 * stops and child environment are pinned in pdf-structure-sandbox-poppler.test.ts.
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

function setSandboxLimits(limits: { imageMemoryMb?: number } | undefined): void {
  setPdfStructureSandboxLimitsForTests(limits as Parameters<typeof setPdfStructureSandboxLimitsForTests>[0]);
}

/** Everything logged at any level, as one string, and how many calls. */
function captureLogs(): () => { logged: string; calls: number } {
  const spies = (["error", "warn", "info", "debug"] as const).map((level) =>
    vi.spyOn(log, level).mockImplementation(() => undefined));
  return () => {
    const recorded = spies.flatMap((spy) => spy.mock.calls);
    return { logged: JSON.stringify(recorded), calls: recorded.length };
  };
}


/**
 * Waits up to 2 s for the job's child to be gone: `process.kill(pid, 0)`
 * throwing ESRCH. `before` is the last child pid seen before the job, so the
 * pid checked is this job's own child, not an earlier one.
 */
async function expectChildGone(before: number | undefined): Promise<void> {
  const pid = lastPdfSandboxChildPidForTests();
  expect(pid).toEqual(expect.any(Number));
  expect(pid).not.toBe(before);
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      process.kill(pid as number, 0);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
      return;
    }
    if (Date.now() > deadline) throw new Error(`the job's child ${pid} was still running 2 s after the job settled`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
let scratch: ScratchDirectory;

beforeEach(() => {
  scratch = useScratchTemporaryDirectory("orbit-preview-render");
});

afterEach(() => {
  scratch.restore();
});

describe(`renderDocumentPagePreview ${NEEDS_POPPLER}`, () => {
  popplerIt("renders page one of a PDF to a bounded JPEG without writing anything to disk", async () => {
    const preview = await renderDocumentPagePreview(syntheticPdf("Preview fixture"), "application/pdf");

    expect(preview.mediaType).toBe("image/jpeg");
    expect(Math.max(preview.width, preview.height)).toBe(DOCUMENT_PREVIEW_MAX_EDGE);
    // 612x792pt US Letter, scaled to the long edge; pdftoppm rounds the short edge up.
    expect(preview).toMatchObject({ width: 928, height: DOCUMENT_PREVIEW_MAX_EDGE });
    expect(jpegFrameSize(preview.bytes)).toEqual({ width: preview.width, height: preview.height });
    expect(preview.bytes.length).toBeGreaterThan(0);
    expect(scratch.entries()).toEqual([]);
  });

  popplerIt("renders a real producer's PDF, drawing content rather than a blank page", async () => {
    const bytes = readFileSync(resolve(import.meta.dirname, "../../../tests/support/fixtures/chromium-synthetic.pdf"));

    const preview = await renderDocumentPagePreview(bytes, "application/pdf");

    expect(preview.mediaType).toBe("image/jpeg");
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

  describe("an image is drawn in one sandbox child run, with the gate inside (#1572)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      setPdfStructureSandboxLimitsForTests(undefined);
      setDocumentPreviewRenderBudgetForTests(undefined);
    });

    it.each([
      ["a JPEG", () => rasterFixture("image/jpeg", 1_600, 2_000), "image/jpeg"],
      ["a PNG", () => rasterFixture("image/png", 2_400, 1_200), "image/png"],
    ] as const)("starts exactly one child for a preview of %s", async (_name, build, mediaType) => {
      const bytes = build();
      const before = spawned.count;
      const pidBefore = lastPdfSandboxChildPidForTests();

      await renderDocumentPagePreview(bytes, mediaType);

      expect(spawned.count - before, "children started by one preview").toBe(1);
      expect(lastPdfSandboxChildPidForTests()).not.toBe(pidBefore);
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    }, 30_000);

    // A PDF whose page count is already stored is one pdftoppm run; without it, pdfinfo runs beside the draw (#1436).
    popplerIt("starts exactly one child for a preview of a PDF whose page count is stored", async () => {
      const before = spawned.count;
      const pidBefore = lastPdfSandboxChildPidForTests();

      await renderDocumentPagePreview(syntheticPdf("Preview fixture"), "application/pdf", 1, { pageCount: 1 });

      expect(spawned.count - before, "children started by one preview").toBe(1);
      expect(lastPdfSandboxChildPidForTests()).not.toBe(pidBefore);
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    }, 30_000);

    it("starts no child for an image the header fence refuses, and answers unsupported", async () => {
      const overCap = rasterFixture("image/png", 40, 40);
      overCap.writeUInt32BE(10_000, 16);
      overCap.writeUInt32BE(10_000, 20);
      const before = spawned.count;

      await expect(renderDocumentPagePreview(overCap, "image/png"))
        .rejects.toMatchObject({ code: "document_preview_unsupported", status: 415 });

      expect(spawned.count - before).toBe(0);
    });

    it("answers page not found for page 2 of a good image, and still refuses an over-cap one as unsupported without a child", async () => {
      await expect(renderDocumentPagePreview(rasterFixture("image/png", 40, 40), "image/png", 2))
        .rejects.toMatchObject({ code: "document_preview_page_not_found", status: 404 });

      const overCap = rasterFixture("image/png", 40, 40);
      overCap.writeUInt32BE(10_000, 16);
      overCap.writeUInt32BE(10_000, 20);
      const before = spawned.count;
      await expect(renderDocumentPagePreview(overCap, "image/png", 2))
        .rejects.toMatchObject({ code: "document_preview_unsupported", status: 415 });
      expect(spawned.count - before).toBe(0);
    }, 30_000);

    it("answers document_preview_failed, logged as processing_interrupted and saying memory, when the child hits its ceiling", async () => {
      const read = captureLogs();
      const warn = vi.spyOn(log, "warn");
      // A 60 s budget and a 64 MiB ceiling: a stop inside the test timeout can only be memory or a crash, and the log says which.
      setDocumentPreviewRenderBudgetForTests(60_000);
      setSandboxLimits({ imageMemoryMb: 64 });
      const bytes = progressive40Mpx();
      const pidBefore = lastPdfSandboxChildPidForTests();

      await expect(renderDocumentPagePreview(bytes, "image/jpeg"))
        .rejects.toMatchObject({ code: "document_preview_failed", status: 422 });

      expect(lastPdfSandboxChildPidForTests(), "the decode ran in a child").not.toBe(pidBefore);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({
        event: "document.preview",
        reason: "processing_interrupted",
      }));
      const { logged } = read();
      expect(logged).toMatch(/memory/i);
      expect(logged).not.toMatch(/timeout|timed.?out/i);
      expect(logged).not.toMatch(/crash/i);
      // Nothing of the file: no byte dump, no size.
      expect(logged.length).toBeLessThan(2_000);
      expect(logged).not.toContain(String(bytes.length));
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
      await expectChildGone(pidBefore);
    }, 30_000);

    it("draws the progressive 40 Mpx JPEG down to the preview bound, as a JPEG", async () => {
      setDocumentPreviewRenderBudgetForTests(60_000);

      const preview = await renderDocumentPagePreview(progressive40Mpx(), "image/jpeg");

      expect(preview).toMatchObject({ mediaType: "image/jpeg", width: DOCUMENT_PREVIEW_MAX_EDGE, height: DOCUMENT_PREVIEW_MAX_EDGE, pageCount: 1 });
      expect(AT_CAP_EDGE).toBeGreaterThan(DOCUMENT_PREVIEW_MAX_EDGE);
      expect(preview.bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    }, 60_000);
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

  popplerIt("answers a bounded unsupported code for a document the structure check refuses", async () => {
    const truncated = syntheticPdf("Preview fixture").subarray(0, 120);

    await expect(renderDocumentPagePreview(truncated, "application/pdf"))
      .rejects.toMatchObject({ code: "document_preview_unsupported", status: 415 });
  });

  popplerIt("leaves nothing behind on disk after a refusal", async () => {
    await expect(renderDocumentPagePreview(Buffer.alloc(64), "application/pdf")).rejects.toThrow();

    expect(scratch.entries()).toEqual([]);
  });

  describe("any page, not only page one (#1300)", () => {
    /** The preview width a page of the numbered fixture draws at: its own points, scaled to the 792pt height's bound, rounded up as pdftoppm does. */
    const drawnWidth = (page: number) => Math.ceil(syntheticNumberedPageWidth(page) * (DOCUMENT_PREVIEW_MAX_EDGE / 792));

    popplerIt("draws page one when no page is asked for, and says how many pages there are", async () => {
      const preview = await renderDocumentPagePreview(syntheticPdfWithNumberedPages(3), "application/pdf");

      expect(preview).toMatchObject({ pageCount: 3, width: drawnWidth(1), height: DOCUMENT_PREVIEW_MAX_EDGE });
    });

    popplerIt("draws the page asked for, every one of them, to the last", async () => {
      const bytes = syntheticPdfWithNumberedPages(3);

      for (const page of [1, 2, 3]) {
        const preview = await renderDocumentPagePreview(bytes, "application/pdf", page);
        expect(preview).toMatchObject({ mediaType: "image/jpeg", pageCount: 3, width: drawnWidth(page) });
        expect(jpegFrameSize(preview.bytes)).toEqual({ width: drawnWidth(page), height: DOCUMENT_PREVIEW_MAX_EDGE });
      }
      expect(scratch.entries()).toEqual([]);
    });

    popplerIt("refuses a page past the end in its own words, once the document has passed every check", async () => {
      await expect(renderDocumentPagePreview(syntheticPdfWithNumberedPages(3), "application/pdf", 4))
        .rejects.toMatchObject({ code: "document_preview_page_not_found", status: 404 });
    });

    popplerIt("still refuses what upload refused before it looks for any page", async () => {
      const truncated = syntheticPdf("Preview fixture").subarray(0, 120);

      await expect(renderDocumentPagePreview(truncated, "application/pdf", 2))
        .rejects.toMatchObject({ code: "document_preview_unsupported", status: 415 });
    });

    popplerIt("still keeps to the render budget for a later page", async () => {
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

    popplerIt("records the structure check's own reason rather than a generic one", async () => {
      const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
      const truncated = syntheticPdf("Preview fixture").subarray(0, 120);

      await expect(renderDocumentPagePreview(truncated, "application/pdf")).rejects.toThrow();

      expect(info).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        event: "document.preview",
        reason: "unsupported_structure",
      }));
    });

    popplerIt("records a warn-level refusal, distinct from the 415 info-level one, when the render budget is exceeded", async () => {
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

    popplerIt("never logs a bounded document.preview event for a preview that succeeds", async () => {
      const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
      const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

      await renderDocumentPagePreview(syntheticPdf("Preview fixture"), "application/pdf");

      expect(info).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("a password-protected PDF", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    popplerIt("refuses a user-password PDF on the render path as unsupported, saying a password is needed", async () => {
      const read = captureLogs();

      await expect(renderDocumentPagePreview(syntheticUserPasswordPdf(), "application/pdf"))
        .rejects.toMatchObject({ code: "document_preview_unsupported", status: 415 });

      expect(read().logged).toContain("password_required");
    }, 15_000);
  });
});
