/**
 * The part the integration memory children share (document-upload-memory-child.ts,
 * archive-import-memory-child.ts): usable key state, a peak-memory baseline
 * taken before any of the input is read, and the one result line the spawning
 * test parses. Each child is spawned through tsx so the test runner's memory
 * never counts.
 *
 * A child that measures a steady state runs its operation twice: the first
 * run's figures go in "first", the baseline is retaken after it (collected,
 * peak counter reset), and the second run is the pinned figure.
 */
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { setKeyStateForTests } from "@/server/key-state";

/** The document key is held and usable, as it is in the running server. */
export function prepareKeyState(): void {
  resetDocumentConfigForTests();
  setKeyStateForTests({ verdict: "usable", heldKeyId: getDocumentConfig().keyId });
}

/** Peak resident memory (KiB) since the last reset, from the kernel. */
export function peakKiB(): number {
  const match = /VmHWM:\s+(\d+)/u.exec(readFileSync("/proc/self/status", "utf8"));
  if (!match) throw new Error("VmHWM is not readable");
  return Number(match[1]);
}

/** Garbage collects, resets the kernel's peak counter, and returns the baseline peak (KiB). */
export function baselinePeakKiB(): number {
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;
  collect();
  writeFileSync("/proc/self/clear_refs", "5");
  return peakKiB();
}

/** The file as a web stream, as the route hands the repository a request body. */
export function fileAsWebStream(path: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
}

export function printMemoryResult(
  beforeKiB: number,
  afterKiB: number,
  result: unknown,
  first?: { beforeKiB: number; afterKiB: number },
): void {
  console.log(`MEMORY_RESULT ${JSON.stringify({ ...(first ? { first } : {}), beforeKiB, afterKiB, result })}`);
}
