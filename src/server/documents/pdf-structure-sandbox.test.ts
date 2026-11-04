import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  syntheticPdfWithPages,
  syntheticStructurePdfFixtures,
} from "../../../tests/support/generated-pdf-documents";
import { syntheticOwnerPasswordPdf, syntheticUserPasswordPdf } from "../../../tests/support/encrypted-pdf-documents";
import { syntheticPdf, syntheticPdfWithXrefStream } from "../../../tests/support/synthetic-documents";
import { hostilePdf, hostilePdfWithSignedStartxref, objectStreamBomb } from "../../../tests/support/pdf-budget-shapes";
import { paddedPdf } from "../../../tests/support/large-pdf";
import {
  expectChildGone,
  MB,
  peakRssGrowth,
  setSandboxLimits,
  withCapturedLogs,
  withLogRecords,
} from "../../../tests/support/sandbox-test-helpers";
import {
  inspectPdfStructureInSandbox,
  lastPdfSandboxChildPidForTests,
  PDF_STRUCTURE_SANDBOX_LIMITS,
  pdfSandboxSelfCheck,
  pdfStructureSandboxInFlightForTests,
  setPdfStructureInspectorForTests,
} from "./pdf-structure-sandbox";
import { classifyDocumentStructure } from "./validation";

/**
 * The PDF structure check runs in a memory-capped, killable worker thread
 * (#1316). These tests use the real parser and the real worker: a hostile file
 * must come back as "unsupported_structure" without stalling this thread, and
 * a legitimate file must get the same answer it always did.
 */

const TEST_TIMEOUT_MS = 10_000;
const TEST_LIMITS = { wallMs: 1500, heapMb: 32 } as const;

const chromiumPdf = readFileSync(new URL("../../../tests/support/fixtures/chromium-synthetic.pdf", import.meta.url));
const qpdfObjectStreamPdf = readFileSync(new URL("../../../tests/support/fixtures/qpdf-object-stream.pdf", import.meta.url));
const qpdfIncrementalPdf = readFileSync(new URL("../../../tests/support/fixtures/qpdf-incremental-3.pdf", import.meta.url));
const qpdfCompressedObjectStreamPdf = readFileSync(new URL("../../../tests/support/fixtures/qpdf-compress-objstm-xref.pdf", import.meta.url));

/**
 * A stand-in parser module (as in the environment canary below) that reads
 * its own process's CPU-time limit and refuses to parse unless the soft limit
 * is exactly `expectedSeconds`, so the job answers normally only when the
 * child has the backstop the limits call for.
 */
function cpuLimitCheckingPdfjsModule(expectedSeconds: number): string {
  return `
import { readFileSync } from "node:fs";
function cpuTimeSoftLimit() {
  const line = readFileSync("/proc/self/limits", "utf8").split("\\n").find((entry) => entry.startsWith("Max cpu time"));
  const match = line && /^Max cpu time\\s+(\\S+)\\s+(\\S+)/.exec(line);
  return match ? match[1] : "missing";
}
function getDocument() {
  const soft = cpuTimeSoftLimit();
  if (soft !== ${JSON.stringify(String(expectedSeconds))}) {
    throw new Error("the child's CPU-time limit is " + soft + ", not ${expectedSeconds}");
  }
  const page = {
    getViewport: () => ({ width: 200, height: 200 }),
    cleanup: () => undefined,
    destroy: () => undefined,
  };
  const document = {
    numPages: 1,
    getPage: async () => page,
    getMetadata: async () => ({ info: {}, metadata: null }),
    cleanup: async () => undefined,
    destroy: async () => undefined,
  };
  return { promise: Promise.resolve(document), onPassword: undefined, destroy: async () => undefined };
}
export { getDocument };
export const GlobalWorkerOptions = {};
export default { getDocument, GlobalWorkerOptions };
`;
}

