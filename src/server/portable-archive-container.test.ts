import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openV2,
  readV2Header,
  sealV2,
  segmentCount,
  segmentRange,
  v2FileBytes,
  v2Header,
  V2_HEADER_BYTES,
  V2_MAX_MANIFEST_BYTES,
  V2_SEGMENT_BYTES,
  loadContainer,
  type ContainerApi,
  type V2HeaderFields,
} from "../../tests/support/portable-archive-v2";
import { KDF_TEST_TIMEOUT_MS } from "../../scripts/process-budget.mjs";

/**
 * #1390 (design note §4, unit lines 1-7, 10 and 13; ADR-0045): the v2
 * container, `src/server/portable-archive-container.ts`, crypto only, no
 * database. Written from the specification alone, before the module exists.
 *
 * Files the reader is given are sealed by hand from the byte layout
 * (tests/support/portable-archive-v2.ts), and what the product's
 * SegmentWriter writes is opened by hand, so the two halves cannot agree
 * with each other by construction.
 *
 * API shapes the note leaves open, decided here (the builder matches or says why not):
 *  - `SegmentReader.open(source, passphrase, ceiling)` takes the upload as a
 *    `ReadableStream<Uint8Array>`; `ceiling` is the archive ceiling in bytes,
 *    checked against T before scrypt.
 *  - `SegmentWriter(header, key, write)`: `header` is the 64 header bytes
 *    (they are the AAD), `key` the 32-byte key from
 *    `deriveArchiveKey(passphrase, salt, { N, r, p })`, `write` an async sink.
 *  - Refusals are AppErrors: `archive_invalid` (422) for a malformed file,
 *    `archive_passphrase_invalid` (422) for a segment whose tag fails.
 */
vi.setConfig({ testTimeout: KDF_TEST_TIMEOUT_MS * 4 });

const crypto = vi.hoisted(() => ({ boost: false, scryptCalls: 0, scryptSyncCalls: 0 }));

/**
 * Every scrypt call is counted. With `boost` on, the cost is raised to about
 * a second (log2 N 18) for both forms, so a synchronous derivation is seen
 * blocking the event loop (line 10); the key is then wrong, which line 10
 * does not care about.
 */
function mockCrypto(actual: typeof import("node:crypto")) {
  const boosted = (options: Record<string, unknown> | undefined) =>
    crypto.boost ? { ...options, N: 2 ** 18, maxmem: 512 * 1_048_576 } : options;
  const scrypt = (...args: unknown[]) => {
    crypto.scryptCalls += 1;
    if (typeof args[3] === "function") return actual.scrypt(args[0] as never, args[1] as never, args[2] as never, boosted(args[3] as never) as never, args[4] as never);
    if (typeof args[3] === "object") return actual.scrypt(args[0] as never, args[1] as never, args[2] as never, boosted(args[3] as never) as never, args[4] as never);
    return actual.scrypt(args[0] as never, args[1] as never, args[2] as never, args[3] as never);
  };
  const scryptSync = (...args: unknown[]) => {
    crypto.scryptSyncCalls += 1;
    return actual.scryptSync(args[0] as never, args[1] as never, args[2] as never, boosted(args[3] as never) as never);
  };
  return { ...actual, scrypt, scryptSync, default: { ...actual, scrypt, scryptSync } };
}

vi.mock("node:crypto", async (importOriginal) => mockCrypto(await importOriginal<typeof import("node:crypto")>()));
vi.mock("crypto", async (importOriginal) => mockCrypto(await importOriginal<typeof import("node:crypto")>()));

// The module under test does not exist before #1390 is built; every test that needs it then fails on the load.
let loaded: ContainerApi | undefined;
let loadError: unknown;
beforeAll(async () => {
  try { loaded = await loadContainer(); } catch (error) { loadError = error; }
});
function api(): ContainerApi {
  if (!loaded) throw loadError instanceof Error ? loadError : new Error(String(loadError));
  return loaded;
}

const passphrase = "correct-horse-battery-staple";
const S = V2_SEGMENT_BYTES;
const MIB = 1_048_576;
const CEILING = 64 * MIB;

let sandbox = "";
let savedTmpdir: string | undefined;

beforeAll(() => {
  savedTmpdir = process.env.TMPDIR;
  sandbox = mkdtempSync(join(tmpdir(), "orbit-1390-container-"));
  process.env.TMPDIR = sandbox;
});

