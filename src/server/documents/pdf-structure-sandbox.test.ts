import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  syntheticPdfWithPages,
  syntheticStructurePdfFixtures,
} from "../../../tests/support/generated-pdf-documents";
import { syntheticOwnerPasswordPdf, syntheticUserPasswordPdf } from "../../../tests/support/encrypted-pdf-documents";
import { syntheticPdf, syntheticPdfWithXrefStream } from "../../../tests/support/synthetic-documents";
import {
  inspectPdfStructureInSandbox,
  PDF_STRUCTURE_SANDBOX_LIMITS,
  pdfStructureSandboxInFlightForTests,
  setPdfStructureInspectorForTests,
  setPdfStructureSandboxLimitsForTests,
} from "./pdf-structure-sandbox";
import { classifyDocumentStructure } from "./validation";

/**
 * The PDF structure check runs in a memory-capped, killable worker thread
 * (#1316). These tests use the real parser and the real worker: a hostile file
 * must come back as "unsupported_structure" without stalling this thread, and
 * a legitimate file must get the same answer it always did.
 *
 * Run vitest WITHOUT --max-old-space-size or a NODE_OPTIONS heap flag: such a
 * flag silently disables worker memory caps and makes the memory tests vacuous.
 */

const TEST_TIMEOUT_MS = 10_000;
const TEST_LIMITS = { wallMs: 1500, maxOldGenerationSizeMb: 32 } as const;

const chromiumPdf = readFileSync(new URL("../../../tests/support/fixtures/chromium-synthetic.pdf", import.meta.url));
const qpdfObjectStreamPdf = readFileSync(new URL("../../../tests/support/fixtures/qpdf-object-stream.pdf", import.meta.url));
const qpdfIncrementalPdf = readFileSync(new URL("../../../tests/support/fixtures/qpdf-incremental-3.pdf", import.meta.url));
const qpdfCompressedObjectStreamPdf = readFileSync(new URL("../../../tests/support/fixtures/qpdf-compress-objstm-xref.pdf", import.meta.url));

/** A cross-reference stream object that declares two million entries but holds none. */
function hugeXrefStreamObject(objectNumber: number): string {
  return `${objectNumber} 0 obj << /Type /XRef /W [0 0 0] /Index [0 2000000] /Size 5 /Length 0 >>\nstream\n\nendstream\nendobj\n`;
}

function hostilePdf(separator: string, tail: string): Buffer {
  return Buffer.from(`%PDF-1.7\n${separator}${hugeXrefStreamObject(1)}${tail}`, "latin1");
}

/** startxref written with a leading plus sign, which the cheap pre-parse scan does not read as a number. */
function hostilePdfWithSignedStartxref(): Buffer {
  const head = "%PDF-1.7\n2 0 obj\n<< /Type /Catalog >>\nendobj\n\f";
  const objectFourOffset = Buffer.byteLength(head, "latin1");
  return Buffer.from(
    `${head}${hugeXrefStreamObject(4)}startxref\n+${objectFourOffset}\n%%EOF`,
    "latin1",
  );
}

