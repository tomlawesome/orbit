/**
 * Runs TWO reads of one stored document in a process of its own and prints
 * how far the second raised the process's peak resident memory (#1571).
 * Spawned by tests/integration/document-read-memory.test.ts through tsx, so
 * the test runner's memory never counts. Modelled on
 * document-upload-memory-child.ts.
 *
 * Arguments: <mode> then the mode's own:
 * - `recovery <documentIdOne> <documentIdTwo>`: the scanner-recovery worker
 *   processes the two staged uploads the test has made due, one after the
 *   other. A fake clamd on a loopback port answers `stream: OK` (it reads
 *   `zINSTREAM\0` and the length-prefixed chunks and keeps none of them), and
 *   the child's configuration points at it in `required` scan mode. Both jobs
 *   are claimed before any baseline is taken. The fake clamd's received socket
 *   chunks are freed as they are counted, so the figure measures the server's
 *   own scan, with no collector-timed share from the receiver.
 * - `hold <file> <userId> <receiptId>`: two `scanAndHoldImapAttachment` runs of
 *   the file's bytes, which are read into memory BEFORE the baseline, as the
 *   mail parser's buffer already is when the attachment reaches the holding
 *   function.
 * (`download` and `preview-read` arrive with the download lane.)
 *
 * The baseline is taken after garbage collection with the kernel's peak
 * counter reset, before the first run, and again after it; the first run's
 * figures go in "first" and the second run is the pinned figure (see
 * memory-child-support).
 * Prints one line:
 * `MEMORY_RESULT {"first":{"beforeKiB":..,"afterKiB":..},"beforeKiB":..,"afterKiB":..,"result":..}`.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { inArray } from "drizzle-orm";
import { closeDatabase, getDb } from "@/db";
import { documents } from "@/db/schema";
import { claimScannerRecoveryJobs, processScannerRecoveryJob } from "@/server/document-maintenance/scan-recovery";
import { scanAndHoldImapAttachment } from "@/server/mail-in/imap-attachment-holding";
import { releaseBuffer } from "@/server/documents/storage";
import { baselinePeakKiB, peakKiB, prepareKeyState, printMemoryResult } from "./memory-child-support";

const [mode, ...rest] = process.argv.slice(2);
const usage = "usage: document-read-memory-child recovery <documentIdOne> <documentIdTwo> | hold <file> <userId> <receiptId>";
if (mode !== "recovery" && mode !== "hold") throw new Error(`unsupported mode ${String(mode)}; ${usage}`);
if (mode === "recovery" && (rest.length !== 2 || rest.some((value) => !value))) throw new Error(usage);
if (mode === "hold" && (rest.length !== 3 || rest.some((value) => !value))) throw new Error(usage);

/** A clamd that answers `stream: OK` to every INSTREAM and reports how many bytes each scan was given. */
async function startFakeClamd(): Promise<{ port: number; scannedBytes: number[]; close(): Promise<void> }> {
  const scannedBytes: number[] = [];
  const server: Server = createServer((socket) => {
    let command = Buffer.alloc(0);
    let commandDone = false;
    let header = Buffer.alloc(0);
    let remaining = 0;
    let scanned = 0;
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      try {
        let offset = 0;
        while (offset < chunk.length) {
          if (!commandDone) {
            const end = chunk.indexOf(0, offset);
            command = Buffer.concat([command, chunk.subarray(offset, end < 0 ? chunk.length : end)]);
            if (end < 0) return;
            if (command.toString("ascii") !== "zINSTREAM") {
              socket.destroy();
              return;
            }
            commandDone = true;
            offset = end + 1;
          } else if (remaining > 0) {
            const take = Math.min(remaining, chunk.length - offset);
            remaining -= take;
            scanned += take;
            offset += take;
          } else {
            const take = Math.min(4 - header.length, chunk.length - offset);
            header = Buffer.concat([header, chunk.subarray(offset, offset + take)]);
            offset += take;
            if (header.length === 4) {
              remaining = header.readUInt32BE(0);
              header = Buffer.alloc(0);
              if (remaining === 0) {
                scannedBytes.push(scanned);
                socket.end(Buffer.from("stream: OK\0", "ascii"));
                return;
              }
            }
          }
        }
      } finally {
        releaseBuffer(chunk);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the fake clamd has no port");
  return { port: address.port, scannedBytes, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function recovery(documentIds: string[]): Promise<void> {
  const clamd = await startFakeClamd();
  process.env.DOCUMENT_SCAN_MODE = "required";
  process.env.CLAMAV_HOST = "127.0.0.1";
  process.env.CLAMAV_PORT = String(clamd.port);
  prepareKeyState();

  const jobs = await claimScannerRecoveryJobs(2);
  if (jobs.length !== 2 || jobs.some((job) => !documentIds.includes(job.documentId))) {
    throw new Error(`claimed ${JSON.stringify(jobs.map((job) => job.documentId))}, expected exactly ${JSON.stringify(documentIds)}`);
  }
  const firstBeforeKiB = baselinePeakKiB();
  await processScannerRecoveryJob(jobs[0]!);
  const first = { beforeKiB: firstBeforeKiB, afterKiB: peakKiB() };
  const beforeKiB = baselinePeakKiB();
  await processScannerRecoveryJob(jobs[1]!);
  const afterKiB = peakKiB();

  const rows = await getDb().select({ id: documents.id, lifecycle: documents.lifecycle, failureCode: documents.failureCode })
    .from(documents).where(inArray(documents.id, documentIds));
  await clamd.close();
  await closeDatabase();
  printMemoryResult(beforeKiB, afterKiB, { documents: rows, scannedBytes: clamd.scannedBytes }, first);
}

async function hold(file: string, userId: string, receiptId: string): Promise<void> {
  // Allocated before the baseline: the parser's buffer is not the holding path's to avoid.
  const bytes = readFileSync(file);
  prepareKeyState();
  const hold = (filename: string) => scanAndHoldImapAttachment({
    bytes,
    filename,
    declaredMediaType: "application/pdf",
    recipientUserId: userId,
    receiptId,
  });

  const firstBeforeKiB = baselinePeakKiB();
  await hold("warm-up.pdf");
  const first = { beforeKiB: firstBeforeKiB, afterKiB: peakKiB() };
  const beforeKiB = baselinePeakKiB();
  const held = await hold("memory-child.pdf");
  const afterKiB = peakKiB();
  await closeDatabase();
  printMemoryResult(beforeKiB, afterKiB, { sizeBytes: held.sizeBytes, ciphertextSize: held.ciphertextSize, contentLength: bytes.length }, first);
}

async function main(): Promise<void> {
  if (mode === "recovery") await recovery(rest);
  else await hold(rest[0]!, rest[1]!, rest[2]!);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