afterAll(() => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  crypto.boost = false;
  crypto.scryptCalls = 0;
  crypto.scryptSyncCalls = 0;
});

/** `bytes` as an upload stream in 64 KiB pieces, pulled on demand. */
function streamOf(bytes: Buffer, chunk = 65_536): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + chunk)));
      offset += chunk;
    },
  }, { highWaterMark: 0 });
}

/** Everything a `take` stream hands on, into `sink`, until it ends or errors. */
async function drainInto(stream: ReadableStream<Uint8Array>, sink: Buffer[]): Promise<void> {
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    sink.push(Buffer.from(value));
  }
}

/**
 * Opens `file`, takes the manifest and then the rest as one body, then
 * finishes: what the reader handed on, and the first refusal, if any.
 */
async function consume(file: Buffer, secret = passphrase, ceiling = CEILING): Promise<{ received: Buffer; error: unknown }> {
  const sink: Buffer[] = [];
  let error: unknown;
  try {
    const header = readV2Header(file);
    // Only the reader's own derivations count (building the file used scryptSync).
    crypto.scryptCalls = 0;
    crypto.scryptSyncCalls = 0;
    const reader = await api().SegmentReader.open(streamOf(file), secret, ceiling);
    await drainInto(reader.take(header.manifestBytes), sink);
    await drainInto(reader.take(header.plaintextBytes - header.manifestBytes), sink);
    await reader.finish();
  } catch (caught) {
    error = caught;
  }
  return { received: Buffer.concat(sink), error };
}

/** A plaintext of `bytes` whose every segment is distinguishable. */
function plaintextOf(bytes: number): Buffer {
  const plaintext = randomBytes(bytes);
  for (let index = 0; index * S < bytes; index += 1) plaintext.writeUInt32BE(index, index * S);
  return plaintext;
}

// ---------------------------------------------------------------------------

