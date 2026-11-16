/**
 * #1433, design note §2.6 line 20: "Measured and recorded on the issue (not
 * asserted in CI): page-turn latency before and after over a 20-page scan
 * (render vs kept), and 30 quick page turns during an upload check (the 6.8 s
 * probe from the round-3 review), both on CI's image."
 *
 * A measurement, not a check: it asserts only that each answer is a page
 * (status 200), never a time. Gated like the other measurements
 * (document-kek-rotation-measure, metadata-tier2-measure) behind
 * `ORBIT_MEASURE_KEPT_PREVIEWS=1`, and inside that through `popplerIt`
 * (skip outside CI without poppler; fail in CI without it):
 *
 *     ORBIT_MEASURE_KEPT_PREVIEWS=1 node scripts/test-integration.mjs
 *
 * The figures print as `[kept-previews-measure]` lines, and are also written
 * as JSON to `ORBIT_MEASURE_OUT` when that names a file, for the issue.
 *
 * "Render" is a page's first view before the worker reached it (drawn on
 * demand in the view pool); "kept" is the same page's next view, decrypted.
 * The worker is imported by path at run time (`runPreviewWorkerOnce`, the
 * name document-kept-previews.test.ts chooses), so this file type-checks today.
 */
import { writeFile } from "node:fs/promises";
import { afterAll, afterEach, describe, expect, vi } from "vitest";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { colourScanPdf, textPagesPdf } from "../support/pdf-measure/fixtures";
import { NEEDS_POPPLER, popplerIt } from "../support/poppler-sandbox";

const { GET: previewDocument } = await loadRoute("documents/[documentId]/preview");
const { POST: uploadDocument } = await loadRoute("households/[householdId]/items/[itemId]/documents");

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

afterEach(() => {
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;

const PREVIEW_JOBS_MODULE = "@/server/document-maintenance/preview-jobs";

async function drainPreviewWorker(limit = 50): Promise<void> {
  const worker = await import(/* @vite-ignore */ PREVIEW_JOBS_MODULE) as { runPreviewWorkerOnce(): Promise<unknown> };
  for (let round = 0; round < limit; round += 1) {
    if (!await worker.runPreviewWorkerOnce()) return;
  }
}

async function upload(fixture: Fixture, session: Session, bytes: Buffer, filename: string): Promise<{ status: number; documentId?: string }> {
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
  const response = await callRouteForSession(uploadDocument, session, {
    url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${fixture.item.id}/documents`,
    method: "POST",
    headers: { "content-length": String(bytes.length), "content-type": "application/pdf", "x-orbit-filename": encodeURIComponent(filename) },
    body: new Uint8Array(bytes),
    params: { householdId: fixture.household.id, itemId: fixture.item.id },
  });
  if (response.status !== 201) return { status: response.status };
  const payload = await response.json() as { document: { id: string } };
  return { status: response.status, documentId: payload.document.id };
}

/** One page view, timed from the request to the last byte. */
async function timedView(session: Session, documentId: string, page: number): Promise<number> {
  const started = performance.now();
  const response = await callRouteForSession(previewDocument, session, {
    url: `http://127.0.0.1:3000/api/documents/${documentId}/preview?page=${page}`,
    params: { documentId },
  });
  await response.arrayBuffer();
  const elapsed = performance.now() - started;
  expect(response.status, `page ${page}`).toBe(200);
  return elapsed;
}

function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
  return {
    count: sorted.length,
    medianMs: Math.round(at(0.5)),
    p90Ms: Math.round(at(0.9)),
    maxMs: Math.round(sorted.at(-1)!),
  };
}

const figures: Record<string, unknown> = {};

function record(label: string, value: unknown): void {
  figures[label] = value;
  console.log(`[kept-previews-measure] ${label}: ${JSON.stringify(value)}`);
}

describe.runIf(process.env.ORBIT_MEASURE_KEPT_PREVIEWS === "1")(`kept page previews, measured (#1433 §2.6 line 20) ${NEEDS_POPPLER}`, () => {
  afterAll(async () => {
    const out = process.env.ORBIT_MEASURE_OUT;
    if (out) await writeFile(out, `${JSON.stringify(figures, null, 2)}\n`);
  });

  popplerIt("line 20: page-turn latency over a 20-page scan, render (first view, drawn on demand) against kept (next view)", async () => {
    const fixture = await createIntegrationFixture("kept-previews-measure-scan");
    const session = await fixture.session("member");
    const { status, documentId } = await upload(fixture, session, colourScanPdf(300, 20), "twenty-page-scan.pdf");
    expect(status).toBe(201);

    const render: number[] = [];
    for (let page = 1; page <= 20; page += 1) render.push(await timedView(session, documentId!, page));
    const kept: number[] = [];
    for (let page = 1; page <= 20; page += 1) kept.push(await timedView(session, documentId!, page));

    record("20-page scan, render", summary(render));
    record("20-page scan, kept", summary(kept));
  }, 600_000);

  popplerIt("line 20: 30 quick page turns on a kept document while another upload's structure check runs (the 6.8 s probe)", async () => {
    const fixture = await createIntegrationFixture("kept-previews-measure-turns");
    const session = await fixture.session("member");
    const { status, documentId } = await upload(fixture, session, textPagesPdf(10), "ten-pages.pdf");
    expect(status).toBe(201);
    await drainPreviewWorker();

    // The upload's check runs in the check pool while the turns are asked;
    // its own result is recorded, not judged.
    const uploading = upload(fixture, session, colourScanPdf(600, 20), "busy-upload.pdf");
    const turns: number[] = [];
    for (let turn = 0; turn < 30; turn += 1) turns.push(await timedView(session, documentId!, (turn % 10) + 1));
    const busy = await uploading;

    record("30 quick turns during an upload check", { ...summary(turns), uploadStatus: busy.status });
  }, 600_000);
});
