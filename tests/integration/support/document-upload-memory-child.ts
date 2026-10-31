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
import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { closeDatabase } from "@/db";
import { uploadItemDocument } from "@/server/document-repository";
import { getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { setKeyStateForTests } from "@/server/key-state";

const [userId, householdId, itemId, file] = process.argv.slice(2);
if (!userId || !householdId || !itemId || !file) {
  throw new Error("usage: document-upload-memory-child <userId> <householdId> <itemId> <file>");
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
  const sizeBytes = statSync(file).size;
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;
  collect();
  writeFileSync("/proc/self/clear_refs", "5");
  const beforeKiB = peakKiB();
  let body: ReadableStream<Uint8Array> | null = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>;
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
  console.log(`MEMORY_RESULT ${JSON.stringify({ beforeKiB, afterKiB, result })}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
