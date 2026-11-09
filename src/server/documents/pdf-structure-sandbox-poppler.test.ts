import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { syntheticOwnerPasswordPdf, syntheticUserPasswordPdf } from "../../../tests/support/encrypted-pdf-documents";
import { largeFixtureDirectory, removeFixtureDirectory, writeFixtureFile } from "../../../tests/support/large-pdf";
import {
  colourScanPdf,
  cropBoxPdf,
  contentBombPdf,
  CROP_BOX_POINTS,
  hugeImagePdf,
  noPagesPdf,
  oneBitPagePdf,
  phonePhotoPdf,
  rotatedPagePdf,
  softMaskBombPdf,
  TEXT_AREA_POINTS,
  TEXT_PAGE,
  textPagesPdf,
  tilingBombPdf,
  tinyStepTilingPdf,
} from "../../../tests/support/pdf-measure/fixtures";
import {
  darkPixelsIn,
  expectPidGoneWithin,
  type FileOnDisk,
  jpegFrameSize,
  jpegOf,
  loadPopplerSandbox,
  MiB,
  NEEDS_POPPLER,
  ONE_PAGE_PDFINFO,
  type PageAnswer,
  peakChildMemory,
  popplerIt,
  processesNaming,
  softLimit,
  writeStubTool,
} from "../../../tests/support/poppler-sandbox";
import { peakRssGrowth, withLogRecords } from "../../../tests/support/sandbox-test-helpers";
import { syntheticPdf } from "../../../tests/support/synthetic-documents";
import { DOCUMENT_PREVIEW_MAX_EDGE, DOCUMENT_PREVIEW_RENDER_BUDGET_MS } from "./preview";
import { classifyDocumentStructure, PDF_STRUCTURE_MAX_PAGES } from "./validation";

/**
 * #1436: the structure check is poppler's `pdfinfo` and a page draw is
 * poppler's `pdftoppm`, each one process under the sandbox's wrapper
 * (`ulimit -t`, `ulimit -v`), handed the file as descriptor 4, with an empty
 * environment, in one of three slot pools (design note D1-D5). Every test
 * names the §1.5 spec line it covers.
 *
 * Two kinds of test. Those run through `popplerIt` use the real tools: where
 * poppler is missing they skip, saying so, outside CI, and fail with "poppler
 * missing in CI" in CI. The rest run a stand-in tool script
 * (`pdfinfoPath` / `pdftoppmPath` limit overrides, the tool-path injection
 * that replaces `pdfjsUrl`), so they run everywhere.
 */

const sandbox = await loadPopplerSandbox();
const setLimits = (override: Record<string, unknown> | undefined) => sandbox.setPdfStructureSandboxLimitsForTests(override);

let directory: string;
const files = new Map<string, FileOnDisk>();

function stash(name: string, bytes: Buffer): FileOnDisk {
  const file = { path: writeFixtureFile(directory, name, bytes), sizeBytes: bytes.length };
  files.set(name, file);
  return file;
}

function fileOf(name: string): FileOnDisk {
  const file = files.get(name);
  if (!file) throw new Error(`no fixture ${name}`);
  return file;
}

const render = (file: FileOnDisk, page: number, wallMs: number, pool: "view" | "background" = "view") =>
  sandbox.renderPdfPageInSandbox(file, { page, maxEdge: DOCUMENT_PREVIEW_MAX_EDGE, wallMs, pool });

beforeAll(() => {
  directory = largeFixtureDirectory();
  stash("text-1p.pdf", textPagesPdf(1));
  stash("text-3p.pdf", textPagesPdf(3));
  stash("text-100p.pdf", textPagesPdf(100));
  stash("text-101p.pdf", textPagesPdf(101));
  stash("user-password.pdf", syntheticUserPasswordPdf());
  stash("owner-password.pdf", syntheticOwnerPasswordPdf());
  stash("not-a-pdf.pdf", Buffer.from("this is plain text, not a PDF at all\n".repeat(20)));
  stash("no-pages.pdf", noPagesPdf());
  stash("tiny-step.pdf", tinyStepTilingPdf());
  stash("synthetic.pdf", syntheticPdf());
});

