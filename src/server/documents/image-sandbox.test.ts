import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Records the FileHandles the sandbox opens on a given path, as
// pdf-structure-sandbox-file.test.ts does, so a test can look at the very
// descriptor the server held. Everything else passes through.
const opened = vi.hoisted(() => ({ watch: undefined as string | undefined, handles: [] as Array<{ fd: number; handle: { fd: number } }> }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (opened.watch !== undefined && String(args[0]) === opened.watch) opened.handles.push({ fd: handle.fd, handle });
      return handle;
    }),
  };
});

import { syntheticJpeg, syntheticPdf, syntheticPng } from "../../../tests/support/synthetic-documents";
import {
  AT_CAP_EDGE,
  paddedImage,
  progressive40Mpx,
  solidRaster,
  writePaddedImageFile,
} from "../../../tests/support/image-fixtures";
import { largeFixtureDirectory, removeFixtureDirectory, writeFixtureFile } from "../../../tests/support/large-pdf";
import {
  expectChildGone,
  MB,
  peakRssGrowth,
  setSandboxLimits,
  withCapturedLogs,
  withLogRecords,
} from "../../../tests/support/sandbox-test-helpers";
import {
  inspectImageInSandbox,
  lastPdfSandboxChildPidForTests,
  pdfStructureSandboxInFlightForTests,
  renderImageInSandbox,
} from "./pdf-structure-sandbox";
import { classifyDocumentStructure, declaredImageDimensionsWithinCap } from "./validation";

/**
 * #1572 (ADR-0033 pattern G, ADR-0038): the image decoder runs in the sandbox
 * child, under the render job's memory ceiling, never in the server's process.
 * These tests use the real canvas backend and the real child, as
 * pdf-structure-sandbox.test.ts does for PDFs.
 */

const TEST_TIMEOUT_MS = 30_000;
const SIZE_LIMIT = 50 * MB;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

let directory: string;
let progressive: Buffer;
let baselineJpeg: Buffer;
let baselinePng: Buffer;
/** File URL of a canvas module whose load throws, standing in for an addon that cannot load (the `canvasUrl` seam). */
let throwingCanvasUrl: string;
const files = new Map<string, { path: string; sizeBytes: number }>();

function stash(name: string, bytes: Buffer): void {
  files.set(name, { path: writeFixtureFile(directory, name, bytes), sizeBytes: bytes.length });
}

function fileOf(name: string): { path: string; sizeBytes: number } {
  const entry = files.get(name);
  if (!entry) throw new Error(`no fixture file ${name}`);
  return entry;
}