describe("§4 line 1: a malformed header is refused as archive_invalid before scrypt runs", () => {
  const manifestBytes = 1_000;
  const plaintextBytes = 3 * S + 7;
  const plaintext = plaintextOf(plaintextBytes);

  /** A file whose segments are real, under a header with `fields` changed. */
  const withHeader = (fields: Partial<V2HeaderFields> & { manifestBytes?: number; plaintextBytes?: number }) => {
    const good = sealV2(plaintext, passphrase, { manifestBytes });
    const header = v2Header({ ...readV2Header(good), manifestBytes, plaintextBytes, ...fields });
    return Buffer.concat([header, good.subarray(V2_HEADER_BYTES)]);
  };

  const refusals: Array<[string, () => Buffer, number?]> = [
    ["the wrong magic", () => withHeader({ magic: Buffer.from("ORBITARX", "ascii") })],
    ["version 1", () => withHeader({ version: 1 })],
    ["version 3", () => withHeader({ version: 3 })],
    ["kdf 0", () => withHeader({ kdf: 0 })],
    ["kdf 2", () => withHeader({ kdf: 2 })],
    ["scrypt log2 N 21", () => withHeader({ log2N: 21 })],
    ["scrypt r 9", () => withHeader({ r: 9 })],
    ["a segment size of 1 MiB - 1", () => withHeader({ segmentBytes: S - 1 })],
    ["a segment size of 1 MiB + 1", () => withHeader({ segmentBytes: S + 1 })],
    ["a segment size of 64 KiB", () => withHeader({ segmentBytes: 65_536 })],
    ["a manifest over 64 MiB", () => withHeader({ manifestBytes: V2_MAX_MANIFEST_BYTES + 1, plaintextBytes: V2_MAX_MANIFEST_BYTES + 2 }), 2 * V2_MAX_MANIFEST_BYTES],
    ["a manifest longer than the plaintext (M > T)", () => withHeader({ manifestBytes: plaintextBytes + 1 })],
    ["a plaintext past Number.MAX_SAFE_INTEGER", () => withHeader({ plaintextBytes: Number.MAX_SAFE_INTEGER + 1 })],
    ["a zero plaintext (T = 0)", () => withHeader({ manifestBytes: 0, plaintextBytes: 0 })],
  ];

  it("control: the same file with its own header opens, and scrypt runs once", async () => {
    // Catches a refusal list that refuses everything: the cases below must come from the changed field.
    const { received, error } = await consume(withHeader({}));
    expect(error).toBeUndefined();
    expect(received.equals(plaintext)).toBe(true);
    expect(crypto.scryptCalls + crypto.scryptSyncCalls).toBe(1);
  });

  it.each(refusals)("refuses %s as archive_invalid without calling crypto.scrypt", async (_label, file, ceiling) => {
    // Catches a header checked only after key derivation (#1605 W-Q1 for v2), or a missing bound.
    const { received, error } = await consume(file(), passphrase, ceiling ?? CEILING);
    expect(error).toMatchObject({ code: "archive_invalid", status: 422 });
    expect(crypto.scryptCalls, "crypto.scrypt calls").toBe(0);
    expect(crypto.scryptSyncCalls, "crypto.scryptSync calls").toBe(0);
    expect(received.length).toBe(0);
  });

  it("refuses a plaintext over the ceiling as 413 archive_over_quota (#1799) naming the limit, without calling crypto.scrypt", async () => {
    // Catches the header's size check answering "not a supported Orbit archive" for an honest archive, or running after key derivation.
    const { received, error } = await consume(withHeader({ plaintextBytes: CEILING + 1 }));
    expect(error).toMatchObject({ code: "archive_over_quota", status: 413 });
    expect((error as Error).message).toMatch(/raise/iu);
    expect((error as Error).message).toMatch(/storage limit/iu);
    expect(crypto.scryptCalls, "crypto.scrypt calls").toBe(0);
    expect(crypto.scryptSyncCalls, "crypto.scryptSync calls").toBe(0);
    expect(received.length).toBe(0);
  });

  it.each([
    ["scrypt p 6 (over the cap of 5)", () => withHeader({ p: 6 })],
    ["log2 N 20, r 8, p 1 (1 GiB, over the memory limit)", () => withHeader({ log2N: 20, p: 1 })],
  ] as Array<[string, () => Buffer]>)("refuses %s as a 400 archive_invalid without calling crypto.scrypt", async (_label, file) => {
    // Catches a cost over the cap reaching scrypt (a 500 from its memory check) or answered as a corrupt file.
    const { received, error } = await consume(file(), passphrase, CEILING);
    expect(error).toMatchObject({ code: "archive_invalid", status: 400 });
    expect(crypto.scryptCalls + crypto.scryptSyncCalls).toBe(0);
    expect(received.length).toBe(0);
  });

  it.each([
    ["a manifest of exactly 64 MiB", () => withHeader({ manifestBytes: V2_MAX_MANIFEST_BYTES, plaintextBytes: V2_MAX_MANIFEST_BYTES }), 2 * V2_MAX_MANIFEST_BYTES],
    ["a plaintext of exactly the ceiling", () => withHeader({ plaintextBytes: CEILING }), CEILING],
    ["scrypt p 2", () => withHeader({ p: 2 }), CEILING],
    ["scrypt p 5 (the largest allowed)", () => withHeader({ p: 5 }), CEILING],
  ] as Array<[string, () => Buffer, number]>)("lets %s through to key derivation (the bounds are inclusive)", async (_label, file, ceiling) => {
    // Catches an off-by-one bound. The segments no longer match these headers, so the open fails later; the point is that scrypt ran.
    await consume(file(), passphrase, ceiling);
    expect(crypto.scryptCalls + crypto.scryptSyncCalls).toBe(1);
  });
});

