import { open } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { syntheticOwnerPasswordPdf, syntheticUserPasswordPdf } from "../../../tests/support/encrypted-pdf-documents";
import { largeFixtureDirectory, removeFixtureDirectory, writeFixtureFile } from "../../../tests/support/large-pdf";
import { textPagesPdf } from "../../../tests/support/pdf-measure/fixtures";
import { NEEDS_POPPLER, ONE_PAGE_PDFINFO, popplerIt, writeStubTool } from "../../../tests/support/poppler-sandbox";
import { readPdfPageCountInSandbox, setPdfStructureSandboxLimitsForTests } from "./pdf-structure-sandbox";

/**
 * #1433: a stored PDF's page count is read by `pdfinfo` in the sandbox, with
 * no page cap (a document accepted under the old 1,000-page cap is counted as
 * it is). A file pdfinfo cannot open, or that needs a password, is `refused`;
 * a child Orbit could not start is `failed` with `unavailable`, which says
 * nothing about the file. The preview worker reads it through the descriptor
 * it already holds, as here.
 */

let directory: string;

beforeAll(() => {
  directory = largeFixtureDirectory();
});

afterAll(() => {
  removeFixtureDirectory(directory);
});

afterEach(() => {
  setPdfStructureSandboxLimitsForTests(undefined);
});

async function countOf(name: string, bytes: Buffer, pool: "view" | "background" = "background") {
  const path = writeFixtureFile(directory, name, bytes);
  const handle = await open(path, "r");
  try {
    return await readPdfPageCountInSandbox({ handle, sizeBytes: bytes.length }, pool);
  } finally {
    await handle.close();
  }
}

describe(`readPdfPageCountInSandbox ${NEEDS_POPPLER}`, () => {
  popplerIt("counts a document's pages, in either pool", async () => {
    expect(await countOf("three.pdf", textPagesPdf(3))).toEqual({ outcome: "counted", pageCount: 3 });
    expect(await countOf("one.pdf", textPagesPdf(1), "view")).toEqual({ outcome: "counted", pageCount: 1 });
  }, 20_000);

  popplerIt("applies no page cap", async () => {
    expect(await countOf("many.pdf", textPagesPdf(1_005))).toEqual({ outcome: "counted", pageCount: 1_005 });
  }, 30_000);

  popplerIt("counts an owner-password file, which poppler opens itself", async () => {
    expect(await countOf("owner.pdf", syntheticOwnerPasswordPdf())).toEqual({ outcome: "counted", pageCount: 1 });
  }, 20_000);

  popplerIt("refuses a file that needs a password, or is not a PDF", async () => {
    expect(await countOf("user.pdf", syntheticUserPasswordPdf())).toEqual({ outcome: "refused" });
    expect(await countOf("text.pdf", Buffer.from("plain text, not a PDF\n".repeat(20)))).toEqual({ outcome: "refused" });
  }, 20_000);
});

describe("readPdfPageCountInSandbox's stops, with a stand-in pdfinfo", () => {
  it("refuses an answer of zero pages", async () => {
    const tool = writeStubTool(directory, "pdfinfo-zero", `/usr/bin/printf 'Pages:          0\\nEncrypted:      no\\n'`);
    setPdfStructureSandboxLimitsForTests({ pdfinfoPath: tool });
    expect(await countOf("zero.pdf", Buffer.from("%PDF-1.7\n"))).toEqual({ outcome: "refused" });
  }, 10_000);

  it("reads the count the tool printed, so the stand-in is what runs", async () => {
    const tool = writeStubTool(directory, "pdfinfo-one", `/usr/bin/printf '${ONE_PAGE_PDFINFO.replaceAll("\n", "\\n")}'`);
    setPdfStructureSandboxLimitsForTests({ pdfinfoPath: tool });
    expect(await countOf("stub-one.pdf", Buffer.from("%PDF-1.7\n"))).toEqual({ outcome: "counted", pageCount: 1 });
  }, 10_000);

  it("answers failed/unavailable, never refused, when the tool cannot start", async () => {
    setPdfStructureSandboxLimitsForTests({ pdfinfoPath: join(directory, "no-such-pdfinfo") });
    expect(await countOf("unstarted.pdf", Buffer.from("%PDF-1.7\n"))).toEqual({ outcome: "failed", stop: "unavailable" });
  }, 10_000);

  it("answers failed/timeout when the child is stopped by the clock", async () => {
    const tool = writeStubTool(directory, "pdfinfo-slow", `/bin/sleep 5\n/usr/bin/printf '${ONE_PAGE_PDFINFO.replaceAll("\n", "\\n")}'`);
    setPdfStructureSandboxLimitsForTests({ pdfinfoPath: tool, wallMs: 300 });
    expect(await countOf("slow.pdf", Buffer.from("%PDF-1.7\n"))).toEqual({ outcome: "failed", stop: "timeout" });
  }, 10_000);
});
