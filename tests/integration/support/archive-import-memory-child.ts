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
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { closeDatabase } from "@/db";
import { getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { setKeyStateForTests } from "@/server/key-state";
import { importPortableArchive, previewPortableImport } from "@/server/portable-archive-repository";

const [mode, userId, householdId, archiveFile] = process.argv.slice(2);
if ((mode !== "preview" && mode !== "import") || !userId || !householdId || !archiveFile) {
  throw new Error("usage: archive-import-memory-child <preview|import> <userId> <householdId> <archiveFile>");
}

resetDocumentConfigForTests();
setKeyStateForTests({ verdict: "usable", heldKeyId: getDocumentConfig().keyId });

/** Peak resident memory (KiB) since the last reset, from the kernel. */
function peakKiB(): number {
  const match = /VmHWM:\s+(\d+)/u.exec(readFileSync("/proc/self/status", "utf8"));
  if (!match) throw new Error("VmHWM is not readable");
  return Number(match[1]);
}

async function main(): Promise<void> {
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;
  const passphrase = "correct-horse-battery-staple";
  collect();
  writeFileSync("/proc/self/clear_refs", "5");
  const beforeKiB = peakKiB();
  let archive: ReadableStream<Uint8Array> | undefined = Readable.toWeb(createReadStream(archiveFile)) as unknown as ReadableStream<Uint8Array>;
  const result = mode === "preview"
    ? await previewPortableImport(userId, householdId, archive, passphrase)
    : await importPortableArchive({ userId, householdId, archive, passphrase, conflictItemIds: [] });
  const afterKiB = peakKiB();
  archive = undefined;
  await closeDatabase();
  console.log(`MEMORY_RESULT ${JSON.stringify({ beforeKiB, afterKiB, result })}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