describe("§4 line 2: manifest and bodies seal and open to identical bytes, split at every segment boundary", () => {
  const bodySizes = [1, S - 1, S, S + 1, 3 * S + 7];

  async function sealWithWriter(plaintext: Buffer, manifestBytes: number, pieceSizes: number[]): Promise<Buffer> {
    const salt = randomBytes(16);
    const header = v2Header({ salt, manifestBytes, plaintextBytes: plaintext.length });
    const key = await api().deriveArchiveKey(passphrase, salt, { N: 16_384, r: 8, p: 1 });
    const written: Buffer[] = [header];
    const { SegmentWriter } = api();
    const writer = new SegmentWriter(header, key, async (chunk: Uint8Array) => { written.push(Buffer.from(chunk)); });
    let offset = 0;
    for (let turn = 0; offset < plaintext.length; turn += 1) {
      const size = pieceSizes[turn % pieceSizes.length];
      await writer.push(plaintext.subarray(offset, offset + size));
      offset += size;
    }
    await writer.finish();
    const file = Buffer.concat(written);
    // The writer may or may not emit the header itself; the file is the header once, then the segments.
    return file.subarray(0, 2 * V2_HEADER_BYTES).equals(Buffer.concat([header, header])) ? file.subarray(V2_HEADER_BYTES) : file;
  }

  const manifest = Buffer.from(JSON.stringify({ format: "orbit-portable-archive", version: 2, body: bodySizes.map((size, index) => ({ id: `${index}`, sizeBytes: size })) }));
  const bodies = bodySizes.map((size) => randomBytes(size));
  const plaintext = Buffer.concat([manifest, ...bodies]);

  it.each([
    ["one push per body", [manifest.length, ...bodySizes]],
    ["pushes that straddle every boundary (1, S - 1, S + 1, 7, 64 KiB + 1)", [1, S - 1, S + 1, 7, 65_537]],
  ])("SegmentWriter's file, %s, is 64 + T + 16 n bytes and opens by hand to the plaintext", async (_label, pieces) => {
    // Catches a writer whose segments are not exactly S bytes, whose nonce or AAD differ from the layout, or which drops a carry between pushes.
    const file = await sealWithWriter(plaintext, manifest.length, pieces as number[]);
    expect(file.length).toBe(v2FileBytes(plaintext.length));
    expect(openV2(file, passphrase).equals(plaintext)).toBe(true);
  });

  it("SegmentReader hands on the manifest and each body exactly, from a writer's file and from a hand-sealed one", async () => {
    // Catches a reader that loses or repeats bytes where a take() ends inside a segment or exactly on its edge.
    for (const file of [await sealWithWriter(plaintext, manifest.length, [65_537]), sealV2(plaintext, passphrase, { manifestBytes: manifest.length })]) {
      const reader = await api().SegmentReader.open(streamOf(file, 4_093), passphrase, CEILING);
      const gotManifest: Buffer[] = [];
      await drainInto(reader.take(manifest.length), gotManifest);
      expect(Buffer.concat(gotManifest).equals(manifest)).toBe(true);
      for (const [index, body] of bodies.entries()) {
        const got: Buffer[] = [];
        await drainInto(reader.take(body.length), got);
        expect(Buffer.concat(got).equals(body), `body ${index} (${body.length} bytes)`).toBe(true);
      }
      await expect(reader.finish()).resolves.toBeUndefined();
    }
  });
});

describe("§4 line 3: two segments swapped are refused at the first swapped one, and nothing after it is handed on", () => {
  it("refuses with archive_passphrase_invalid having handed on exactly segment 0", async () => {
    // Catches a nonce without the counter (the swap would verify), or a reader that hands on bytes before their tag.
    const plaintext = plaintextOf(3 * S + 7);
    const file = sealV2(plaintext, passphrase, { manifestBytes: 100 });
    const one = segmentRange(plaintext.length, 1);
    const two = segmentRange(plaintext.length, 2);
    const swapped = Buffer.concat([file.subarray(0, one.start), file.subarray(two.start, two.end), file.subarray(one.start, one.end), file.subarray(two.end)]);

    const control = await consume(file);
    expect(control.error).toBeUndefined();

    const { received, error } = await consume(swapped);
    expect(error).toMatchObject({ code: "archive_passphrase_invalid", status: 422 });
    expect(received.length).toBe(S);
    expect(received.equals(plaintext.subarray(0, S))).toBe(true);
  });
});

describe("§4 line 4: truncation and trailing bytes are refused; only whole verified segments leave the reader", () => {
  const plaintext = plaintextOf(3 * S + 7);
  const file = sealV2(plaintext, passphrase, { manifestBytes: 100 });
  const last = segmentRange(plaintext.length, segmentCount(plaintext.length) - 1);
  const one = segmentRange(plaintext.length, 1);

  const cases: Array<[string, Buffer, string[]]> = [
    ["the last segment removed", file.subarray(0, last.start), ["archive_invalid"]],
    ["one byte after the final segment", Buffer.concat([file, Buffer.from([0])]), ["archive_invalid"]],
    ["a non-final segment one byte short", Buffer.concat([file.subarray(0, one.end - 1), file.subarray(one.end)]), ["archive_invalid", "archive_passphrase_invalid"]],
  ];

  it.each(cases)("refuses %s", async (_label, tampered, codes) => {
    // Catches a reader that treats EOF as the end (no final flag check), ignores trailing bytes, or accepts a short segment.
    const { received, error } = await consume(tampered);
    expect(error).toMatchObject({ status: 422 });
    expect(codes).toContain((error as { code?: string }).code);
    // What was handed on is a prefix of the plaintext made of whole segments (or all of it, for the trailing byte).
    expect(plaintext.subarray(0, received.length).equals(received)).toBe(true);
    expect(received.length === plaintext.length || received.length % S === 0, `${received.length} bytes is not whole segments`).toBe(true);
  });
});

