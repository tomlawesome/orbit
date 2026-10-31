/**
 * Runs ONE ordinary document upload in a process of its own and prints how far
 * that upload raised the process's peak resident memory (#1567). Spawned by
 * tests/integration/document-upload-stream.test.ts through tsx, so the test
 * runner's memory never counts. Modelled on archive-import-memory-child.ts.
 *
 * Arguments: <userId> <householdId> <itemId> <file>.
 * The baseline is taken BEFORE any of the body is read (garbage collected, the
 * kernel's peak counter reset), and the file is then streamed from disk into
 * `uploadItemDocument` as a web stream, as the route hands it the request
 * body, so the figure counts everything the upload holds of the document.
 * Prints one line: `MEMORY_RESULT {"beforeKiB":..,"afterKiB":..,"result":..}`.
 */
import { statSync } from "node:fs";
import { closeDatabase } from "@/db";
import { uploadItemDocument } from "@/server/document-repository";
import { baselinePeakKiB, fileAsWebStream, peakKiB, prepareKeyState, printMemoryResult } from "./memory-child-support";

const [userId, householdId, itemId, file] = process.argv.slice(2);
if (!userId || !householdId || !itemId || !file) {
  throw new Error("usage: document-upload-memory-child <userId> <householdId> <itemId> <file>");
}

prepareKeyState();

async function main(): Promise<void> {
  const sizeBytes = statSync(file).size;
  const beforeKiB = baselinePeakKiB();
  let body: ReadableStream<Uint8Array> | null = fileAsWebStream(file);
  const document = await uploadItemDocument({
    userId,
    householdId,
    itemId,
    filename: "memory-child.pdf",
    body,
    declaredBytes: sizeBytes,
  });
  const afterKiB = peakKiB();
  body = null;
  await closeDatabase();
  const result = { id: document.id, lifecycle: document.lifecycle, sizeBytes: document.sizeBytes };
  printMemoryResult(beforeKiB, afterKiB, result);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
