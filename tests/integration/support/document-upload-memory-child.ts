/**
 * Runs ordinary document uploads of the same file (one cold, then several warm) in a process of its own
 * and prints how far the least-growing warm upload raised the process's peak resident memory
 * (#1567). Spawned by
 * tests/integration/document-upload-stream.test.ts through tsx, so the test
 * runner's memory never counts. Modelled on archive-import-memory-child.ts.
 *
 * Arguments: <userId> <householdId> <itemId> <file>. The upload's filename takes
 * the file's extension (#1572: the same child measures an image).
 * The baseline is taken BEFORE any of the body is read (garbage collected, the
 * kernel's peak counter reset), and the file is then streamed from disk into
 * `uploadItemDocument` as a web stream, as the route hands it the request
 * body, so the figure counts everything the upload holds of the document.
 * The first upload after start pays, besides the document's one check copy, a
 * working set glibc keeps resident from the body stream's freed chunks (20-50
 * MiB at the size limit); every later upload reuses it. The second upload is
 * therefore the per-upload figure and the one the test pins; the first is
 * reported.
 * Prints one line:
 * `MEMORY_RESULT {"first":{"beforeKiB":..,"afterKiB":..},"beforeKiB":..,"afterKiB":..,"result":..}`.
 */
import { statSync } from "node:fs";
import { extname } from "node:path";
import { closeDatabase } from "@/db";
import { uploadItemDocument } from "@/server/document-repository";
import { baselinePeakKiB, fileAsWebStream, peakKiB, prepareKeyState, printMemoryResult } from "./memory-child-support";

const [userId, householdId, itemId, file] = process.argv.slice(2);
if (!userId || !householdId || !itemId || !file) {
  throw new Error("usage: document-upload-memory-child <userId> <householdId> <itemId> <file>");
}

prepareKeyState();

/** Warm uploads after the first; the smallest growth is the figure pinned. */
const WARM_UPLOADS = 4;

/** The upload's name carries the file's own extension (.pdf, .jpg), as a real client's would. */
const extension = extname(file) || ".pdf";

async function main(): Promise<void> {
  const sizeBytes = statSync(file).size;
  const firstBeforeKiB = baselinePeakKiB();
  let body: ReadableStream<Uint8Array> | null = fileAsWebStream(file);
  await uploadItemDocument({
    userId,
    householdId,
    itemId,
    filename: `warm-up${extension}`,
    body,
    declaredBytes: sizeBytes,
  });
  const first = { beforeKiB: firstBeforeKiB, afterKiB: peakKiB() };
  body = null;
  // Several warm uploads, not one (#1920): glibc sometimes keeps freed stream
  // chunks and one sample then reads 62-77 MiB where the usual figure is about
  // 49 MiB. The least growth is reported as the warm figure; the others are listed.
  const warm: { beforeKiB: number; afterKiB: number }[] = [];
  let document: Awaited<ReturnType<typeof uploadItemDocument>> | undefined;
  for (let run = 0; run < WARM_UPLOADS; run += 1) {
    const warmBeforeKiB = baselinePeakKiB();
    body = fileAsWebStream(file);
    document = await uploadItemDocument({
      userId,
      householdId,
      itemId,
      filename: `memory-child${extension}`,
      body,
      declaredBytes: sizeBytes,
    });
    warm.push({ beforeKiB: warmBeforeKiB, afterKiB: peakKiB() });
    body = null;
  }
  const least = warm.reduce((a, b) => (b.afterKiB - b.beforeKiB < a.afterKiB - a.beforeKiB ? b : a));
  const { beforeKiB, afterKiB } = least;
  await closeDatabase();
  const result = { id: document!.id, lifecycle: document!.lifecycle, sizeBytes: document!.sizeBytes };
  printMemoryResult(beforeKiB, afterKiB, result, first, warm);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