describe("§4 line 5: a changed header, ciphertext or tag byte fails exactly the segment it is in", () => {
  const plaintext = plaintextOf(4 * S + 11);
  const file = sealV2(plaintext, passphrase, { manifestBytes: 100 });
  const flip = (at: number) => { const copy = Buffer.from(file); copy[at] ^= 0x01; return copy; };

  it.each([
    ["a salt byte (13)", 13],
    ["a nonce-prefix byte (30)", 30],
    ["a reserved byte (60), which the reader otherwise ignores", 60],
  ])("a changed header byte, %s, fails segment 0: nothing is handed on", async (_label, at) => {
    // Catches a header that is not the AAD (the reserved byte would pass) or not bound at all.
    const { received, error } = await consume(flip(at));
    expect(error).toMatchObject({ code: "archive_passphrase_invalid", status: 422 });
    expect(received.length).toBe(0);
  });

  it.each([
    ["a ciphertext byte", (k: number) => segmentRange(plaintext.length, k).start + 17],
    ["a tag byte", (k: number) => segmentRange(plaintext.length, k).end - 3],
  ])("%s changed in segment k fails segment k, with every segment before k delivered", async (_label, position) => {
    // Catches a reader that withholds verified segments, or delivers the failing one.
    for (const k of [0, 2, 4]) {
      const { received, error } = await consume(flip(position(k)));
      expect(error, `segment ${k}`).toMatchObject({ code: "archive_passphrase_invalid", status: 422 });
      expect(received.length, `segment ${k}`).toBe(k * S);
      expect(received.equals(plaintext.subarray(0, k * S)), `segment ${k}`).toBe(true);
    }
  });
});

describe("§4 line 6: a wrong passphrase fails segment 0, after scrypt ran once, creating no file", () => {
  it("refuses with archive_passphrase_invalid, hands nothing on and leaves the temporary directory empty", async () => {
    // Catches a reader that retries derivation, or parks plaintext in a file as v1 does.
    const file = sealV2(plaintextOf(2 * S + 5), passphrase, { manifestBytes: 100 });
    const before = readdirSync(sandbox);
    const { received, error } = await consume(file, "an-entirely-different-passphrase");
    expect(error).toMatchObject({ code: "archive_passphrase_invalid", status: 422 });
    expect(received.length).toBe(0);
    expect(crypto.scryptCalls, "crypto.scrypt calls").toBe(1);
    expect(crypto.scryptSyncCalls, "crypto.scryptSync calls").toBe(0);
    expect(readdirSync(sandbox)).toEqual(before);
  });
});

// §4 line 7 (fresh salt and nonce prefix per archive) is in
// tests/integration/portable-archive-v2.test.ts: the export picks them, and
// the container's SegmentWriter is handed a header it did not choose.

