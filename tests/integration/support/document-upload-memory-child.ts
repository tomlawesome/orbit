/**
 * Runs TWO ordinary document uploads of the same file in a process of its own
 * and prints how far the second raised the process's peak resident memory
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
  const beforeKiB = baselinePeakKiB();
  body = fileAsWebStream(file);
  const document = await uploadItemDocument({
    userId,
    householdId,
    itemId,
    filename: `memory-child${extension}`,
    body,
    declaredBytes: sizeBytes,
  });
  const afterKiB = peakKiB();
  body = null;
  await closeDatabase();
  const result = { id: document.id, lifecycle: document.lifecycle, sizeBytes: document.sizeBytes };
  printMemoryResult(beforeKiB, afterKiB, result, first);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
