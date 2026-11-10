/**
 * #1390 (design note §4 line 13): seals a small manifest plus one body of
 * <bodyBytes> zeros, produced on demand (no fixture, no disk), with the v2
 * SegmentWriter, into an in-process pipe that a SegmentReader drains into a
 * counting, hashing sink. Prints how far that raised the process's peak
 * resident memory. Spawned by src/server/portable-archive-container.test.ts
 * through tsx, so the test runner's memory never counts.
 *
 * Arguments: <bodyBytes>. Prints one line:
 * `MEMORY_RESULT {"beforeKiB":..,"afterKiB":..,"result":{"bodyBytes":..,"sha256":..}}`.
 */
import { createHash, randomBytes } from "node:crypto";
import { baselinePeakKiB, peakKiB, printMemoryResult } from "../integration/support/memory-child-support";
import { loadContainer, V2_HEADER_BYTES, V2_SEGMENT_BYTES, v2Header } from "./portable-archive-v2";

const bodyBytes = Number(process.argv[2]);
if (!Number.isSafeInteger(bodyBytes) || bodyBytes <= 0) throw new Error("usage: archive-container-memory-child <bodyBytes>");

const passphrase = "correct-horse-battery-staple";

async function main(): Promise<void> {
  const { deriveArchiveKey, SegmentReader, SegmentWriter } = await loadContainer();
  const manifest = Buffer.from(JSON.stringify({ format: "orbit-portable-archive", version: 2, body: [{ id: "zeros", sizeBytes: bodyBytes }] }));
  const salt = randomBytes(16);
  const header = v2Header({ salt, manifestBytes: manifest.length, plaintextBytes: manifest.length + bodyBytes });
  const key = await deriveArchiveKey(passphrase, salt, { N: 16_384, r: 8, p: 1 });
  const zeros = Buffer.alloc(V2_SEGMENT_BYTES);

  const beforeKiB = baselinePeakKiB();

  // The pipe: the writer's output is the reader's upload, with backpressure (one chunk in flight).
  const pipe = new TransformStream<Uint8Array, Uint8Array>(undefined, { highWaterMark: 1 }, { highWaterMark: 1 });
  const sink = pipe.writable.getWriter();
  let headerSeen = false;
  const produce = async () => {
    await sink.write(new Uint8Array(header));
    const writer = new SegmentWriter(header, key, async (chunk: Uint8Array) => {
      // A writer that emits the header itself: it was already sent once.
      if (!headerSeen && chunk.length === V2_HEADER_BYTES && Buffer.from(chunk).equals(header)) { headerSeen = true; return; }
      headerSeen = true;
      await sink.write(chunk);
    });
    await writer.push(manifest);
    for (let sent = 0; sent < bodyBytes; sent += zeros.length) await writer.push(zeros.subarray(0, Math.min(zeros.length, bodyBytes - sent)));
    await writer.finish();
    await sink.close();
  };

  const consume = async () => {
    const reader = await SegmentReader.open(pipe.readable, passphrase, 2 * bodyBytes);
    for (const [length, hash] of [[manifest.length, null], [bodyBytes, createHash("sha256")]] as const) {
      let count = 0;
      const stream = reader.take(length).getReader();
      for (;;) {
        const { done, value } = await stream.read();
        if (done) break;
        count += value.length;
        hash?.update(value);
      }
      if (hash) return { count, sha256: hash.digest("hex"), reader };
    }
    throw new Error("unreachable");
  };

  const [, consumed] = await Promise.all([produce(), consume()]);
  await consumed.reader.finish();
  const afterKiB = peakKiB();
  printMemoryResult(beforeKiB, afterKiB, { bodyBytes: consumed.count, sha256: consumed.sha256 });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