describe("§4 line 10: key derivation is asynchronous", () => {
  it("no non-test file under src/server/portable-archive* mentions scryptSync", () => {
    // Catches the v1 keyFor (scryptSync, SEC-D3/1) surviving anywhere in the archive engine.
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const offenders = readdirSync(directory)
      .filter((name) => name.startsWith("portable-archive") && name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) => /\bscryptSync\b/u.test(readFileSync(join(directory, name), "utf8")));
    expect(offenders).toEqual([]);
  });

  /** The largest delay a 5 ms interval saw while `work` ran, and how long the work took. */
  async function lagDuring(work: () => Promise<unknown>): Promise<{ maxLagMs: number; tookMs: number }> {
    let last = performance.now();
    let maxLagMs = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxLagMs = Math.max(maxLagMs, now - last - 5);
      last = now;
    }, 5);
    const started = performance.now();
    try { await work().catch(() => undefined); } finally { clearInterval(timer); }
    return { maxLagMs, tookMs: performance.now() - started };
  }

  it("the v1 opener's key derivation (PortableArchiveOpener.open) does not block a timer by more than 50 ms at a 1 s scrypt cost", async () => {
    // Catches keyFor left on scryptSync: the timer would stall for the whole second.
    const v1 = await import("./portable-archive") as unknown as { PortableArchiveOpener: { open(salt: string, iv: string, passphrase: string): Promise<unknown> } };
    expect(typeof v1.PortableArchiveOpener.open, "PortableArchiveOpener.open is static and async").toBe("function");
    crypto.boost = true;
    const { maxLagMs, tookMs } = await lagDuring(() => v1.PortableArchiveOpener.open(randomBytes(16).toString("base64url"), randomBytes(12).toString("base64url"), passphrase));
    expect(tookMs, "the boosted derivation really is slow (else the lag proves nothing)").toBeGreaterThan(300);
    expect(maxLagMs).toBeLessThan(50);
  });

  it("v2's deriveArchiveKey does not block a timer by more than 50 ms at a 1 s scrypt cost", async () => {
    // Catches a v2 derivation written with the synchronous form.
    crypto.boost = true;
    const { maxLagMs, tookMs } = await lagDuring(() => api().deriveArchiveKey(passphrase, randomBytes(16), { N: 16_384, r: 8, p: 1 }));
    expect(tookMs, "the boosted derivation really is slow (else the lag proves nothing)").toBeGreaterThan(300);
    expect(maxLagMs).toBeLessThan(50);
  });
});

describe("§4 line 13: 1 GiB through the container layer holds memory flat", () => {
  const MIB = 1_048_576;
  const GIB = 1024 * MIB;

  /** Runs the container memory child over `bodyBytes` of zeros; checks the bytes and hash, returns the peak-RSS growth in KiB. */
  async function containerGrowthKiB(bodyBytes: number): Promise<number> {
    const expected = createHash("sha256");
    const zeros = Buffer.alloc(S);
    for (let offset = 0; offset < bodyBytes; offset += S) expected.update(zeros.subarray(0, Math.min(S, bodyBytes - offset)));
    const expectedSha = expected.digest("hex");

    const tsx = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
    const child = fileURLToPath(new URL("../../tests/support/archive-container-memory-child.ts", import.meta.url));
    // CPU about 3 s for AES-GCM both ways plus sha256 over 1 GiB (note §4 line 13); 120 s is the slowest-host guard, not a target.
    const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const proc = spawn(process.execPath, [tsx, child, String(bodyBytes)], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, killSignal: "SIGKILL" });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      proc.on("error", reject);
      proc.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    expect(run.code, run.stderr).toBe(0);
    const line = run.stdout.split("\n").find((candidate) => candidate.startsWith("MEMORY_RESULT "));
    expect(line, `child output: ${run.stdout}\n${run.stderr}`).toBeDefined();
    const measured = JSON.parse(line!.slice("MEMORY_RESULT ".length)) as { beforeKiB: number; afterKiB: number; result: { bodyBytes: number; sha256: string } };
    expect(measured.result.bodyBytes).toBe(bodyBytes);
    expect(measured.result.sha256).toBe(expectedSha);
    return measured.afterKiB - measured.beforeKiB;
  }

  it("a child seals a manifest and one zero body into a pipe a SegmentReader drains, at 1 GiB and at 256 MiB: each grows by under 96 MiB, and the two growths differ by under 32 MiB", async () => {
    // Catches any layer (writer, pipe, reader, take) that buffers a body or the archive instead of a segment at a time.
    // Bounds from the design note §6.1: node's crypto returns a fresh 1 MiB buffer per segment and V8 collects external
    // memory only after about 64 MiB of growth, so the absolute figure sits 40-64 MiB above the live set whatever the size.
    // The difference between the two runs is the flatness proof; the absolute bound only catches a leak of a whole segment set.
    const large = await containerGrowthKiB(GIB);
    const small = await containerGrowthKiB(256 * MIB);
    // Measured: 1 GiB grew 54-62 MiB in the build (ef8c620f) and 52.2-66.5 MiB over three runs on 2d6e3278;
    // 256 MiB grew 51.4-52.2 MiB over the same three runs (differences 0.8-14.3 MiB).
    // §6.5: one run per size, no retries; the difference limit is 32 MiB, half V8's 64 MiB collection threshold and
    // twice the worst spread seen. A leak keeping even one segment in ten grows about 77 MiB more at 1 GiB.
    expect(large, `1 GiB: peak RSS grew ${(large / 1024).toFixed(1)} MiB; bound 96 MiB`).toBeLessThan(96 * 1024);
    expect(small, `256 MiB: peak RSS grew ${(small / 1024).toFixed(1)} MiB; bound 96 MiB`).toBeLessThan(96 * 1024);
    expect(Math.abs(large - small), `growths ${(large / 1024).toFixed(1)} and ${(small / 1024).toFixed(1)} MiB; difference bound 32 MiB`).toBeLessThan(32 * 1024);
  }, 300_000);
});

