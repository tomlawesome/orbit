/**
 * Runs ONE portable-archive preview or import in a process of its own and
 * prints how far that operation raised the process's peak resident memory
 * (#1521). Spawned by tests/integration/portable-archive-stream-import.test.ts
 * through tsx, so the test runner's memory (and the seeding of the documents)
 * never counts.
 *
 * Arguments: <preview|import> <userId> <householdId> <archiveFile>.
 * The archive file is the exported file as it comes from the download.
 *
 * #1566: the baseline is taken BEFORE anything of the file is read (garbage
 * collected, the kernel's peak counter reset), and the file is then streamed
 * from disk into the repository's stream-taking preview or import, as the
 * route hands it the upload's file part. So the figure counts everything the
 * operation holds of the archive, the request body included; #1521's child
 * parsed the file first and so never counted it.
 * Prints one line: `MEMORY_RESULT {"beforeKiB":..,"afterKiB":..,"result":..}`.
 */
import { closeDatabase } from "@/db";
import { importPortableArchive, previewPortableImport } from "@/server/portable-archive-repository";
import { baselinePeakKiB, fileAsWebStream, peakKiB, prepareKeyState, printMemoryResult } from "./memory-child-support";

const [mode, userId, householdId, archiveFile] = process.argv.slice(2);
if ((mode !== "preview" && mode !== "import") || !userId || !householdId || !archiveFile) {
  throw new Error("usage: archive-import-memory-child <preview|import> <userId> <householdId> <archiveFile>");
}

prepareKeyState();

async function main(): Promise<void> {
  const passphrase = "correct-horse-battery-staple";
  const beforeKiB = baselinePeakKiB();
  let archive: ReadableStream<Uint8Array> | undefined = fileAsWebStream(archiveFile);
  const result = mode === "preview"
    ? await previewPortableImport(userId, householdId, archive, passphrase)
    : await importPortableArchive({ userId, householdId, archive, passphrase, conflictItemIds: [] });
  const afterKiB = peakKiB();
  archive = undefined;
  await closeDatabase();
  printMemoryResult(beforeKiB, afterKiB, result);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
