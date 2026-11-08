import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentWriter } from "@/server/portable-archive-container";
import { v2Header, V2_SEGMENT_BYTES } from "../../tests/support/portable-archive-v2";

/**
 * #1390 review round, ruling 7 (low): the export's plaintext does not outlive
 * its use. The segment writer parks up to one segment of plaintext in a buffer
 * (`pending`) until the segment is sealed; if `push` throws, that buffer must
 * be zeroed, not left holding a megabyte of a household's documents for the
 * garbage collector to find.
 *
 * `pending` is private and the writer has no accessor, so the buffer is found
 * the only way a caller can: it is the one segment-sized buffer the writer
 * allocates when it is constructed. The test watches the allocation (the
 * public seam is `Buffer`), then reads what is in it after the failure.
 */
const S = V2_SEGMENT_BYTES;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Builds a writer and returns it with the segment-sized buffers allocated while it was constructed. */
function writerFor(plaintextBytes: number, write: (chunk: Buffer) => Promise<void>) {
  const allocated: Buffer[] = [];
  for (const name of ["alloc", "allocUnsafe", "allocUnsafeSlow"] as const) {
    const original = Buffer[name].bind(Buffer) as (size: number, ...rest: unknown[]) => Buffer;
    vi.spyOn(Buffer, name).mockImplementation(((size: number, ...rest: unknown[]) => {
      const made = original(size, ...rest);
      if (size === S) allocated.push(made);
      return made;
    }) as never);
  }
  const header = v2Header({ manifestBytes: Math.min(100, plaintextBytes), plaintextBytes });
  const writer = new SegmentWriter(header, randomBytes(32), write);
  vi.restoreAllMocks();
  expect(allocated, "the writer allocates one segment-sized buffer for its plaintext").toHaveLength(1);
  return { writer, pending: allocated[0] };
}

const isZero = (buffer: Buffer) => buffer.every((byte) => byte === 0);

describe("ruling 7: SegmentWriter zeroes the plaintext it parked when push throws", () => {
  it("zeroes pending when the write of a sealed segment throws (disk full, say), on a segment that is not the last", async () => {
    // Catches a writer that leaves a megabyte of plaintext in pending after a failed write.
    const plaintext = randomBytes(S).fill(0xab, 0, 4096);
    let seen: Buffer | null = null;
    const { writer, pending } = writerFor(2 * S, async () => {
      seen = Buffer.from(pending);
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    });
    await expect(writer.push(plaintext)).rejects.toThrow(/ENOSPC/u);
    expect(seen, "pending held the segment's plaintext when the write was attempted (the right buffer is being watched)").not.toBeNull();
    expect(Buffer.compare(seen!, plaintext)).toBe(0);
    expect(isZero(pending), "pending is zero after push threw").toBe(true);
  });

  it("zeroes pending when finish() finds the plaintext shorter than the header says", async () => {
    // Pins existing behaviour (finish zeroes on its shortfall error); it must stay when push's own path is fixed.
    const { writer, pending } = writerFor(2 * S, async () => undefined);
    await writer.push(randomBytes(1000).fill(0x7f, 0, 10));
    await expect(writer.finish()).rejects.toThrow();
    expect(isZero(pending)).toBe(true);
  });

  it("zeroes pending when the write of the last segment throws", async () => {
    // The last segment is sealed with the same buffer: a failed write there must not leave it either.
    const plaintext = randomBytes(300).fill(0x55, 0, 20);
    const { writer, pending } = writerFor(300, async () => { throw new Error("write failed"); });
    await expect(writer.push(plaintext)).rejects.toThrow(/write failed/u);
    expect(isZero(pending)).toBe(true);
  });

  it("keeps working for a later caller: a writer that did not throw still seals and its pending ends zero", async () => {
    // Pins existing behaviour (zero after the final segment) so the fix does not break the happy path.
    const written: Buffer[] = [];
    const { writer, pending } = writerFor(300, async (chunk) => { written.push(Buffer.from(chunk)); });
    await writer.push(randomBytes(300));
    await writer.finish();
    expect(written.length).toBeGreaterThan(0);
    expect(isZero(pending)).toBe(true);
  });
});