afterAll(() => {
  removeFixtureDirectory(directory);
});

/**
 * §1.5 line 16: no test leaves a child behind. Only children of this file are
 * looked for: each is given a path inside this file's own `directory`, whereas
 * a match on the tool names alone also found other test files' children
 * running in parallel workers.
 */
afterEach(async () => {
  setLimits(undefined);
  const deadline = Date.now() + 1_000;
  while (sandbox.pdfStructureSandboxInFlightForTests() !== 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(sandbox.pdfStructureSandboxInFlightForTests(), "§1.5 line 16: a child still in flight after the test").toBe(0);
  expect(processesNaming([directory]), "§1.5 line 16: a poppler child outlived its test").toEqual([]);
});

describe("§1.5 line 17 and D2/D5: the published limits", () => {
  it("line 17: DOCUMENT_PREVIEW_RENDER_BUDGET_MS is 15,000", () => {
    expect(DOCUMENT_PREVIEW_RENDER_BUDGET_MS).toBe(15_000);
  });

  it("line 17: PDF_STRUCTURE_MAX_PAGES is 100 (owner, O1)", () => {
    expect(PDF_STRUCTURE_MAX_PAGES).toBe(100);
  });

  it("D2/D5: check ceiling 64 MiB, render ceiling 256 MiB (owner, O2), check clock 5 s, pools check 2 / view 2 / background 1", () => {
    expect(sandbox.PDF_STRUCTURE_SANDBOX_LIMITS).toMatchObject({
      wallMs: 5_000,
      structureMemoryMb: 64,
      renderMemoryMb: 256,
      concurrency: { check: 2, view: 2, background: 1 },
    });
  });
});

describe(`the structure check is pdfinfo ${NEEDS_POPPLER}`, () => {
  popplerIt("§1.5 line 1: a one-page text PDF answers supported_structure with pageCount 1", async () => {
    await expect(sandbox.inspectPdfStructureInSandbox(fileOf("text-1p.pdf"))).resolves.toEqual({ reason: "supported_structure", pageCount: 1 });
  }, 10_000);

  popplerIt("§1.5 line 1: a 100-page file answers pageCount 100", async () => {
    await expect(sandbox.inspectPdfStructureInSandbox(fileOf("text-100p.pdf"))).resolves.toEqual({ reason: "supported_structure", pageCount: 100 });
  }, 10_000);

  popplerIt("§1.5 line 1: a 101-page file answers unsupported_structure (cap 100)", async () => {
    const answer = await sandbox.inspectPdfStructureInSandbox(fileOf("text-101p.pdf"));
    expect(answer.reason).toBe("unsupported_structure");
  }, 10_000);

  popplerIt("§1.5 line 2: a user-password PDF answers password_required", async () => {
    const answer = await sandbox.inspectPdfStructureInSandbox(fileOf("user-password.pdf"));
    expect(answer.reason).toBe("password_required");
  }, 10_000);

  popplerIt("§1.5 line 2: an owner-password-only PDF answers supported_structure (#1292)", async () => {
    await expect(sandbox.inspectPdfStructureInSandbox(fileOf("owner-password.pdf"))).resolves.toMatchObject({ reason: "supported_structure", pageCount: 1 });
  }, 10_000);

  popplerIt("§1.5 line 3: bytes that are not a PDF answer unsupported_structure", async () => {
    const answer = await sandbox.inspectPdfStructureInSandbox(fileOf("not-a-pdf.pdf"));
    expect(answer.reason).toBe("unsupported_structure");
  }, 10_000);

  popplerIt("§1.5 line 3: a PDF whose catalog has no pages answers unsupported_structure", async () => {
    const answer = await sandbox.inspectPdfStructureInSandbox(fileOf("no-pages.pdf"));
    expect(answer.reason).toBe("unsupported_structure");
  }, 10_000);

  popplerIt("§1.5 line 3: the server's RSS grows by no more than 5 MiB across 20 such checks", async () => {
    // Warm the path first, so module loading is not counted as growth.
    await sandbox.inspectPdfStructureInSandbox(fileOf("not-a-pdf.pdf"));
    const before = process.memoryUsage().rss;
    for (let round = 0; round < 10; round += 1) {
      expect((await sandbox.inspectPdfStructureInSandbox(fileOf("not-a-pdf.pdf"))).reason).toBe("unsupported_structure");
      expect((await sandbox.inspectPdfStructureInSandbox(fileOf("no-pages.pdf"))).reason).toBe("unsupported_structure");
    }
    expect(process.memoryUsage().rss - before).toBeLessThanOrEqual(5 * MiB);
  }, 30_000);

  popplerIt("D3: classifyDocumentStructure returns { reason, pageCount } for a PDF on disk", async () => {
    const bytes = readFileSync(fileOf("text-3p.pdf").path);
    await expect(classifyDocumentStructure(bytes, "application/pdf", fileOf("text-3p.pdf"))).resolves.toEqual({ reason: "supported_structure", pageCount: 3 });
  }, 10_000);

  popplerIt("§1.5 line 13: the sandbox self-check reports no problem where poppler is installed", async () => {
    await expect(sandbox.pdfSandboxSelfCheck()).resolves.toBeUndefined();
  }, 10_000);
});

describe("the structure check's stops, with a stand-in pdfinfo (§1.5 line 4)", () => {
  it("control: a stand-in pdfinfo printing one A4 page answers supported_structure with pageCount 1, so the stand-in is what runs", async () => {
    const marker = join(directory, "ran-pdfinfo-control");
    const tool = writeStubTool(directory, "pdfinfo-control", `: > "${marker}"\n/usr/bin/printf '${ONE_PAGE_PDFINFO.replaceAll("\n", "\\n")}'`);
    setLimits({ pdfinfoPath: tool });
    await expect(sandbox.inspectPdfStructureInSandbox(fileOf("synthetic.pdf"))).resolves.toEqual({ reason: "supported_structure", pageCount: 1 });
    expect(existsSync(marker)).toBe(true);
  }, 10_000);

  it("line 4: a check whose child is stopped by the clock answers structure_check_unavailable", async () => {
    const marker = join(directory, "ran-pdfinfo-slow");
    const tool = writeStubTool(directory, "pdfinfo-slow", `: > "${marker}"\n/bin/sleep 5\n/usr/bin/printf '${ONE_PAGE_PDFINFO.replaceAll("\n", "\\n")}'`);
    setLimits({ pdfinfoPath: tool, wallMs: 300 });
    const started = Date.now();
    await expect(sandbox.inspectPdfStructureInSandbox(fileOf("synthetic.pdf"))).resolves.toEqual({ reason: "structure_check_unavailable" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(existsSync(marker), "the stand-in never ran, so no clock stopped it").toBe(true);
  }, 10_000);

  it("line 4: a child that cannot start (tool path a missing file) answers structure_check_unavailable and logs check_parser as a warning", async () => {
    setLimits({ pdfinfoPath: join(directory, "no-such-pdfinfo") });
    const { result, records } = await withLogRecords(() => sandbox.inspectPdfStructureInSandbox(fileOf("synthetic.pdf")));
    expect(result).toEqual({ reason: "structure_check_unavailable" });
    const inspection = records.filter((record) => record.fields.event === "document.inspection");
    expect(inspection.length).toBeGreaterThanOrEqual(1);
    expect(inspection.some((record) => record.level === "warn" && record.fields.action === "check_parser")).toBe(true);
  }, 10_000);
});

describe(`page draws are pdftoppm ${NEEDS_POPPLER}`, () => {
  popplerIt("§1.5 line 5: page 1 of the text PDF draws as image/jpeg starting FF D8 FF, long edge 1,200, with dark text pixels where the text is", async () => {
    const answer = await render(fileOf("text-1p.pdf"), 1, DOCUMENT_PREVIEW_RENDER_BUDGET_MS);
    expect(answer.outcome).toBe("drawn");
    const drawn = answer as Extract<PageAnswer, { outcome: "drawn" }>;
    expect([...drawn.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const frame = jpegFrameSize(drawn.bytes);
    expect(frame).toEqual({ width: drawn.width, height: drawn.height });
    expect(Math.max(drawn.width, drawn.height)).toBe(1_200);
    const scale = drawn.height / TEXT_PAGE.height;
    const { dark, area } = await darkPixelsIn(drawn.bytes, {
      left: TEXT_AREA_POINTS.left * scale,
      top: TEXT_AREA_POINTS.top * scale,
      right: TEXT_AREA_POINTS.right * scale,
      bottom: TEXT_AREA_POINTS.bottom * scale,
    });
    // A blank page (a font that failed to load, a memory stop drawn as white) has none.
    expect(dark / area).toBeGreaterThan(0.01);
  }, 20_000);

  popplerIt("§1.5 line 6: the 600 dpi colour A4 scan (DCT, 4960x7016) draws inside the production budget, child peak RSS under 64 MiB", async () => {
    const file = stash("scan-600.pdf", colourScanPdf(600));
    const started = Date.now();
    const { result, peakBytes } = await peakChildMemory(() => render(file, 1, DOCUMENT_PREVIEW_RENDER_BUDGET_MS));
    expect(result.outcome).toBe("drawn");
    expect(Date.now() - started).toBeLessThan(DOCUMENT_PREVIEW_RENDER_BUDGET_MS);
    expect(peakBytes).toBeGreaterThan(0);
    expect(peakBytes).toBeLessThan(64 * MiB);
  }, 60_000);

  popplerIt.each([
    ["the 12 Mpx phone photo", "photo-12mpx.pdf", phonePhotoPdf],
    ["the 1-bit 5316x7522 page", "one-bit-40mpx.pdf", oneBitPagePdf],
  ] as const)("§1.5 line 7: %s draws under 64 MiB child peak and 5 s", async (_name, name, build) => {
    const file = stash(name, build());
    const started = Date.now();
    const { result, peakBytes } = await peakChildMemory(() => render(file, 1, DOCUMENT_PREVIEW_RENDER_BUDGET_MS));
    expect(result.outcome).toBe("drawn");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(peakBytes).toBeGreaterThan(0);
    expect(peakBytes).toBeLessThan(64 * MiB);
  }, 60_000);

  popplerIt("§1.5 line 8: page 100 of the 100-page file draws", async () => {
    const answer = await render(fileOf("text-100p.pdf"), 100, DOCUMENT_PREVIEW_RENDER_BUDGET_MS);
    expect(answer.outcome).toBe("drawn");
  }, 20_000);

  popplerIt("§1.5 line 8: page 101 of the 100-page file answers page_not_found with pageCount 100", async () => {
    await expect(render(fileOf("text-100p.pdf"), 101, DOCUMENT_PREVIEW_RENDER_BUDGET_MS)).resolves.toEqual({ outcome: "page_not_found", pageCount: 100 });
  }, 20_000);

  popplerIt.each([
    ["a page rotated 90 degrees (A4 shown landscape)", "rotated.pdf", rotatedPagePdf, "landscape"],
    ["a page whose CropBox (500x300 pt landscape) differs from its 1600x2400 pt MediaBox", "cropbox.pdf", cropBoxPdf, "landscape"],
    ["an ordinary A4 portrait page", "portrait.pdf", () => textPagesPdf(1), "portrait"],
  ] as const)("long edge: %s draws with its long edge at most 1200 px, in the shape the viewer shows", async (_name, name, build, shape) => {
    const file = stash(name, build());
    const answer = await render(file, 1, DOCUMENT_PREVIEW_RENDER_BUDGET_MS);
    expect(answer.outcome).toBe("drawn");
    if (answer.outcome !== "drawn") return;
    // The frame the JPEG declares, not the sandbox's own report of it.
    const frame = jpegFrameSize(answer.bytes)!;
    expect(frame).toEqual({ width: answer.width, height: answer.height });
    expect(Math.max(frame.width, frame.height)).toBeLessThanOrEqual(DOCUMENT_PREVIEW_MAX_EDGE);
    expect(Math.max(frame.width, frame.height)).toBeGreaterThan(DOCUMENT_PREVIEW_MAX_EDGE - 2);
    if (shape === "landscape") expect(frame.width).toBeGreaterThan(frame.height);
    else expect(frame.height).toBeGreaterThan(frame.width);
    if (name === "cropbox.pdf") {
      // The crop's proportions (5:3), not the media box's (2:3).
      expect(frame.height / frame.width).toBeCloseTo(CROP_BOX_POINTS.height / CROP_BOX_POINTS.width, 1);
    }
  }, 30_000);

  popplerIt.each([
    ["the 128 MB content-stream bomb", "bomb-content.pdf", contentBombPdf],
    ["the 80 soft-mask file", "bomb-softmask.pdf", async () => softMaskBombPdf()],
    ["the 60 tiling file", "bomb-tiling.pdf", async () => tilingBombPdf()],
    ["the 900 Mpx image file", "bomb-image.pdf", hugeImagePdf],
  ] as const)("§1.5 line 9: %s draws or is stopped, child peak RSS under 64 MiB, the server's RSS does not grow", async (_name, name, build) => {
    const file = stash(name, await build());
    // Two draws, so neither measurement carries the other's overhead: the 2 ms
    // child-memory sampler allocates (a /proc read and a regex per tick) and
    // that alone moves the server's peak RSS by up to 8 MiB. The server's own
    // growth is measured first, with nothing but the 15 ms RSS sampler running.
    const { growthBytes } = await peakRssGrowth(() => render(file, 1, DOCUMENT_PREVIEW_RENDER_BUDGET_MS));
    const { result, peakBytes } = await peakChildMemory(() => render(file, 1, DOCUMENT_PREVIEW_RENDER_BUDGET_MS));
    expect(result.outcome === "drawn" || (result.outcome === "failed" && result.stop !== undefined), `answered ${JSON.stringify({ ...result, bytes: undefined })}`).toBe(true);
    expect(peakBytes).toBeGreaterThan(0);
    expect(peakBytes).toBeLessThan(64 * MiB);
    // At most the one bounded answer buffer (4 MiB) plus noise.
    expect(growthBytes).toBeLessThan(8 * MiB);
  }, 120_000);

  popplerIt("§1.5 line 10: the tiny-step tiling pattern is stopped by the clock (500 ms) with stop timeout, the child gone within 1 s", async () => {
    const before = sandbox.lastPdfSandboxChildPidForTests();
    const started = Date.now();
    await expect(render(fileOf("tiny-step.pdf"), 1, 500)).resolves.toEqual({ outcome: "failed", stop: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
    const pid = sandbox.lastPdfSandboxChildPidForTests();
    expect(pid).not.toBe(before);
    await expectPidGoneWithin(pid, 1_000);
  }, 10_000);

  popplerIt("§1.5 line 11: with renderMemoryMb 8 the 300 dpi scan answers failed with stop memory (watchdog or Out of memory tail)", async () => {
    const file = stash("scan-300.pdf", colourScanPdf(300));
    setLimits({ renderMemoryMb: 8 });
    await expect(render(file, 1, DOCUMENT_PREVIEW_RENDER_BUDGET_MS)).resolves.toEqual({ outcome: "failed", stop: "memory" });
  }, 30_000);
});

describe("the page draw's answer is checked (§1.5 line 12), with a stand-in pdftoppm", () => {
  let pdfinfo: string;
  beforeAll(() => {
    pdfinfo = writeStubTool(directory, "pdfinfo-one-page", `/usr/bin/printf '${ONE_PAGE_PDFINFO.replaceAll("\n", "\\n")}'`);
  });

  function stubRenderer(name: string, answer: Buffer, stderr = ""): { tool: string; marker: string } {
    const answerPath = join(directory, `${name}.out`);
    writeFileSync(answerPath, answer);
    const marker = join(directory, `ran-${name}`);
    const tool = writeStubTool(directory, name, `: > "${marker}"\n${stderr ? `echo '${stderr}' >&2\n` : ""}exec /bin/cat "${answerPath}"`);
    return { tool, marker };
  }

  it("control: a stand-in answering a valid 848x1200 JPEG answers drawn with exactly those bytes", async () => {
    const jpeg = jpegOf(848, 1_200);
    const { tool, marker } = stubRenderer("pdftoppm-valid", jpeg);
    setLimits({ pdftoppmPath: tool, pdfinfoPath: pdfinfo });
    const answer = await render(fileOf("synthetic.pdf"), 1, DOCUMENT_PREVIEW_RENDER_BUDGET_MS);
    expect(answer).toMatchObject({ outcome: "drawn", width: 848, height: 1_200 });
    expect((answer as Extract<PageAnswer, { outcome: "drawn" }>).bytes.equals(jpeg)).toBe(true);
    expect(existsSync(marker)).toBe(true);
  }, 10_000);

  it("line 12: a valid JPEG of 1,201 px answers failed", async () => {
    const { tool, marker } = stubRenderer("pdftoppm-1201", jpegOf(849, 1_201));
    setLimits({ pdftoppmPath: tool, pdfinfoPath: pdfinfo });
    const answer = await render(fileOf("synthetic.pdf"), 1, DOCUMENT_PREVIEW_RENDER_BUDGET_MS);
    expect(answer.outcome).toBe("failed");
    expect(existsSync(marker), "the stand-in never ran, so nothing was checked").toBe(true);
  }, 10_000);

  it("line 12: stdout over 4 MiB answers failed (a valid JPEG header, padded past the cap)", async () => {
    const jpeg = jpegOf(848, 1_200);
    const { tool, marker } = stubRenderer("pdftoppm-big", Buffer.concat([jpeg, Buffer.alloc(4 * MiB + 1 - jpeg.length)]));
    setLimits({ pdftoppmPath: tool, pdfinfoPath: pdfinfo });
    const answer = await render(fileOf("synthetic.pdf"), 1, DOCUMENT_PREVIEW_RENDER_BUDGET_MS);
    expect(answer.outcome).toBe("failed");
    expect(existsSync(marker)).toBe(true);
  }, 10_000);

  it("line 12: exit 0 with Out of memory on stderr answers failed with stop memory", async () => {
    const { tool, marker } = stubRenderer("pdftoppm-oom", jpegOf(848, 1_200), "Out of memory");
    setLimits({ pdftoppmPath: tool, pdfinfoPath: pdfinfo });
    await expect(render(fileOf("synthetic.pdf"), 1, DOCUMENT_PREVIEW_RENDER_BUDGET_MS)).resolves.toEqual({ outcome: "failed", stop: "memory" });
    expect(existsSync(marker)).toBe(true);
  }, 10_000);
});

describe("the child's kernel limits, environment and priority, with stand-in tools", () => {
  /** A stand-in that copies its own `/proc/self/limits` (and environment) where the test can read them, then answers. */
  function recordingTools(tag: string, sleepSeconds = 0): { pdfinfo: string; pdftoppm: string; out: (tool: string) => string } {
    const out = (tool: string) => join(directory, `${tag}-${tool}`);
    const jpegPath = join(directory, `${tag}.jpg`);
    writeFileSync(jpegPath, jpegOf(848, 1_200));
    const record = (tool: string) => `/bin/cat /proc/$$/limits > "${out(tool)}.limits"\n/bin/cat /proc/$$/stat > "${out(tool)}.stat"\n: > "${out(tool)}.ran"\n${sleepSeconds ? `/bin/sleep ${sleepSeconds}\n` : ""}`;
    return {
      pdfinfo: writeStubTool(directory, `${tag}-pdfinfo`, `${record("pdfinfo")}/usr/bin/printf '${ONE_PAGE_PDFINFO.replaceAll("\n", "\\n")}'`),
      pdftoppm: writeStubTool(directory, `${tag}-pdftoppm`, `${record("pdftoppm")}exec /bin/cat "${jpegPath}"`),
      out,
    };
  }

  it("§1.5 line 13, D2.3: a draw's child has RLIMIT_AS at the render ceiling + 128 MiB (384 MiB)", async () => {
    const tools = recordingTools("limits-render");
    setLimits({ pdfinfoPath: tools.pdfinfo, pdftoppmPath: tools.pdftoppm });
    expect((await render(fileOf("synthetic.pdf"), 1, 15_000)).outcome).toBe("drawn");
    expect(softLimit(readFileSync(`${tools.out("pdftoppm")}.limits`, "latin1"), "Max address space")).toBe(String(384 * MiB));
  }, 10_000);

  it("§1.5 line 13, D2.3: a check's child has RLIMIT_AS at the check ceiling + 128 MiB (192 MiB)", async () => {
    const tools = recordingTools("limits-check");
    setLimits({ pdfinfoPath: tools.pdfinfo, pdftoppmPath: tools.pdftoppm });
    await expect(sandbox.inspectPdfStructureInSandbox(fileOf("synthetic.pdf"))).resolves.toMatchObject({ reason: "supported_structure" });
    expect(softLimit(readFileSync(`${tools.out("pdfinfo")}.limits`, "latin1"), "Max address space")).toBe(String(192 * MiB));
  }, 10_000);

  it("D2.4: RLIMIT_CPU is the wall clock in whole seconds plus 5: 20 s for a 15 s draw, 10 s for a 5 s check", async () => {
    const tools = recordingTools("limits-cpu");
    setLimits({ pdfinfoPath: tools.pdfinfo, pdftoppmPath: tools.pdftoppm });
    await sandbox.inspectPdfStructureInSandbox(fileOf("synthetic.pdf"));
    await render(fileOf("synthetic.pdf"), 1, 15_000);
    expect(softLimit(readFileSync(`${tools.out("pdfinfo")}.limits`, "latin1"), "Max cpu time")).toBe("10");
    expect(softLimit(readFileSync(`${tools.out("pdftoppm")}.limits`, "latin1"), "Max cpu time")).toBe("20");
  }, 10_000);

  it("§1.5 line 15: the child's environment is empty (/proc/<pid>/environ read while it runs)", async () => {
    const tools = recordingTools("environ", 2);
    setLimits({ pdfinfoPath: tools.pdfinfo, pdftoppmPath: tools.pdftoppm });
    process.env.ORBIT_TEST_SECRET_SHAPED = "must-not-reach-the-child";
    try {
      const drawing = render(fileOf("synthetic.pdf"), 1, 15_000);
      const deadline = Date.now() + 3_000;
      while (!existsSync(`${tools.out("pdftoppm")}.ran`) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(`${tools.out("pdftoppm")}.ran`), "the stand-in pdftoppm never started").toBe(true);
      const pid = sandbox.lastPdfSandboxChildPidForTests();
      const environ = readFileSync(`/proc/${pid}/environ`, "latin1");
      expect(environ.split("\0").filter(Boolean)).toEqual([]);
      await drawing;
    } finally {
      delete process.env.ORBIT_TEST_SECRET_SHAPED;
    }
  }, 10_000);

  /** Field 19 of /proc/<pid>/stat, the nice value (fields counted after the parenthesised name). */
  const niceOf = (stat: string) => Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[16]);

  it("D1/D5: a background draw runs at nice 10 above the server; a view draw does not", async () => {
    const own = niceOf(readFileSync("/proc/self/stat", "latin1"));
    const background = recordingTools("nice-background");
    setLimits({ pdfinfoPath: background.pdfinfo, pdftoppmPath: background.pdftoppm });
    expect((await render(fileOf("synthetic.pdf"), 1, 15_000, "background")).outcome).toBe("drawn");
    expect(niceOf(readFileSync(`${background.out("pdftoppm")}.stat`, "latin1"))).toBe(Math.min(19, own + 10));

    const view = recordingTools("nice-view");
    setLimits({ pdfinfoPath: view.pdfinfo, pdftoppmPath: view.pdftoppm });
    expect((await render(fileOf("synthetic.pdf"), 1, 15_000, "view")).outcome).toBe("drawn");
    expect(niceOf(readFileSync(`${view.out("pdftoppm")}.stat`, "latin1"))).toBe(own);
  }, 10_000);
});

describe("§1.5 line 14 and D5: three slot pools, with stand-in tools", () => {
  /** A stand-in pdftoppm that is slow (1.5 s) for page 2 only, and a pdfinfo that says 3 pages. */
  function poolTools(): { pdfinfo: string; pdftoppm: string } {
    const jpegPath = join(directory, "pool.jpg");
    writeFileSync(jpegPath, jpegOf(848, 1_200));
    return {
      pdfinfo: writeStubTool(directory, "pool-pdfinfo", "/usr/bin/printf 'Pages:          3\\nEncrypted:      no\\nPage    1 size: 595 x 842 pts (A4)\\n'"),
      // Arguments: -f <page> -l <page> ..., so $2 is the page.
      pdftoppm: writeStubTool(directory, "pool-pdftoppm", `if [ "$2" = "2" ]; then /bin/sleep 1.5; fi\nexec /bin/cat "${jpegPath}"`),
    };
  }

  async function timed<T>(run: () => Promise<T>): Promise<{ result: T; ms: number }> {
    const started = performance.now();
    const result = await run();
    return { result, ms: performance.now() - started };
  }

  /** The slowest of five solo runs: the bar a run beside a slow job must stay within twice of. */
  async function soloMs(run: () => Promise<unknown>): Promise<number> {
    let slowest = 0;
    for (let round = 0; round < 5; round += 1) slowest = Math.max(slowest, (await timed(run)).ms);
    return slowest;
  }

  async function untilInFlight(count: number): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (sandbox.pdfStructureSandboxInFlightForTests() < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sandbox.pdfStructureSandboxInFlightForTests()).toBeGreaterThanOrEqual(count);
  }

  it("line 14: with check 1 / view 1, a render holding the view slot does not delay a structure check (within 2x its solo time)", async () => {
    const tools = poolTools();
    setLimits({ pdfinfoPath: tools.pdfinfo, pdftoppmPath: tools.pdftoppm, concurrency: { check: 1, view: 1, background: 1 } });
    const check = () => sandbox.inspectPdfStructureInSandbox(fileOf("synthetic.pdf"));
    const solo = await soloMs(check);
    const slow = render(fileOf("synthetic.pdf"), 2, 10_000, "view");
    await untilInFlight(1);
    const beside = await timed(check);
    expect(beside.result).toMatchObject({ reason: "supported_structure", pageCount: 3 });
    expect(beside.ms).toBeLessThanOrEqual(2 * solo);
    expect((await slow).outcome).toBe("drawn");
  }, 20_000);

  it("line 14: with view 1, two renders queue one behind the other", async () => {
    const tools = poolTools();
    setLimits({ pdfinfoPath: tools.pdfinfo, pdftoppmPath: tools.pdftoppm, concurrency: { check: 1, view: 1, background: 1 } });
    const started = performance.now();
    const finished: number[] = [];
    await Promise.all([1, 2].map(async () => {
      const answer = await render(fileOf("synthetic.pdf"), 2, 10_000, "view");
      finished.push(performance.now() - started);
      expect(answer.outcome).toBe("drawn");
    }));
    finished.sort((a, b) => a - b);
    expect(finished[0]).toBeGreaterThanOrEqual(1_400);
    expect(finished[1]! - finished[0]!).toBeGreaterThanOrEqual(1_400);
  }, 20_000);

  it("D5: a background draw holding its one slot does not delay a view draw (within 2x its solo time)", async () => {
    const tools = poolTools();
    setLimits({ pdfinfoPath: tools.pdfinfo, pdftoppmPath: tools.pdftoppm, concurrency: { check: 1, view: 1, background: 1 } });
    const view = () => render(fileOf("synthetic.pdf"), 1, 10_000, "view");
    const solo = await soloMs(view);
    const slow = render(fileOf("synthetic.pdf"), 2, 10_000, "background");
    await untilInFlight(1);
    const beside = await timed(view);
    expect(beside.result.outcome).toBe("drawn");
    expect(beside.ms).toBeLessThanOrEqual(2 * solo);
    expect((await slow).outcome).toBe("drawn");
  }, 20_000);
});
