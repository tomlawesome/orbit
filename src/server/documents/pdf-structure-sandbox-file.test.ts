import { readFileSync, readdirSync, readlinkSync, fstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Records the FileHandles the sandbox opens on a given path, so the test can
// look at the very descriptor number the server held. Everything else passes through.
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

import { log } from "@/lib/logger";
import { syntheticPdfWithPages } from "../../../tests/support/generated-pdf-documents";
import { syntheticOwnerPasswordPdf, syntheticUserPasswordPdf } from "../../../tests/support/encrypted-pdf-documents";
import { syntheticPdf } from "../../../tests/support/synthetic-documents";
import { hostilePdf, objectStreamBomb } from "../../../tests/support/pdf-budget-shapes";
import {
  largeFixtureDirectory,
  removeFixtureDirectory,
  writeFixtureFile,
  writePaddedPdfFile,
} from "../../../tests/support/large-pdf";
import {
  inspectPdfStructureInSandbox,
  lastPdfSandboxChildPidForTests,
  pdfStructureSandboxInFlightForTests,
  setPdfStructureInspectorForTests,
  setPdfStructureSandboxLimitsForTests,
} from "./pdf-structure-sandbox";
import { classifyDocumentStructure } from "./validation";

/**
 * #1567: the structure check's file arrives as a read-only file descriptor the
 * child inherits at spawn (ADR-0038 amendment), not as a copy over the IPC
 * channel. These tests use the real parser and the real child, as
 * pdf-structure-sandbox.test.ts does. `file` is `{ path, sizeBytes }`; the
 * render job and the no-file call keep the IPC hand-over.
 */

const MB = 1024 * 1024;
const TEST_TIMEOUT_MS = 10_000;

type Limits = Parameters<typeof setPdfStructureSandboxLimitsForTests>[0] & { pdfjsUrl?: string };
function setLimits(limits: Limits | undefined): void {
  setPdfStructureSandboxLimitsForTests(limits as Parameters<typeof setPdfStructureSandboxLimitsForTests>[0]);
}

let directory: string;
const files = new Map<string, { path: string; sizeBytes: number }>();

function fileOf(name: string): { path: string; sizeBytes: number } {
  const entry = files.get(name);
  if (!entry) throw new Error(`no fixture file ${name}`);
  return entry;
}

function stash(name: string, bytes: Buffer): void {
  files.set(name, { path: writeFixtureFile(directory, name, bytes), sizeBytes: bytes.length });
}

beforeAll(async () => {
  directory = largeFixtureDirectory();
  stash("small.pdf", syntheticPdf());
  stash("pages-1001.pdf", syntheticPdfWithPages(1001));
  stash("user-password.pdf", syntheticUserPasswordPdf());
  stash("owner-password.pdf", syntheticOwnerPasswordPdf());
  stash("heap-bomb.pdf", hostilePdf("\f", "%%EOF"));
  stash("object-stream-bomb.pdf", objectStreamBomb(128));
  for (const [name, size] of [["20mb.pdf", 20 * MB], ["98mb.pdf", 98 * MB]] as const) {
    const path = join(directory, name);
    await writePaddedPdfFile(path, size);
    files.set(name, { path, sizeBytes: size });
  }
}, 60_000);

afterAll(() => {
  removeFixtureDirectory(directory);
});

afterEach(() => {
  setLimits(undefined);
  setPdfStructureInspectorForTests(undefined);
  opened.watch = undefined;
  opened.handles.length = 0;
  vi.restoreAllMocks();
});

/** The check as the repository calls it: the bytes it read, and the quarantine file's path and size. */
async function classifyFile(name: string) {
  const file = fileOf(name);
  return classifyDocumentStructure(readFileSync(file.path), "application/pdf", file);
}

async function withCapturedLogs<T>(run: () => Promise<T>): Promise<{ result: T; logged: string; calls: number }> {
  const spies = (["error", "warn", "info", "debug"] as const).map((level) =>
    vi.spyOn(log, level).mockImplementation(() => undefined));
  try {
    const result = await run();
    const recorded = spies.flatMap((spy) => spy.mock.calls);
    return { result, logged: JSON.stringify(recorded), calls: recorded.length };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

async function peakRssGrowth<T>(run: () => Promise<T>): Promise<{ result: T; growthBytes: number }> {
  const before = process.memoryUsage().rss;
  let peak = before;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 15);
  try {
    const result = await run();
    peak = Math.max(peak, process.memoryUsage().rss);
    return { result, growthBytes: peak - before };
  } finally {
    clearInterval(sampler);
  }
}

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A stand-in parser module whose open takes `delayMs`, so a job can be looked at while it is running. */
function slowPdfjsModule(delayMs: number): string {
  return `
function getDocument() {
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
  const promise = new Promise((resolve) => setTimeout(() => resolve(document), ${delayMs}));
  return { promise, onPassword: undefined, destroy: async () => undefined };
}
export { getDocument };
export const GlobalWorkerOptions = {};
export default { getDocument, GlobalWorkerOptions };
`;
}

describe("the structure check given a file (#1567)", () => {
  describe("legitimate and refused files get the answers they always did", () => {
    it.each([
      ["a small synthetic PDF", "small.pdf"],
      ["a 20 MB PDF", "20mb.pdf"],
      ["a 98 MB PDF", "98mb.pdf"],
      ["an owner-password-only PDF", "owner-password.pdf"],
    ] as const)("accepts %s as supported_structure", async (_what, name) => {
      await expect(classifyFile(name)).resolves.toBe("supported_structure");
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    }, 30_000);

    it("refuses a PDF with 1001 pages as unsupported_structure", async () => {
      await expect(classifyFile("pages-1001.pdf")).resolves.toBe("unsupported_structure");
    }, TEST_TIMEOUT_MS);

    it("asks for a password when the user password is set", async () => {
      await expect(classifyFile("user-password.pdf")).resolves.toBe("password_required");
    }, TEST_TIMEOUT_MS);
  });

  describe("hostile files given as files are stopped as memory, not as timeout, and leave no child", () => {
    it("stops a heap bomb on the heap cap", async () => {
      setLimits({ wallMs: 60_000, heapMb: 32 });
      const before = lastPdfSandboxChildPidForTests();
      const started = Date.now();

      const captured = await withCapturedLogs(() => classifyFile("heap-bomb.pdf"));

      expect(captured.result).toBe("unsupported_structure");
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(captured.logged).toMatch(/memory/i);
      expect(captured.logged).not.toMatch(/crash/i);
      expect(captured.logged).not.toMatch(/timeout|timed.?out/i);
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
      await expectChildGone(before);
    }, 30_000);

    it("stops an object-stream bomb on the memory ceiling", async () => {
      setLimits({ wallMs: 60_000, structureMemoryMb: 192 });
      const before = lastPdfSandboxChildPidForTests();
      const started = Date.now();

      const captured = await withCapturedLogs(() => classifyFile("object-stream-bomb.pdf"));

      expect(captured.result).toBe("unsupported_structure");
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(captured.calls).toBeGreaterThan(0);
      expect(captured.logged).toMatch(/memory/i);
      expect(captured.logged).not.toMatch(/timeout|timed.?out/i);
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
      await expectChildGone(before);
    }, 30_000);
  });

  describe("the server holds no copy for the hand-over", () => {
    it("checks the 98 MB file by descriptor without this process's RSS growing by 8 MiB", async () => {
      const file = fileOf("98mb.pdf");
      // Warm up: the child's code and the parser's first load are not the hand-over.
      await expect(inspectPdfStructureInSandbox(Buffer.alloc(0), fileOf("small.pdf"))).resolves.toBe("supported_structure");

      const { result, growthBytes } = await peakRssGrowth(() => inspectPdfStructureInSandbox(Buffer.alloc(0), file));

      expect(result).toBe("supported_structure");
      expect(growthBytes).toBeLessThan(8 * MB);
    }, 30_000);

    it("reads the file, not the bytes it is also given", async () => {
      const real = readFileSync(fileOf("small.pdf").path);
      await expect(inspectPdfStructureInSandbox(Buffer.from("not a pdf at all"), fileOf("small.pdf")))
        .resolves.toBe("supported_structure");

      const garbage = Buffer.alloc(real.length, 0x41);
      const garbagePath = writeFixtureFile(directory, "garbage-same-size.bin", garbage);
      await expect(inspectPdfStructureInSandbox(real, { path: garbagePath, sizeBytes: garbage.length }))
        .resolves.toBe("unsupported_structure");
    }, TEST_TIMEOUT_MS);
  });

  describe("the server's descriptor", () => {
    it("is closed once the child has started: fstat on its number throws EBADF while the job is still running", async () => {
      const module = join(directory, "slow-pdfjs.mjs");
      writeFileSync(module, slowPdfjsModule(1200));
      setLimits({ wallMs: 8_000, pdfjsUrl: pathToFileURL(module).href });
      const file = fileOf("small.pdf");
      opened.watch = file.path;
      const before = lastPdfSandboxChildPidForTests();

      const job = inspectPdfStructureInSandbox(readFileSync(file.path), file);
      const deadline = Date.now() + 5_000;
      while (lastPdfSandboxChildPidForTests() === before && Date.now() < deadline) await sleep(5);
      expect(lastPdfSandboxChildPidForTests(), "the child was started").not.toBe(before);
      await sleep(300);

      expect(opened.handles, "the sandbox opened one FileHandle on the file").toHaveLength(1);
      const { fd, handle } = opened.handles[0]!;
      expect(fd).toBeGreaterThan(2);
      expect(handle.fd, "the server closed its handle").toBe(-1);
      let fstatError: NodeJS.ErrnoException | undefined;
      try {
        fstatSync(fd);
      } catch (error) {
        fstatError = error as NodeJS.ErrnoException;
      }
      expect(fstatError?.code, "fstat on the closed descriptor's number").toBe("EBADF");
      const links = readdirSync("/proc/self/fd").map((entry) => {
        try { return readlinkSync(join("/proc/self/fd", entry)); } catch { return ""; }
      });
      expect(links, "no descriptor on the file is left open in the server").not.toContain(file.path);

      await expect(job).resolves.toBe("supported_structure");
    }, 30_000);

    it("leaves the process with the same number of open descriptors before and after a check, and after a refused one", async () => {
      const small = fileOf("small.pdf");
      const bad = { path: small.path, sizeBytes: small.sizeBytes + 1 };
      await inspectPdfStructureInSandbox(Buffer.alloc(0), small);
      const count = (): number => readdirSync("/proc/self/fd").length;

      const before = count();
      await expect(inspectPdfStructureInSandbox(Buffer.alloc(0), small)).resolves.toBe("supported_structure");
      expect(count()).toBe(before);
      await expect(inspectPdfStructureInSandbox(Buffer.alloc(0), bad)).resolves.toBe("unsupported_structure");
      expect(count()).toBe(before);
    }, TEST_TIMEOUT_MS);
  });

  describe("a file that is not what the job says it is", () => {
    it.each([
      ["larger", 1],
      ["smaller", -1],
    ] as const)("answers unsupported_structure, and the child is gone, when the stated size is %s than the file", async (_which, delta) => {
      const small = fileOf("small.pdf");
      const before = lastPdfSandboxChildPidForTests();

      await expect(inspectPdfStructureInSandbox(readFileSync(small.path), { path: small.path, sizeBytes: small.sizeBytes + delta }))
        .resolves.toBe("unsupported_structure");

      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
      await expectChildGone(before);
    }, TEST_TIMEOUT_MS);
  });

  describe("the hand-over that stays", () => {
    it("still checks bytes given without a file, over the channel", async () => {
      await expect(inspectPdfStructureInSandbox(syntheticPdf())).resolves.toBe("supported_structure");
      await expect(inspectPdfStructureInSandbox(Buffer.from("%PDF-1.7\ntruncated"))).resolves.toBe("unsupported_structure");
    }, TEST_TIMEOUT_MS);

    it("gives the test inspector the bytes, whether or not a file is passed", async () => {
      const inspector = vi.fn().mockResolvedValue("supported_structure");
      setPdfStructureInspectorForTests(inspector);
      const file = fileOf("small.pdf");
      const bytes = readFileSync(file.path);

      await expect(classifyDocumentStructure(bytes, "application/pdf", file)).resolves.toBe("supported_structure");
      await expect(classifyDocumentStructure(bytes, "application/pdf")).resolves.toBe("supported_structure");

      expect(inspector).toHaveBeenCalledTimes(2);
      expect(inspector.mock.calls[0]![0]).toBe(bytes);
      expect(inspector.mock.calls[1]![0]).toBe(bytes);
    });

    it("does not hand the child this process's environment when the file arrives as a descriptor", async () => {
      const module = join(directory, "env-canary-pdfjs.mjs");
      writeFileSync(module, slowPdfjsModule(0).replace(
        "function getDocument() {",
        `function getDocument() {
  if (process.env.ORBIT_SANDBOX_FILE_CANARY !== undefined) throw new Error("the child inherited the parent environment");`,
      ));
      process.env.ORBIT_SANDBOX_FILE_CANARY = "must-not-reach-the-child";
      try {
        setLimits({ wallMs: 5_000, pdfjsUrl: pathToFileURL(module).href });
        const file = fileOf("small.pdf");

        await expect(inspectPdfStructureInSandbox(readFileSync(file.path), file)).resolves.toBe("supported_structure");
      } finally {
        delete process.env.ORBIT_SANDBOX_FILE_CANARY;
      }
    }, TEST_TIMEOUT_MS);
  });
});