describe("§6.4: the reader zeroes each segment's plaintext once its views are spent", () => {
  // The contract (design note §6.4): a piece handed on by take() is a view of the reader's
  // current segment, valid only until the consumer's next pull. When the next segment replaces
  // it, when the reader fails, and at finish(), that plaintext is zeroed.
  const T = 3 * S;

  /** Reads `stream` keeping each piece as the reader handed it (no copy), until `stop` says so or it ends. */
  async function readViews(stream: ReadableStream<Uint8Array>, stop: (received: number) => boolean) {
    const reader = stream.getReader();
    const views: Array<{ view: Uint8Array; at: number; copy: Buffer }> = [];
    let received = 0;
    let failure: unknown = null;
    try {
      while (!stop(received)) {
        const { done, value } = await reader.read();
        if (done) break;
        views.push({ view: value, at: received, copy: Buffer.from(value) });
        received += value.length;
      }
    } catch (error) {
      failure = error;
    }
    return { views, received, failure, reader };
  }

  const zeroed = (view: Uint8Array) => view.every((byte) => byte === 0);

  it("zeroes segment 0's plaintext when segment 1 replaces it", async () => {
    // Catches the old plaintext left in memory (it is the household's documents in clear) until garbage collection.
    const plaintext = randomBytes(T);
    const file = sealV2(plaintext, passphrase);
    const opened = await api().SegmentReader.open(streamOf(file), passphrase, CEILING);
    const { views } = await readViews(opened.take(T), (received) => received > S);
    const first = views.filter((piece) => piece.at + piece.view.length <= S);
    expect(first.length, "pieces of segment 0 were handed on").toBeGreaterThan(0);
    for (const piece of first) expect(piece.copy.equals(plaintext.subarray(piece.at, piece.at + piece.view.length)), "right bytes when handed on").toBe(true);
    expect(first.every((piece) => zeroed(piece.view)), "segment 0 zeroed once segment 1 is in").toBe(true);
  });

  it("zeroes the current segment's plaintext when the next segment fails authentication", async () => {
    // Catches a failure path that throws without wiping what it had decrypted.
    const plaintext = randomBytes(T);
    const file = Buffer.from(sealV2(plaintext, passphrase));
    const { end } = segmentRange(T, 1);
    file[end - 1] ^= 0x01;
    const opened = await api().SegmentReader.open(streamOf(file), passphrase, CEILING);
    const { views, failure } = await readViews(opened.take(T), () => false);
    expect(failure, "segment 1 is refused").toMatchObject({ code: "archive_passphrase_invalid" });
    expect(views.length, "segment 0 was handed on first").toBeGreaterThan(0);
    expect(views.every((piece) => zeroed(piece.view)), "segment 0 zeroed on the failure").toBe(true);
  });

  it("zeroes the last segment's plaintext at finish()", async () => {
    // Catches finish() wiping the key but leaving the final segment's plaintext.
    const plaintext = randomBytes(T);
    const file = sealV2(plaintext, passphrase);
    const opened = await api().SegmentReader.open(streamOf(file), passphrase, CEILING);
    const { views, received } = await readViews(opened.take(T), () => false);
    expect(received).toBe(T);
    const last = views.filter((piece) => piece.at >= 2 * S);
    expect(last.length).toBeGreaterThan(0);
    await opened.finish();
    expect(last.every((piece) => zeroed(piece.view)), "the last segment zeroed by finish()").toBe(true);
  });
});