describe("the PDF structure sandbox", () => {
  beforeEach(() => {
    setSandboxLimits({ ...TEST_LIMITS });
  });

  afterEach(() => {
    setSandboxLimits(undefined);
    setPdfStructureInspectorForTests(undefined);
  });

  it("publishes the agreed limits", () => {
    expect(PDF_STRUCTURE_SANDBOX_LIMITS).toMatchObject({
      wallMs: 5000,
      startupMs: 5000,
      pollMs: 25,
      concurrency: 2,
      heapMb: 128,
      structureMemoryMb: 320,
      renderMemoryMb: 768,
    });
  });

  describe("hostile files that get past the cheap pre-parse check", () => {
    it.each([
      ["a form feed before the object and a bare %%EOF", () => hostilePdf("\f", "%%EOF")],
      ["a NUL byte before the object and a bare %%EOF", () => hostilePdf("\0", "%%EOF")],
      ["a form feed before the object and a startxref that is not a number", () => hostilePdf("\f", "startxref\nabc\n%%EOF")],
      ["a signed startxref pointing at a form-feed-prefixed object", hostilePdfWithSignedStartxref],
    ])("stops on %s and answers structure_check_unavailable, never supported_structure, while this thread keeps running", async (_name, build) => {
      const bytes = build();
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
      }, 10);
      const started = Date.now();

      let captured: Awaited<ReturnType<typeof withCapturedLogs<string>>>;
      try {
        captured = await withCapturedLogs(() => classifyDocumentStructure(bytes, "application/pdf"));
      } finally {
        clearInterval(timer);
      }
      const elapsedMs = Date.now() - started;

      // The child is stopped on memory every time, which is no verdict (D-S1): the
      // file is neither accepted nor refused, and never reported as supported.
      expect(captured.result).not.toBe("supported_structure");
      expect(captured.result).toBe("structure_check_unavailable");
      expect(captured.calls).toBeGreaterThan(0);
      expect(captured.logged).toMatch(/memory/i);
      // No wall-clock bound: it failed at 3.2 s on a busy runner (docs/flakes.md).
      // The tick count below proves this thread kept running; the test timeout
      // catches a child that is never stopped.
      // A blocked main thread would manage a handful of ticks, not most of them.
      expect(ticks).toBeGreaterThanOrEqual(Math.floor(elapsedMs / 10) * 0.6);
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    }, TEST_TIMEOUT_MS);

    describe("memory the V8 heap cap cannot see or does not stop in time", () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });

      // The clock is 60 s, so a stop inside 10 s can only be memory or a crash,
      // and the log says which: safe on a loaded runner.
      it("stops an object-stream bomb on memory, not on the clock, without the process growing", async () => {
        setSandboxLimits({ wallMs: 60_000, structureMemoryMb: 192 });
        const bomb = objectStreamBomb(128);
        expect(bomb.length).toBeLessThan(1024 * 1024);
        const started = Date.now();

        const { result: captured, growthBytes } = await peakRssGrowth(() =>
          withCapturedLogs(() => classifyDocumentStructure(bomb, "application/pdf")));
        const elapsedMs = Date.now() - started;

        expect(captured.result).toBe("structure_check_unavailable");
        expect(elapsedMs).toBeLessThan(10_000);
        expect(captured.calls).toBeGreaterThan(0);
        expect(captured.logged).toMatch(/memory/i);
        expect(captured.logged).not.toMatch(/timeout|timed.?out/i);
        expect(growthBytes).toBeLessThan(150 * MB);
        expect(pdfStructureSandboxInFlightForTests()).toBe(0);
      }, 30_000);

      it("leaves no child process behind once an object-stream bomb is stopped", async () => {
        setSandboxLimits({ wallMs: 60_000, structureMemoryMb: 192 });
        const before = lastPdfSandboxChildPidForTests();

        await expect(classifyDocumentStructure(objectStreamBomb(128), "application/pdf")).resolves.toBe("structure_check_unavailable");

        await expectChildGone(before);
      }, 30_000);

      it("refuses two object-stream bombs at once without the process growing", async () => {
        setSandboxLimits({ wallMs: 60_000, structureMemoryMb: 192 });
        const bomb = objectStreamBomb(128);

        const { result, growthBytes } = await peakRssGrowth(() =>
          Promise.all([
            classifyDocumentStructure(bomb, "application/pdf"),
            classifyDocumentStructure(bomb, "application/pdf"),
          ]));

        expect(result).toEqual(["structure_check_unavailable", "structure_check_unavailable"]);
        expect(growthBytes).toBeLessThan(150 * MB);
        expect(pdfStructureSandboxInFlightForTests()).toBe(0);
      }, 30_000);

      it("stops a heap bomb on the heap cap, saying memory, not timeout", async () => {
        setSandboxLimits({ wallMs: 60_000, heapMb: 32 });
        const started = Date.now();

        const captured = await withCapturedLogs(() => classifyDocumentStructure(hostilePdf("\f", "%%EOF"), "application/pdf"));

        expect(captured.result).toBe("structure_check_unavailable");
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(captured.calls).toBeGreaterThan(0);
        expect(captured.logged).toMatch(/memory/i);
        expect(captured.logged).not.toMatch(/crash/i);
        expect(captured.logged).not.toMatch(/timeout|timed.?out/i);
        expect(pdfStructureSandboxInFlightForTests()).toBe(0);
      }, 30_000);
    });
  });

  it("does not count time spent waiting in the queue, or worker start-up, against a check's limit", async () => {
    setSandboxLimits({ ...TEST_LIMITS, concurrency: 1, wallMs: 1000 });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => classifyDocumentStructure(syntheticPdf(), "application/pdf")),
    );

    expect(results).toEqual(Array(6).fill("supported_structure"));
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
  }, 20_000);

  it("does not hand the worker this process's environment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orbit-sandbox-canary-"));
    const modulePath = join(directory, "fake-pdfjs.mjs");
    writeFileSync(modulePath, `
function getDocument() {
  if (process.env.ORBIT_SANDBOX_CANARY !== undefined) {
    throw new Error("the worker inherited the parent environment");
  }
  const page = {
    getViewport: () => ({ width: 200, height: 200 }),
    cleanup: () => undefined,
    destroy: () => undefined,
  };
  const document = {
    numPages: 1,
    getPage: async () => page,
    getMetadata: async () => ({ info: {}, metadata: null }),
    cleanup: async () => undefined,
    destroy: async () => undefined,
  };
  return { promise: Promise.resolve(document), onPassword: undefined, destroy: async () => undefined };
}
export { getDocument };
export const GlobalWorkerOptions = {};
export default { getDocument, GlobalWorkerOptions };
`);
    process.env.ORBIT_SANDBOX_CANARY = "must-not-reach-the-worker";
    try {
      setSandboxLimits({ ...TEST_LIMITS, wallMs: 5000, pdfjsUrl: pathToFileURL(modulePath).href });

      await expect(inspectPdfStructureInSandbox(syntheticPdf())).resolves.toBe("supported_structure");
    } finally {
      delete process.env.ORBIT_SANDBOX_CANARY;
      rmSync(directory, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it("answers structure_check_unavailable, not a verdict, for a legitimate file when the wall-clock limit is 1 ms, and frees the worker", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      setSandboxLimits({ ...TEST_LIMITS, wallMs: 1 });

      await expect(inspectPdfStructureInSandbox(syntheticPdf())).resolves.toBe("structure_check_unavailable");
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);

      // Give any stray rejection from the killed worker a chance to surface.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, TEST_TIMEOUT_MS);

  it("stops a worker that does not come online within the start-up deadline as a crash, and frees the slot", async () => {
    setSandboxLimits({ ...TEST_LIMITS, startupMs: 1 });

    const { result, logged } = await withCapturedLogs(() => classifyDocumentStructure(syntheticPdf(), "application/pdf"));

    expect(result).toBe("structure_check_unavailable");
    expect(logged).toMatch(/crash/i);
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("leaves no child process behind once a start-up stop is settled", async () => {
    setSandboxLimits({ ...TEST_LIMITS, startupMs: 1 });
    const before = lastPdfSandboxChildPidForTests();

    await expect(classifyDocumentStructure(syntheticPdf(), "application/pdf")).resolves.toBe("structure_check_unavailable");

    await expectChildGone(before);
  }, TEST_TIMEOUT_MS);

  // ceil((startupMs + wallMs) / 1000) + 5 seconds of CPU: a child orphaned by
  // a dead server still stops on its own.
  it.each([
    [{ wallMs: 60_000, startupMs: 5_000 }, 70],
    [{ wallMs: 5_000, startupMs: 5_000 }, 15],
  ] as const)("gives the child a CPU-time limit from its clocks (%o: %i s), and answers as normal under it", async (clocks, seconds) => {
    const directory = mkdtempSync(join(tmpdir(), "orbit-sandbox-cpu-limit-"));
    const modulePath = join(directory, "fake-pdfjs.mjs");
    writeFileSync(modulePath, cpuLimitCheckingPdfjsModule(seconds));
    try {
      setSandboxLimits({ ...TEST_LIMITS, ...clocks, pdfjsUrl: pathToFileURL(modulePath).href });

      await expect(inspectPdfStructureInSandbox(syntheticPdf())).resolves.toBe("supported_structure");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it("passes its own boot self-check on this host", async () => {
    await expect(pdfSandboxSelfCheck()).resolves.toBeUndefined();
  }, TEST_TIMEOUT_MS);

  it("answers structure_check_unavailable, quickly, when the worker cannot load the parser and crashes", async () => {
    // A long wall limit, so a fast answer can only come from handling the crash,
    // not from the timeout.
    setSandboxLimits({
      ...TEST_LIMITS,
      wallMs: 8000,
      pdfjsUrl: pathToFileURL(join(tmpdir(), "orbit-missing-pdfjs-module.mjs")).href,
    });
    const started = Date.now();

    await expect(inspectPdfStructureInSandbox(syntheticPdf())).resolves.toBe("structure_check_unavailable");

    expect(Date.now() - started).toBeLessThan(2000);
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("keeps a child's answer outside the known reasons as unsupported_structure: a child cannot claim structure_check_unavailable (D-S1)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orbit-unknown-answer-"));
    // A parser that opens every file, but whose child then reports a reason
    // nobody listed (including the one only the sandbox itself may give).
    const modulePath = join(directory, "lying-pdfjs.mjs");
    writeFileSync(modulePath, `
const send = process.send.bind(process);
process.send = (message, callback) => send(typeof message === "string" ? "structure_check_unavailable" : message, callback);
const page = { cleanup: () => undefined, destroy: () => undefined };
function getDocument() {
  const document = { numPages: 1, getPage: async () => page, cleanup: async () => undefined, destroy: async () => undefined };
  return { promise: Promise.resolve(document), onPassword: undefined, destroy: async () => undefined };
}
export { getDocument };
export const GlobalWorkerOptions = {};
export default { getDocument, GlobalWorkerOptions };
`);
    try {
      setSandboxLimits({ ...TEST_LIMITS, wallMs: 5000, pdfjsUrl: pathToFileURL(modulePath).href });

      const { result, records } = await withLogRecords(() => inspectPdfStructureInSandbox(syntheticPdf()));

      expect(result).toBe("unsupported_structure");
      // The child answered; it was not stopped, so this is a verdict, not a stop.
      expect(records.filter((record) => record.fields.event === "document.inspection")).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it("runs at most two checks at once, and answers all of six", async () => {
    // Waiting in the queue must not count against a check's own limit.
    setSandboxLimits({ ...TEST_LIMITS, wallMs: 8000 });
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
      setSandboxLimits(undefined);
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

    it("accepts a 20 MB PDF, because the memory allowance sits above the file itself", async () => {
      await expect(classifyDocumentStructure(paddedPdf(20 * MB), "application/pdf")).resolves.toBe("supported_structure");
    }, TEST_TIMEOUT_MS);

    it("accepts a 98 MB PDF within 5 s, under the default memory ceiling", async () => {
      const bytes = paddedPdf(98 * MB);
      const started = Date.now();

      await expect(classifyDocumentStructure(bytes, "application/pdf")).resolves.toBe("supported_structure");

      expect(Date.now() - started).toBeLessThan(5_000);
    }, 30_000);

    // A clean 98 MB file peaks at 393 MB. 32 + 1 x 98 = 130 would kill the
    // child; 32 + 5 x 98 = 522 leaves room, as pdf.js needs when it re-indexes
    // a file whose cross-reference offset is a few bytes out (about 5x the file).
    it("accepts a 98 MB PDF when the structure ceiling adds five times the file to the allowance", async () => {
      setSandboxLimits({ wallMs: 60_000, structureMemoryMb: 32 });

      await expect(classifyDocumentStructure(paddedPdf(98 * MB), "application/pdf")).resolves.toBe("supported_structure");
    }, 30_000);

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

describe("the PDF sandbox stop record names the job that stopped (D-F2, W-F1)", () => {
  afterEach(() => {
    setSandboxLimits(undefined);
  });

  it("still says 'PDF structure sandbox stopped the check: crash' as a warn for a start-up crash, with action check_parser and impact document_upload_blocked", async () => {
    setSandboxLimits({ ...TEST_LIMITS, startupMs: 1 });

    const { records } = await withLogRecords(() => classifyDocumentStructure(syntheticPdf(), "application/pdf"));

    const inspection = records.filter((record) => record.fields.event === "document.inspection");
    expect(inspection).toHaveLength(1);
    expect(inspection[0]!.level).toBe("warn");
    expect(inspection[0]!.fields).toMatchObject({
      detail: "PDF structure sandbox stopped the check: crash",
      action: "check_parser",
      impact: "document_upload_blocked",
    });
  }, TEST_TIMEOUT_MS);

  it.each([
    ["a memory stop", () => ({ wallMs: 60_000, heapMb: 32 }), () => hostilePdf("\f", "%%EOF")],
    ["a timeout", () => ({ wallMs: 1 }), () => syntheticPdf()],
    ["a crash", () => ({ startupMs: 1 }), () => syntheticPdf()],
  ] as const)("records %s of the check with reason processing_interrupted, not unsupported_structure", async (_name, limitsFor, build) => {
    setSandboxLimits({ ...TEST_LIMITS, ...limitsFor() });

    const { records } = await withLogRecords(() => classifyDocumentStructure(build(), "application/pdf"));

    const inspection = records.filter((record) => record.fields.event === "document.inspection");
    expect(inspection.length).toBeGreaterThanOrEqual(1);
    for (const record of inspection) expect(record.fields.reason).toBe("processing_interrupted");
  }, TEST_TIMEOUT_MS);
});
