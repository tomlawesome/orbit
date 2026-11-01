/**
 * Runs ONE portable-archive preview or import in a process of its own and
 * prints how far that operation raised the process's peak resident memory
 * (#1521). Spawned by tests/integration/portable-archive-stream-import.test.ts
 * through tsx, so the test runner's memory (and the seeding of the documents)
 * never counts.
 *
 * Arguments: <preview|import> <userId> <householdId> <archiveFile>
 * [<warmUpUserId> <warmUpHouseholdId>] (import only).
 * The archive file is the exported file as it comes from the download.
 *
 * #1566: the baseline is taken BEFORE anything of the file is read (garbage
 * collected, the kernel's peak counter reset), and the file is then streamed
 * from disk into the repository's stream-taking preview or import, as the
 * route hands it the upload's file part. So the figure counts everything the
 * operation holds of the archive, the request body included; #1521's child
 * parsed the file first and so never counted it.
 * With a warm-up target, the import runs twice, into the warm-up household
 * first; the second import is the pinned figure (see memory-child-support).
 * Prints one line: `MEMORY_RESULT {"beforeKiB":..,"afterKiB":..,"result":..}`.
 */
import { closeDatabase } from "@/db";
import { importPortableArchive, previewPortableImport } from "@/server/portable-archive-repository";
import { baselinePeakKiB, fileAsWebStream, peakKiB, prepareKeyState, printMemoryResult } from "./memory-child-support";

const [mode, userId, householdId, archiveFile, warmUpUserId, warmUpHouseholdId] = process.argv.slice(2);
if (
  (mode !== "preview" && mode !== "import")
  || !userId || !householdId || !archiveFile
  || (warmUpUserId === undefined) !== (warmUpHouseholdId === undefined)
  || (mode === "preview" && warmUpUserId !== undefined)
) {
  throw new Error("usage: archive-import-memory-child <preview|import> <userId> <householdId> <archiveFile> [<warmUpUserId> <warmUpHouseholdId>] (the warm-up pair is for import only)");
}

prepareKeyState();

async function main(): Promise<void> {
  const passphrase = "correct-horse-battery-staple";
  let beforeKiB = baselinePeakKiB();
  let first: { beforeKiB: number; afterKiB: number } | undefined;
  if (warmUpUserId !== undefined && warmUpHouseholdId !== undefined) {
    let warmUp: ReadableStream<Uint8Array> | undefined = fileAsWebStream(archiveFile);
    await importPortableArchive({ userId: warmUpUserId, householdId: warmUpHouseholdId, archive: warmUp, passphrase, conflictItemIds: [] });
    first = { beforeKiB, afterKiB: peakKiB() };
    warmUp = undefined;
    beforeKiB = baselinePeakKiB();
  }
  let archive: ReadableStream<Uint8Array> | undefined = fileAsWebStream(archiveFile);
  const result = mode === "preview"
    ? await previewPortableImport(userId, householdId, archive, passphrase)
    : await importPortableArchive({ userId, householdId, archive, passphrase, conflictItemIds: [] });
  const afterKiB = peakKiB();
  archive = undefined;
  await closeDatabase();
  printMemoryResult(beforeKiB, afterKiB, result, first);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
