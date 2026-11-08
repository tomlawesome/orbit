import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { largeFixtureDirectory, removeFixtureDirectory, writeFixtureFile } from "../../../tests/support/large-pdf";
import { popplerIt } from "../../../tests/support/poppler-sandbox";
import { expectChildGone, setSandboxLimits as setLimits, withLogRecords } from "../../../tests/support/sandbox-test-helpers";
import { textPagesPdf } from "../../../tests/support/pdf-measure/fixtures";
import {
  inspectPdfStructureInSandbox,
  lastPdfSandboxChildPidForTests,
  pdfStructureSandboxInFlightForTests,
} from "./pdf-structure-sandbox";
import { classifyDocumentStructure } from "./validation";

/**
 * What `withPdfDescriptor` guards (#1436, brought back from the pdf.js-era
 * file tests of #1567): the structure check is handed the file by path and
 * stated size, the server opens it read-only, and a file that is not what the
 * job says it is, or cannot be opened, is no verdict. The size and missing-file
 * cases stop before any tool starts, so they run without poppler.
 */

const TEST_TIMEOUT_MS = 20_000;

let directory: string;
let small: { path: string; sizeBytes: number };

beforeAll(() => {
  directory = largeFixtureDirectory();
  const bytes = textPagesPdf(1);
  small = { path: writeFixtureFile(directory, "small.pdf", bytes), sizeBytes: bytes.length };
});

afterAll(() => {
  removeFixtureDirectory(directory);
});

afterEach(() => {
  setLimits(undefined);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const openDescriptors = (): number => readdirSync("/proc/self/fd").length;

describe("the structure check's file descriptor", () => {
  popplerIt("leaves the process with the same number of open descriptors before and after a check, and after a refused one", async () => {
    const bad = { path: small.path, sizeBytes: small.sizeBytes + 1 };
    // The child's pipes close after the child exits, which can be after the job's answer.
    const settledCount = async (pidBefore: number | undefined): Promise<number> => {
      await expectChildGone(pidBefore);
      await sleep(100);
      return openDescriptors();
    };
    // Warm up, so one-off descriptors (loaded modules, the log sink) are not counted.
    const first = lastPdfSandboxChildPidForTests();
    await inspectPdfStructureInSandbox(small);
    await settledCount(first);

    const pidBefore = lastPdfSandboxChildPidForTests();
    const before = openDescriptors();
    await expect(inspectPdfStructureInSandbox(small)).resolves.toEqual({ reason: "supported_structure", pageCount: 1 });
    expect(await settledCount(pidBefore)).toBe(before);

    // A refused size mismatch starts no child, and must not leave its descriptor either.
    await expect(inspectPdfStructureInSandbox(bad)).resolves.toEqual({ reason: "structure_check_unavailable" });
    expect(openDescriptors()).toBe(before);
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
  }, TEST_TIMEOUT_MS);
});

describe("a file that is not what the job says it is", () => {
  it.each([
    ["larger", 1],
    ["smaller", -1],
  ] as const)("answers structure_check_unavailable, with no child started, when the stated size is %s than the file", async (_which, delta) => {
    const before = lastPdfSandboxChildPidForTests();

    const { result, records } = await withLogRecords(() => inspectPdfStructureInSandbox({ path: small.path, sizeBytes: small.sizeBytes + delta }));

    expect(result).toEqual({ reason: "structure_check_unavailable" });
    expect(lastPdfSandboxChildPidForTests()).toBe(before);
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    const inspection = records.filter((record) => record.fields.event === "document.inspection");
    expect(inspection).toHaveLength(1);
    expect(String(inspection[0]!.fields.detail)).toContain("size_mismatch");
  }, TEST_TIMEOUT_MS);
});

describe("a quarantine file that cannot be opened is no verdict", () => {
  it("answers structure_check_unavailable for a PDF whose file does not exist, with a warn saying it could not open the file to check, not a crash", async () => {
    const missing = { path: join(directory, "no-such-quarantine-file.pdf"), sizeBytes: 100 };

    const { result, records } = await withLogRecords(() => classifyDocumentStructure(Buffer.alloc(0), "application/pdf", missing));

    expect(result).toEqual({ reason: "structure_check_unavailable" });
    const inspection = records.filter((record) => record.fields.event === "document.inspection");
    expect(inspection).toHaveLength(1);
    expect(inspection[0]!.level).toBe("warn");
    expect(String(inspection[0]!.fields.detail)).toContain("could not open the file to check");
    expect(String(inspection[0]!.fields.detail)).toContain("ENOENT");
    expect(inspection[0]!.fields).toMatchObject({ reason: "processing_interrupted", action: "inspect_admin_diagnostics" });
    expect(JSON.stringify(records)).not.toMatch(/crash/i);
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
  }, TEST_TIMEOUT_MS);
});