function pngWithDeclaredSize(width: number, height: number): Buffer {
  const bytes = Buffer.from(syntheticPng());
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpegWithDeclaredSize(width: number, height: number): Buffer {
  const bytes = Buffer.from(syntheticJpeg());
  const frame = bytes.indexOf(Buffer.from([0xff, 0xc0]));
  bytes.writeUInt16BE(height, frame + 5);
  bytes.writeUInt16BE(width, frame + 7);
  return bytes;
}

beforeAll(async () => {
  directory = largeFixtureDirectory();
  progressive = progressive40Mpx();
  baselineJpeg = solidRaster("image/jpeg", AT_CAP_EDGE, AT_CAP_EDGE);
  baselinePng = solidRaster("image/png", AT_CAP_EDGE, AT_CAP_EDGE);
  throwingCanvasUrl = pathToFileURL(writeFixtureFile(directory, "throwing-canvas.mjs", Buffer.from('throw new Error("no addon");\n'))).href;
  stash("small.jpg", syntheticJpeg());
  stash("small.png", syntheticPng());
  stash("progressive.jpg", progressive);
  const padded = join(directory, "progressive-padded.jpg");
  await writePaddedImageFile(padded, progressive, SIZE_LIMIT);
  files.set("progressive-padded.jpg", { path: padded, sizeBytes: SIZE_LIMIT });
}, 120_000);

afterAll(() => {
  removeFixtureDirectory(directory);
});

afterEach(() => {
  setSandboxLimits(undefined);
  opened.watch = undefined;
  opened.handles.length = 0;
  vi.restoreAllMocks();
});

describe("the fixtures are what the tests below say they are", () => {
  it("has a progressive JPEG at the pixel cap that is small on the wire", () => {
    expect(progressive.subarray(0, 3)).toEqual(JPEG_SIGNATURE);
    // SOF2 (progressive DCT), not SOF0 (baseline).
    expect(progressive.indexOf(Buffer.from([0xff, 0xc2]))).toBeGreaterThan(0);
    expect(progressive.indexOf(Buffer.from([0xff, 0xc0]))).toBe(-1);
    const frame = progressive.indexOf(Buffer.from([0xff, 0xc2]));
    expect({ width: progressive.readUInt16BE(frame + 7), height: progressive.readUInt16BE(frame + 5) })
      .toEqual({ width: AT_CAP_EDGE, height: AT_CAP_EDGE });
    expect(progressive.length).toBeLessThan(0.3 * MB);
  });
});

describe("the header fence's dimensions (declaredImageDimensionsWithinCap)", () => {
  it.each([
    ["the progressive fixture", () => progressive, "image/jpeg", { width: 6_324, height: 6_324 }],
    ["a baseline JPEG at the cap", () => baselineJpeg, "image/jpeg", { width: 6_324, height: 6_324 }],
    ["a PNG at the cap", () => baselinePng, "image/png", { width: 6_324, height: 6_324 }],
    ["a 1x1 JPEG", () => syntheticJpeg(), "image/jpeg", { width: 1, height: 1 }],
    ["a 1x1 PNG", () => syntheticPng(), "image/png", { width: 1, height: 1 }],
  ] as const)("reads %s", (_name, build, mediaType, expected) => {
    expect(declaredImageDimensionsWithinCap(build(), mediaType)).toEqual(expected);
  });

  it.each([
    ["a PNG over the edge cap", pngWithDeclaredSize(20_001, 1), "image/png"],
    ["a PNG over the pixel cap", pngWithDeclaredSize(10_000, 10_000), "image/png"],
    ["a JPEG over the pixel cap", jpegWithDeclaredSize(10_000, 10_000), "image/jpeg"],
    ["a PNG declaring no pixels", pngWithDeclaredSize(0, 1), "image/png"],
    ["bytes with no header", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
  ] as const)("answers undefined for %s", (_name, bytes, mediaType) => {
    expect(declaredImageDimensionsWithinCap(bytes, mediaType)).toBeUndefined();
  });
});

describe("the open check decodes in the sandbox child (#1572)", () => {
  describe("legitimate images are accepted, by a child, leaving none behind", () => {
    it.each([
      ["the progressive 40 Mpx JPEG", () => progressive, "image/jpeg"],
      ["a baseline 40 Mpx JPEG", () => baselineJpeg, "image/jpeg"],
      ["a 40 Mpx PNG", () => baselinePng, "image/png"],
    ] as const)("accepts %s through classifyDocumentStructure", async (_name, build, mediaType) => {
      // The check's own 5 s clock is sized for an idle host; this test is about the answer and the child.
      setSandboxLimits({ wallMs: 30_000 });
      const before = lastPdfSandboxChildPidForTests();

      const captured = await withCapturedLogs(() => classifyDocumentStructure(build(), mediaType));

      expect(captured.result).toBe("supported_structure");
      expect(lastPdfSandboxChildPidForTests(), "the decode ran in a child").not.toBe(before);
      expect(captured.logged).not.toMatch(/crash/i);
      expect(captured.logged).not.toMatch(/timeout|timed.?out/i);
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
      await expectChildGone(before);
    }, TEST_TIMEOUT_MS);

    it.each([
      ["a 1x1 JPEG", () => syntheticJpeg(), "image/jpeg"],
      ["a 1x1 PNG", () => syntheticPng(), "image/png"],
    ] as const)("accepts %s padded to the size limit, which the child holds once under 768 MiB plus the file", async (_name, build, mediaType) => {
      const bytes = paddedImage(build(), SIZE_LIMIT);
      const before = lastPdfSandboxChildPidForTests();

      await expect(classifyDocumentStructure(bytes, mediaType)).resolves.toBe("supported_structure");

      expect(lastPdfSandboxChildPidForTests(), "the decode ran in a child").not.toBe(before);
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    }, TEST_TIMEOUT_MS);
  });

  describe("a refusal from the header never starts a child (the cheap first fence)", () => {
    it.each([
      ["a PNG over the edge cap", pngWithDeclaredSize(20_001, 1), "image/png"],
      ["a PNG over the pixel cap", pngWithDeclaredSize(10_000, 10_000), "image/png"],
      ["a JPEG over the pixel cap", jpegWithDeclaredSize(10_000, 10_000), "image/jpeg"],
      ["a PNG declaring no pixels", pngWithDeclaredSize(0, 1), "image/png"],
    ] as const)("refuses %s", async (_name, bytes, mediaType) => {
      const before = lastPdfSandboxChildPidForTests();

      await expect(classifyDocumentStructure(bytes, mediaType)).resolves.toBe("unsupported_structure");

      expect(lastPdfSandboxChildPidForTests(), "no child was started").toBe(before);
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    });
  });

  describe("an image the decoder cannot read, or that the header misdescribes, is refused", () => {
    it("refuses a PNG cut short after its header, by a child that failed to decode it, without a crash record", async () => {
      const cutShort = Buffer.concat([syntheticPng().subarray(0, 24), Buffer.from([0, 0, 0, 0])]);
      const before = lastPdfSandboxChildPidForTests();

      const captured = await withCapturedLogs(() => classifyDocumentStructure(cutShort, "image/png"));

      expect(captured.result).toBe("unsupported_structure");
      expect(lastPdfSandboxChildPidForTests(), "the decode was tried in a child").not.toBe(before);
      expect(captured.logged).not.toMatch(/crash/i);
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
      await expectChildGone(before);
    }, TEST_TIMEOUT_MS);

    // The decoder accepts a truncated JPEG, as it did in the server before
    // #1572; the note refuses no new category of photo, so it stays accepted.
    it("decodes a truncated progressive JPEG whose header is within the cap in a child, accepted as before", async () => {
      setSandboxLimits({ wallMs: 30_000 });
      const truncated = progressive.subarray(0, 2_000);
      const before = lastPdfSandboxChildPidForTests();

      await expect(classifyDocumentStructure(truncated, "image/jpeg")).resolves.toBe("supported_structure");

      expect(lastPdfSandboxChildPidForTests(), "the decode was tried in a child").not.toBe(before);
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    }, TEST_TIMEOUT_MS);

    it("keeps a mismatch between the header's size and the decoded size as unsupported_structure", async () => {
      const real = syntheticJpeg();
      await expect(inspectImageInSandbox(real, "image/jpeg", { width: 1, height: 1 })).resolves.toBe("supported_structure");
      await expect(inspectImageInSandbox(real, "image/jpeg", { width: 2, height: 1 })).resolves.toBe("unsupported_structure");
      await expect(inspectImageInSandbox(real, "image/jpeg", { width: 1, height: 2 })).resolves.toBe("unsupported_structure");
      const png = syntheticPng();
      await expect(inspectImageInSandbox(png, "image/png", { width: 1, height: 1 })).resolves.toBe("supported_structure");
      await expect(inspectImageInSandbox(png, "image/png", { width: 3, height: 3 })).resolves.toBe("unsupported_structure");
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    }, TEST_TIMEOUT_MS);

    it("answers unsupported_structure for bytes that are not an image at all", async () => {
      await expect(inspectImageInSandbox(Buffer.from("not an image at all"), "image/png", { width: 1, height: 1 }))
        .resolves.toBe("unsupported_structure");
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    }, TEST_TIMEOUT_MS);
  });

  describe("the render job's ceiling and the check's clock bound the decode", () => {
    it("answers structure_check_unavailable for the progressive fixture at a 64 MiB ceiling, still saying memory under document.inspection", async () => {
      setSandboxLimits({ wallMs: 60_000, renderMemoryMb: 64 });
      const before = lastPdfSandboxChildPidForTests();

      const captured = await withCapturedLogs(() => classifyDocumentStructure(progressive, "image/jpeg"));

      expect(captured.result).toBe("structure_check_unavailable");
      expect(captured.calls).toBeGreaterThan(0);
      expect(captured.logged).toMatch(/memory/i);
      expect(captured.logged).toContain("document.inspection");
      expect(captured.logged).not.toContain("document.preview");
      expect(captured.logged).not.toMatch(/timeout|timed.?out/i);
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
      await expectChildGone(before);
    }, TEST_TIMEOUT_MS);

    it("keeps the decoded pixels out of the server: the stopped decode does not grow this process by 100 MiB", async () => {
      setSandboxLimits({ wallMs: 60_000, renderMemoryMb: 64 });
      // The child's code and the backend's first load are not the decode.
      await classifyDocumentStructure(syntheticJpeg(), "image/jpeg");

      const { result, growthBytes } = await peakRssGrowth(() => classifyDocumentStructure(progressive, "image/jpeg"));

      expect(result).toBe("structure_check_unavailable");
      expect(growthBytes).toBeLessThan(100 * MB);
    }, TEST_TIMEOUT_MS);

    it("answers structure_check_unavailable for the progressive fixture, without a crash record, when the wall clock is 1 ms, and frees the slot", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        setSandboxLimits({ wallMs: 1 });
        const before = lastPdfSandboxChildPidForTests();

        const captured = await withCapturedLogs(() => classifyDocumentStructure(progressive, "image/jpeg"));

        expect(captured.result).toBe("structure_check_unavailable");
        expect(lastPdfSandboxChildPidForTests(), "the decode ran in a child").not.toBe(before);
        expect(captured.logged).not.toMatch(/crash/i);
        expect(pdfStructureSandboxInFlightForTests()).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(unhandled).toEqual([]);
        await expectChildGone(before);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    }, TEST_TIMEOUT_MS);
  });

  describe("images share the sandbox's two slots with PDFs", () => {
    it("runs images through the slots: at most two at once across six, and at least one at a time", async () => {
      setSandboxLimits({ wallMs: 8_000 });
      let highest = 0;
      const sampler = setInterval(() => {
        highest = Math.max(highest, pdfStructureSandboxInFlightForTests());
      }, 5);
      const jpeg = syntheticJpeg();

      let results: string[];
      try {
        results = await Promise.all(Array.from({ length: 6 }, () => classifyDocumentStructure(jpeg, "image/jpeg")));
      } finally {
        clearInterval(sampler);
      }

      expect(results).toEqual(Array(6).fill("supported_structure"));
      expect(highest, "image jobs are children counted by the sandbox").toBeGreaterThanOrEqual(1);
      expect(highest).toBeLessThanOrEqual(2);
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    }, TEST_TIMEOUT_MS);

    it("runs at most two jobs at once across six images and three PDFs, and answers all nine", async () => {
      setSandboxLimits({ wallMs: 8_000 });
      let highest = 0;
      const sampler = setInterval(() => {
        highest = Math.max(highest, pdfStructureSandboxInFlightForTests());
      }, 5);
      const jpeg = syntheticJpeg();
      const png = syntheticPng();

      let results: string[];
      try {
        results = await Promise.all([
          ...Array.from({ length: 3 }, () => classifyDocumentStructure(jpeg, "image/jpeg")),
          ...Array.from({ length: 3 }, () => classifyDocumentStructure(png, "image/png")),
          ...Array.from({ length: 3 }, () => classifyDocumentStructure(syntheticPdf(), "application/pdf")),
        ]);
      } finally {
        clearInterval(sampler);
      }

      expect(results).toEqual(Array(9).fill("supported_structure"));
      expect(highest).toBeGreaterThanOrEqual(1);
      expect(highest).toBeLessThanOrEqual(2);
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    }, TEST_TIMEOUT_MS);
  });
});

describe("the image check given a file (#1567 pattern, #1572)", () => {
  it("accepts an image upload through classifyDocumentStructure with the quarantine file, by a child", async () => {
    setSandboxLimits({ wallMs: 30_000 });
    const file = fileOf("progressive.jpg");
    const before = lastPdfSandboxChildPidForTests();

    await expect(classifyDocumentStructure(readFileSync(file.path), "image/jpeg", file)).resolves.toBe("supported_structure");

    expect(lastPdfSandboxChildPidForTests(), "the decode ran in a child").not.toBe(before);
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("reads the file, not the bytes it is also given", async () => {
    const real = readFileSync(fileOf("small.jpg").path);
    await expect(inspectImageInSandbox(Buffer.alloc(0), "image/jpeg", { width: 1, height: 1 }, fileOf("small.jpg")))
      .resolves.toBe("supported_structure");

    const garbage = Buffer.alloc(real.length, 0x41);
    const garbagePath = writeFixtureFile(directory, "garbage-same-size.bin", garbage);
    await expect(inspectImageInSandbox(real, "image/jpeg", { width: 1, height: 1 }, { path: garbagePath, sizeBytes: garbage.length }))
      .resolves.toBe("unsupported_structure");
  }, TEST_TIMEOUT_MS);

  it.each([
    ["larger", 1],
    ["smaller", -1],
  ] as const)("answers structure_check_unavailable (the child could not open its input), and the child is gone, when the stated size is %s than the file", async (_which, delta) => {
    const small = fileOf("small.jpg");
    const before = lastPdfSandboxChildPidForTests();

    await expect(inspectImageInSandbox(readFileSync(small.path), "image/jpeg", { width: 1, height: 1 }, { path: small.path, sizeBytes: small.sizeBytes + delta }))
      .resolves.toBe("structure_check_unavailable");

    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    await expectChildGone(before);
  }, TEST_TIMEOUT_MS);

  it("holds no copy of a 50 MiB file in the server: the progressive fixture padded to the limit is checked by descriptor without this process's RSS growing by 32 MiB", async () => {
    const file = fileOf("progressive-padded.jpg");
    // Warm up: the child's code and the backend's first load are not the hand-over.
    await expect(inspectImageInSandbox(Buffer.alloc(0), "image/jpeg", { width: 1, height: 1 }, fileOf("small.jpg")))
      .resolves.toBe("supported_structure");
    setSandboxLimits({ wallMs: 60_000 });

    const { result, growthBytes } = await peakRssGrowth(() =>
      inspectImageInSandbox(Buffer.alloc(0), "image/jpeg", { width: AT_CAP_EDGE, height: AT_CAP_EDGE }, file));

    expect(result).toBe("supported_structure");
    expect(growthBytes).toBeLessThan(32 * MB);
  }, 90_000);

  it("closes the server's descriptor, and leaves the same number of descriptors open before and after a check", async () => {
    setSandboxLimits({ wallMs: 30_000 });
    const small = fileOf("small.png");
    const count = (): number => readdirSync("/proc/self/fd").length;
    // The child's pipes close after the child exits, which can be after the job's answer.
    const settledCount = async (pidBefore: number | undefined): Promise<number> => {
      await expectChildGone(pidBefore);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return count();
    };
    const first = lastPdfSandboxChildPidForTests();
    await inspectImageInSandbox(Buffer.alloc(0), "image/png", { width: 1, height: 1 }, small);
    await settledCount(first);

    opened.watch = small.path;
    const pidBefore = lastPdfSandboxChildPidForTests();
    const before = count();
    await expect(inspectImageInSandbox(Buffer.alloc(0), "image/png", { width: 1, height: 1 }, small)).resolves.toBe("supported_structure");

    expect(opened.handles, "the sandbox opened one FileHandle on the file").toHaveLength(1);
    expect(opened.handles[0]!.handle.fd, "the server closed its handle").toBe(-1);
    expect(await settledCount(pidBefore)).toBe(before);
    const links = readdirSync("/proc/self/fd").map((entry) => {
      try { return readlinkSync(join("/proc/self/fd", entry)); } catch { return ""; }
    });
    expect(links, "no descriptor on the file is left open in the server").not.toContain(small.path);
  }, TEST_TIMEOUT_MS);
});

describe("renderImageInSandbox: one child draws the bounded preview after the gate (#1572)", () => {
  it("draws a JPEG as a JPEG at the size asked for, in one child", async () => {
    const bytes = solidRaster("image/jpeg", 1_600, 2_000);
    const before = lastPdfSandboxChildPidForTests();

    const rendered = await renderImageInSandbox(bytes, {
      mediaType: "image/jpeg",
      declared: { width: 1_600, height: 2_000 },
      width: 960,
      height: 1_200,
      wallMs: 20_000,
    });

    expect(rendered.outcome).toBe("drawn");
    if (rendered.outcome !== "drawn") return;
    expect(rendered).toMatchObject({ width: 960, height: 1_200 });
    expect(rendered.bytes.subarray(0, 3)).toEqual(JPEG_SIGNATURE);
    expect(lastPdfSandboxChildPidForTests(), "the draw ran in a child").not.toBe(before);
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    await expectChildGone(before);
  }, TEST_TIMEOUT_MS);

  it("draws a PNG as a PNG at the size asked for", async () => {
    const bytes = solidRaster("image/png", 2_400, 1_200);

    const rendered = await renderImageInSandbox(bytes, {
      mediaType: "image/png",
      declared: { width: 2_400, height: 1_200 },
      width: 1_200,
      height: 600,
      wallMs: 20_000,
    });

    expect(rendered.outcome).toBe("drawn");
    if (rendered.outcome !== "drawn") return;
    expect(rendered).toMatchObject({ width: 1_200, height: 600 });
    expect(rendered.bytes.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(rendered.bytes.readUInt32BE(16)).toBe(1_200);
    expect(rendered.bytes.readUInt32BE(20)).toBe(600);
  }, TEST_TIMEOUT_MS);

  it("draws the progressive 40 Mpx JPEG down to the preview bound", async () => {
    const rendered = await renderImageInSandbox(progressive, {
      mediaType: "image/jpeg",
      declared: { width: AT_CAP_EDGE, height: AT_CAP_EDGE },
      width: 1_200,
      height: 1_200,
      wallMs: 30_000,
    });

    expect(rendered.outcome).toBe("drawn");
    if (rendered.outcome !== "drawn") return;
    expect(rendered).toMatchObject({ width: 1_200, height: 1_200 });
    expect(rendered.bytes.subarray(0, 3)).toEqual(JPEG_SIGNATURE);
  }, TEST_TIMEOUT_MS);

  it("answers refused, as upload would, when the declared size is not the decoded size", async () => {
    const rendered = await renderImageInSandbox(solidRaster("image/png", 64, 48), {
      mediaType: "image/png",
      declared: { width: 65, height: 48 },
      width: 64,
      height: 48,
      wallMs: 20_000,
    });

    expect(rendered).toEqual({ outcome: "refused", reason: "unsupported_structure" });
  }, TEST_TIMEOUT_MS);

  it("answers failed, with no stop, for bytes the decoder cannot read", async () => {
    const cutShort = Buffer.concat([syntheticPng().subarray(0, 24), Buffer.from([0, 0, 0, 0])]);

    const rendered = await renderImageInSandbox(cutShort, {
      mediaType: "image/png",
      declared: { width: 1, height: 1 },
      width: 1,
      height: 1,
      wallMs: 20_000,
    });

    expect(rendered).toEqual({ outcome: "failed" });
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("answers failed on memory at a 64 MiB ceiling, saying memory under document.preview, and leaves no child", async () => {
    setSandboxLimits({ wallMs: 60_000, renderMemoryMb: 64 });
    const before = lastPdfSandboxChildPidForTests();

    const captured = await withCapturedLogs(() => renderImageInSandbox(progressive, {
      mediaType: "image/jpeg",
      declared: { width: AT_CAP_EDGE, height: AT_CAP_EDGE },
      width: 1_200,
      height: 1_200,
      wallMs: 60_000,
    }));

    expect(captured.result).toEqual({ outcome: "failed", stop: "memory" });
    expect(captured.logged).toMatch(/memory/i);
    expect(captured.logged).toContain("document.preview");
    expect(captured.logged).not.toContain("document.inspection");
    expect(captured.logged).not.toMatch(/timeout|timed.?out/i);
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    await expectChildGone(before);
  }, TEST_TIMEOUT_MS);

  it("answers failed on the clock when the render budget is 1 ms", async () => {
    const rendered = await renderImageInSandbox(progressive, {
      mediaType: "image/jpeg",
      declared: { width: AT_CAP_EDGE, height: AT_CAP_EDGE },
      width: 1_200,
      height: 1_200,
      wallMs: 1,
    });

    expect(rendered).toEqual({ outcome: "failed", stop: "timeout" });
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
  }, TEST_TIMEOUT_MS);
});

describe("the image child loads the canvas backend before it says it is ready (D-Q1)", () => {
  it("answers structure_check_unavailable, quickly, with one crash warn under document.inspection, when the backend cannot load, and leaves no child", async () => {
    // A long clock, so a fast answer can only come from handling the crash, not from the timeout.
    setSandboxLimits({ wallMs: 8_000, canvasUrl: throwingCanvasUrl });
    const before = lastPdfSandboxChildPidForTests();
    const started = Date.now();

    const { result, records } = await withLogRecords(() => inspectImageInSandbox(syntheticJpeg(), "image/jpeg", { width: 1, height: 1 }));

    expect(result).toBe("structure_check_unavailable");
    expect(Date.now() - started, "the crash is handled, not the clock").toBeLessThan(2_000);
    const warns = records.filter((record) => record.level === "warn" && record.fields.event === "document.inspection");
    expect(warns).toHaveLength(1);
    expect(String(warns[0]!.fields.detail)).toMatch(/crash/);
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    await expectChildGone(before);
  }, TEST_TIMEOUT_MS);

  it("answers a 1x1 render as failed with stop crash when the backend cannot load", async () => {
    setSandboxLimits({ wallMs: 8_000, canvasUrl: throwingCanvasUrl });

    const rendered = await renderImageInSandbox(syntheticJpeg(), {
      mediaType: "image/jpeg",
      declared: { width: 1, height: 1 },
      width: 1,
      height: 1,
      wallMs: 8_000,
    });

    expect(rendered).toEqual({ outcome: "failed", stop: "crash" });
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
  }, TEST_TIMEOUT_MS);
});

describe("a sandbox stop is no verdict; a decoder's refusal is one (D-S1)", () => {
  it("answers structure_check_unavailable, with a crash warn, when the backend cannot load, through classifyDocumentStructure", async () => {
    setSandboxLimits({ wallMs: 8_000, canvasUrl: throwingCanvasUrl });

    const { result, records } = await withLogRecords(() => classifyDocumentStructure(syntheticJpeg(), "image/jpeg"));

    expect(result).toBe("structure_check_unavailable");
    expect(records.some((record) => record.level === "warn" && /crash/.test(String(record.fields.detail)))).toBe(true);
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it.each([
    ["image/jpeg", "image/jpeg" as const],
    ["image/png", "image/png" as const],
  ])("answers structure_check_unavailable for a %s quarantine file that cannot be opened", async (_name, mediaType) => {
    const missing = { path: join(directory, `no-such-quarantine-file.${mediaType === "image/png" ? "png" : "jpg"}`), sizeBytes: 100 };

    // A real image header, so the header check passes and the sandbox is what runs
    // (an empty buffer is refused by the header check before any child starts).
    const header = mediaType === "image/png" ? syntheticPng() : syntheticJpeg();

    await expect(classifyDocumentStructure(header, mediaType, missing)).resolves.toBe("structure_check_unavailable");

    await expect(inspectImageInSandbox(header, mediaType, { width: 1, height: 1 }, missing)).resolves.toBe("structure_check_unavailable");
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("keeps a decoder's refusal a verdict: a PNG cut short, bytes that are not an image, and a size mismatch are unsupported_structure", async () => {
    const cutShort = Buffer.concat([syntheticPng().subarray(0, 24), Buffer.from([0, 0, 0, 0])]);
    await expect(classifyDocumentStructure(cutShort, "image/png")).resolves.toBe("unsupported_structure");
    await expect(inspectImageInSandbox(Buffer.from("not an image at all"), "image/png", { width: 1, height: 1 })).resolves.toBe("unsupported_structure");
    await expect(inspectImageInSandbox(syntheticJpeg(), "image/jpeg", { width: 2, height: 1 })).resolves.toBe("unsupported_structure");
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
  }, TEST_TIMEOUT_MS);
});

describe("the sandbox stop record names the job that stopped (D-F2, W-F1)", () => {
  const decodeMemoryStop = () => {
    setSandboxLimits({ wallMs: 60_000, renderMemoryMb: 64 });
    return withLogRecords(() => classifyDocumentStructure(progressive, "image/jpeg"));
  };

  it("says the image sandbox stopped the decode, and memory, and never PDF, for an image memory stop", async () => {
    const { records } = await decodeMemoryStop();

    const inspection = records.filter((record) => record.fields.event === "document.inspection");
    expect(inspection).toHaveLength(1);
    expect(String(inspection[0]!.fields.detail)).toContain("Image sandbox stopped the decode");
    expect(String(inspection[0]!.fields.detail)).toMatch(/memory/);
    expect(JSON.stringify(records)).not.toContain("PDF");
  }, TEST_TIMEOUT_MS);

  it("logs an image crash as a warn 'Image sandbox stopped the decode: crash' with action check_parser and impact document_upload_blocked", async () => {
    setSandboxLimits({ wallMs: 8_000, canvasUrl: throwingCanvasUrl });

    const { records } = await withLogRecords(() => inspectImageInSandbox(syntheticJpeg(), "image/jpeg", { width: 1, height: 1 }));

    const warns = records.filter((record) => record.level === "warn" && record.fields.event === "document.inspection");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.fields).toMatchObject({
      detail: "Image sandbox stopped the decode: crash",
      action: "check_parser",
      impact: "document_upload_blocked",
    });
  }, TEST_TIMEOUT_MS);

  it("says the image sandbox stopped the preview, under document.preview, for an image render memory stop", async () => {
    setSandboxLimits({ wallMs: 60_000, renderMemoryMb: 64 });

    const { result, records } = await withLogRecords(() => renderImageInSandbox(progressive, {
      mediaType: "image/jpeg",
      declared: { width: AT_CAP_EDGE, height: AT_CAP_EDGE },
      width: 1_200,
      height: 1_200,
      wallMs: 60_000,
    }));

    expect(result).toEqual({ outcome: "failed", stop: "memory" });
    const preview = records.filter((record) => record.fields.event === "document.preview");
    expect(preview).toHaveLength(1);
    expect(String(preview[0]!.fields.detail)).toContain("Image sandbox stopped the preview");
  }, TEST_TIMEOUT_MS);

  it("keeps the render-body record's reason, action and impact for an image render memory stop (guard)", async () => {
    setSandboxLimits({ wallMs: 60_000, renderMemoryMb: 64 });

    const { records } = await withLogRecords(() => renderImageInSandbox(progressive, {
      mediaType: "image/jpeg",
      declared: { width: AT_CAP_EDGE, height: AT_CAP_EDGE },
      width: 1_200,
      height: 1_200,
      wallMs: 60_000,
    }));

    const preview = records.filter((record) => record.fields.event === "document.preview");
    expect(preview).toHaveLength(1);
    expect(preview[0]!.fields).toMatchObject({ state: "blocked", reason: "unsupported_structure", action: "none", impact: "none" });
  }, TEST_TIMEOUT_MS);

  it("says it could not open the file to check, with the error code, as processing_interrupted, and not a crash, for an image file that does not exist", async () => {
    const missing = { path: join(directory, "no-such-quarantine-image.jpg"), sizeBytes: 100 };

    const { records } = await withLogRecords(() => classifyDocumentStructure(syntheticJpeg(), "image/jpeg", missing));

    const inspection = records.filter((record) => record.fields.event === "document.inspection");
    expect(inspection).toHaveLength(1);
    expect(inspection[0]!.level).toBe("warn");
    expect(String(inspection[0]!.fields.detail)).toContain("could not open the file to check");
    expect(String(inspection[0]!.fields.detail)).toContain("ENOENT");
    expect(inspection[0]!.fields).toMatchObject({ reason: "processing_interrupted", action: "inspect_admin_diagnostics" });
    expect(JSON.stringify(records)).not.toMatch(/crash/i);
  }, TEST_TIMEOUT_MS);

  it.each([
    ["a memory stop", () => ({ wallMs: 60_000, renderMemoryMb: 64 })],
    ["a timeout", () => ({ wallMs: 1 })],
    ["a crash", () => ({ wallMs: 8_000, canvasUrl: throwingCanvasUrl })],
  ] as const)("records %s of the check with reason processing_interrupted, not unsupported_structure", async (_name, limitsFor) => {
    setSandboxLimits(limitsFor());

    const { records } = await withLogRecords(() => classifyDocumentStructure(progressive, "image/jpeg"));

    const inspection = records.filter((record) => record.fields.event === "document.inspection");
    expect(inspection.length).toBeGreaterThanOrEqual(1);
    for (const record of inspection) expect(record.fields.reason).toBe("processing_interrupted");
  }, TEST_TIMEOUT_MS);
});