describe("the PDF structure sandbox", () => {
  beforeEach(() => {
    setPdfStructureSandboxLimitsForTests({ ...TEST_LIMITS });
  });

  afterEach(() => {
    setPdfStructureSandboxLimitsForTests(undefined);
    setPdfStructureInspectorForTests(undefined);
  });

  it("publishes the agreed limits", () => {
    expect(PDF_STRUCTURE_SANDBOX_LIMITS).toMatchObject({
      wallMs: 5000,
      maxOldGenerationSizeMb: 128,
      maxYoungGenerationSizeMb: 16,
      stackSizeMb: 4,
      concurrency: 2,
    });
  });

  describe("hostile files that get past the cheap pre-parse check", () => {
    it.each([
      ["a form feed before the object and a bare %%EOF", () => hostilePdf("\f", "%%EOF")],
      ["a NUL byte before the object and a bare %%EOF", () => hostilePdf("\0", "%%EOF")],
      ["a form feed before the object and a startxref that is not a number", () => hostilePdf("\f", "startxref\nabc\n%%EOF")],
      ["a signed startxref pointing at a form-feed-prefixed object", hostilePdfWithSignedStartxref],
    ])("refuses %s as unsupported_structure while this thread keeps running", async (_name, build) => {
      const bytes = build();
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
      }, 10);
      const started = Date.now();

      let result: string;
      try {
        result = await classifyDocumentStructure(bytes, "application/pdf");
      } finally {
        clearInterval(timer);
      }
      const elapsedMs = Date.now() - started;

      expect(result).toBe("unsupported_structure");
      expect(elapsedMs).toBeLessThan(3000);
      // A blocked main thread would manage a handful of ticks, not most of them.
      expect(ticks).toBeGreaterThanOrEqual(Math.floor(elapsedMs / 10) * 0.6);
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    }, TEST_TIMEOUT_MS);
  });

  it("refuses a legitimate file as unsupported_structure when the wall-clock limit is 1 ms, and frees the worker", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      setPdfStructureSandboxLimitsForTests({ ...TEST_LIMITS, wallMs: 1 });

      await expect(inspectPdfStructureInSandbox(syntheticPdf())).resolves.toBe("unsupported_structure");
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);

      // Give any stray rejection from the killed worker a chance to surface.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, TEST_TIMEOUT_MS);

  it("refuses as unsupported_structure, quickly, when the worker cannot load the parser and crashes", async () => {
    // A long wall limit, so a fast answer can only come from handling the crash,
    // not from the timeout.
    setPdfStructureSandboxLimitsForTests({
      ...TEST_LIMITS,
      wallMs: 8000,
      pdfjsUrl: pathToFileURL(join(tmpdir(), "orbit-missing-pdfjs-module.mjs")).href,
    });
    const started = Date.now();

    await expect(inspectPdfStructureInSandbox(syntheticPdf())).resolves.toBe("unsupported_structure");

    expect(Date.now() - started).toBeLessThan(2000);
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("runs at most two checks at once, and answers all of six", async () => {
    // Waiting in the queue must not count against a check's own limit.
    setPdfStructureSandboxLimitsForTests({ ...TEST_LIMITS, wallMs: 8000 });
    let highest = 0;
    const sampler = setInterval(() => {
      highest = Math.max(highest, pdfStructureSandboxInFlightForTests());
    }, 5);

    let results: string[];
    try {
      results = await Promise.all(
        Array.from({ length: 6 }, () => classifyDocumentStructure(syntheticPdf(), "application/pdf")),
      );
    } finally {
      clearInterval(sampler);
    }

    expect(results).toEqual(Array(6).fill("supported_structure"));
    expect(highest).toBeGreaterThanOrEqual(1);
    expect(highest).toBeLessThanOrEqual(2);
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
  }, TEST_TIMEOUT_MS);

  // These use the real default limits: the 32 MB test cap is meant for the
  // hostile files above, and a 1000-page document or a producer-made file may
  // need more than that to parse.
  describe("legitimate files get the answers they always did", () => {
    beforeEach(() => {
      setPdfStructureSandboxLimitsForTests(undefined);
    });

    it.each([
      ["a plain synthetic PDF", syntheticPdf()],
      ["a synthetic PDF with a cross-reference stream", syntheticPdfWithXrefStream()],
      ["a Chromium PDF", chromiumPdf],
      ["qpdf object and xref streams", qpdfObjectStreamPdf],
      ["a qpdf incremental update", qpdfIncrementalPdf],
      ["qpdf compressed object streams", qpdfCompressedObjectStreamPdf],
      ["an owner-password-only PDF", syntheticOwnerPasswordPdf()],
      ["a PDF with exactly 1000 pages", syntheticPdfWithPages(1000)],
    ] as const)("accepts %s", async (_name, bytes) => {
      await expect(classifyDocumentStructure(bytes, "application/pdf")).resolves.toBe("supported_structure");
    }, TEST_TIMEOUT_MS);

    it.each(syntheticStructurePdfFixtures)("accepts synthetic standards-valid PDF structure from $name", async ({ bytes }) => {
      await expect(classifyDocumentStructure(bytes, "application/pdf")).resolves.toBe("supported_structure");
    }, TEST_TIMEOUT_MS);

    it("refuses a PDF with 1001 pages as unsupported_structure", async () => {
      await expect(classifyDocumentStructure(syntheticPdfWithPages(1001), "application/pdf"))
        .resolves.toBe("unsupported_structure");
    }, TEST_TIMEOUT_MS);

    it("asks for a password when the user password is set", async () => {
      await expect(classifyDocumentStructure(syntheticUserPasswordPdf(), "application/pdf"))
        .resolves.toBe("password_required");
    }, TEST_TIMEOUT_MS);

    it("leaves no worker running afterwards", async () => {
      await classifyDocumentStructure(syntheticPdf(), "application/pdf");
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    }, TEST_TIMEOUT_MS);
  });
});
