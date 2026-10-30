import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  archiveForm,
  chunkedStream,
  encodeForm,
  fileContentOffset,
  rawMultipart,
  readStream,
  trackedBody,
  type RawPart,
} from "../../tests/integration/support/portable-archive-upload";

/**
 * The strict streaming `multipart/form-data` reader the archive routes read
 * their upload with (#1566, plan in note 46292). From the plan alone:
 *  - it reads over a `ReadableStream<Uint8Array>` and a boundary: the text
 *    fields to a record, under a byte cap, then exactly one file part as a
 *    stream, then the closing delimiter;
 *  - it accepts only what Orbit's own client sends: a text field after the
 *    file, a second file, no file, or a malformed delimiter is refused with
 *    AppError("request_malformed", "That request is not well-formed", 400);
 *  - fields over the cap are refused before the file part is read;
 *  - reading the fields does not pull the file part's bytes, so a refusal
 *    can be sent before any of the file is read;
 *  - `dispose()` reads the rest of the body away, so the connection stays
 *    usable after a refusal;
 *  - the delimiter is found however the body is split into chunks.
 *
 * Interface chosen here (the plan names the module, its inputs and its
 * outputs, not the method names): `new MultipartReader(body, boundary,
 * { maxFieldBytes })`, `fields(): Promise<Record<string, string>>`,
 * `file(): Promise<{ name: string; stream: ReadableStream<Uint8Array> }>`,
 * `dispose(): Promise<void>`.
 */

const MIB = 1_048_576;
const CAP = MIB;
const BOUNDARY = "----orbit-test-boundary-7MA4YWxkTrZu0gW";

type ReaderModule = {
  MultipartReader: new (body: ReadableStream<Uint8Array>, boundary: string, options: { maxFieldBytes: number }) => {
    fields(): Promise<Record<string, string>>;
    file(): Promise<{ name: string; stream: ReadableStream<Uint8Array> }>;
    dispose(): Promise<void>;
  };
};

const { MultipartReader } = (await import("@/server/multipart-reader")) as unknown as ReaderModule;

const malformed = { code: "request_malformed", status: 400, message: "That request is not well-formed" };

/** The whole upload as a caller reads it: fields, then the file part to its end. */
async function readAll(body: ReadableStream<Uint8Array>, boundary: string, maxFieldBytes = CAP) {
  const reader = new MultipartReader(body, boundary, { maxFieldBytes });
  const fields = await reader.fields();
  const file = await reader.file();
  const bytes = await readStream(file.stream);
  return { fields, name: file.name, bytes };
}

/* File content built to trip a careless delimiter search: CRLF and dash runs,
   a near-miss of the boundary, and the boundary without its leading CRLF
   (which is content, not a delimiter). */
const trickyContent = Buffer.concat([
  Buffer.from(`{"version":1,"ciphertext":"`),
  randomBytes(9_000),
  Buffer.from(`\r\n--${BOUNDARY.slice(0, -1)}\r\nx`),
  Buffer.from(`--${BOUNDARY}`),
  Buffer.from("\r\n\r\n--\r\n-"),
  randomBytes(9_000),
  Buffer.from(`"}`),
]);

const wellFormedFields = {
  householdId: "66a1f3d8-b79d-47a5-92fe-a4824270aa9a",
  passphrase: "correct horse battery staple",
  currentPassword: "s3cret pass",
  conflictItemIds: JSON.stringify(["26f04310-3f96-4828-94b2-f2fc693bc89e"]),
};

const wellFormedParts: RawPart[] = [
  ...Object.entries(wellFormedFields).map(([name, value]) => ({ name, value })),
  { name: "archive", filename: "household.orbit-archive.json", value: trickyContent },
];

describe("reads what Orbit's client sends (#1566)", () => {
  it("reads the fields in order and the file part's exact bytes from a body the platform's FormData wrote", async () => {
    // Catches: a reader that drops a field, keeps the CRLF before a delimiter in a value or the file, or loses bytes.
    const upload = await encodeForm(archiveForm({
      householdId: wellFormedFields.householdId,
      passphrase: wellFormedFields.passphrase,
      currentPassword: wellFormedFields.currentPassword,
      conflictItemIds: ["26f04310-3f96-4828-94b2-f2fc693bc89e"],
    }, trickyContent));

    const read = await readAll(chunkedStream(upload.bytes, [64 * 1024]), upload.boundary);

    expect(read.fields).toEqual(wellFormedFields);
    expect(Object.keys(read.fields)).toEqual(["householdId", "passphrase", "currentPassword", "conflictItemIds"]);
    expect(read.name).toBe("archive");
    expect(read.bytes.equals(trickyContent)).toBe(true);
  });

  it("reads the same fields and bytes however the body is split, including a split inside every delimiter", async () => {
    // Catches: a delimiter search that does not carry bytes across chunks (boundary.length + 4).
    const body = rawMultipart(BOUNDARY, wellFormedParts);
    const sizes = [
      ...Array.from({ length: BOUNDARY.length + 8 }, (_, index) => [index + 1]),
      [4_093], [65_536],
      // Uneven runs, so a split lands at a different place in each delimiter.
      [1, 7, 2, 64, 3, 1_000], [5, 1, 1, 13], [65_536, 1, 2, 3],
    ];
    for (const run of sizes) {
      const read = await readAll(chunkedStream(body, run), BOUNDARY);
      expect(read.fields, `chunks ${run.join(",")}`).toEqual(wellFormedFields);
      expect(read.name).toBe("archive");
      expect(read.bytes.equals(trickyContent), `chunks ${run.join(",")}: file bytes`).toBe(true);
    }
  }, 60_000);

  it("does not pull any of the file part's content while reading the fields", async () => {
    // Catches: a reader that reads ahead into the file, so a refusal after the fields would come after reading the file.
    const body = rawMultipart(BOUNDARY, [
      { name: "householdId", value: wellFormedFields.householdId },
      { name: "passphrase", value: wellFormedFields.passphrase },
      { name: "archive", filename: "household.orbit-archive.json", value: randomBytes(4 * MIB) },
    ]);
    const start = fileContentOffset(body);
    const { body: stream, stats } = trackedBody(body, { cuts: [start] });
    const reader = new MultipartReader(stream, BOUNDARY, { maxFieldBytes: CAP });

    const fields = await reader.fields();

    expect(fields).toEqual({ householdId: wellFormedFields.householdId, passphrase: wellFormedFields.passphrase });
    expect(stats.pulledBytes, "bytes pulled before the file part was asked for").toBeLessThanOrEqual(start);
    await reader.dispose();
  });

  it("dispose() reads the rest of the body away when the file part is never read", async () => {
    // Catches: a refusal that leaves the upload unread, so the connection cannot answer the next request.
    const body = rawMultipart(BOUNDARY, wellFormedParts);
    const { body: stream, stats } = trackedBody(body, { chunkSize: 1_024 });
    const reader = new MultipartReader(stream, BOUNDARY, { maxFieldBytes: CAP });
    await reader.fields();

    await reader.dispose();

    expect(stats.pulledBytes).toBe(body.length);
    expect(stats.done).toBe(true);
  });
});

describe("refuses anything else with request_malformed (#1566)", () => {
  const field = (name: string, value: string): RawPart => ({ name, value });
  const filePart = (value: Buffer | string = trickyContent): RawPart => ({ name: "archive", filename: "household.orbit-archive.json", value });
  const bodies: Array<[string, Buffer]> = [
    ["a text field after the file part", rawMultipart(BOUNDARY, [field("householdId", wellFormedFields.householdId), filePart(), field("passphrase", wellFormedFields.passphrase)])],
    ["two file parts", rawMultipart(BOUNDARY, [field("householdId", wellFormedFields.householdId), filePart(), filePart("{}")])],
    ["no file part", rawMultipart(BOUNDARY, [field("householdId", wellFormedFields.householdId), field("passphrase", wellFormedFields.passphrase)])],
    ["an opening delimiter with another boundary", rawMultipart(BOUNDARY, [field("householdId", wellFormedFields.householdId), filePart()], { opening: "--some-other-boundary" })],
    ["a body that ends without its closing delimiter", rawMultipart(BOUNDARY, [field("householdId", wellFormedFields.householdId), filePart()], { closing: false })],
    ["a body that is not multipart at all", Buffer.from(JSON.stringify({ householdId: wellFormedFields.householdId, archive: {} }))],
  ];

  it.each(bodies)("refuses %s", async (_label, body) => {
    // Catches: a lenient reader that accepts a shape Orbit's client never sends.
    await expect(readAll(chunkedStream(body, [4_096]), BOUNDARY)).rejects.toMatchObject(malformed);
  });

  it.each(bodies)("reads the rest of the body away after refusing %s", async (_label, body) => {
    // Catches: a refused body left half read.
    const { body: stream, stats } = trackedBody(body, { chunkSize: 4_096 });
    const reader = new MultipartReader(stream, BOUNDARY, { maxFieldBytes: CAP });
    await (async () => {
      await reader.fields();
      const file = await reader.file();
      await readStream(file.stream);
    })().catch(() => undefined);

    await reader.dispose();

    expect(stats.done).toBe(true);
    expect(stats.pulledBytes).toBe(body.length);
  });
});

describe("the fields are capped, and refused over the cap before the file part is read (#1566)", () => {
  const fileValue = randomBytes(4 * MIB);

  it("refuses fields over the cap together with request_malformed, without pulling the file part", async () => {
    // Catches: no cap (a 300 MiB "field" held in memory), or a cap checked only after the file is read.
    const over = rawMultipart(BOUNDARY, [
      { name: "householdId", value: "a".repeat(CAP / 2) },
      { name: "passphrase", value: "b".repeat(CAP / 2 + 1) },
      { name: "archive", filename: "household.orbit-archive.json", value: fileValue },
    ]);
    const start = fileContentOffset(over);
    const { body, stats } = trackedBody(over, { cuts: [start] });
    const reader = new MultipartReader(body, BOUNDARY, { maxFieldBytes: CAP });

    await expect(reader.fields()).rejects.toMatchObject(malformed);
    expect(stats.pulledBytes, "bytes pulled before the refusal").toBeLessThanOrEqual(start);
    await reader.dispose();
  });

  it("accepts fields well under the cap (the control for the refusal above)", async () => {
    const under = rawMultipart(BOUNDARY, [
      { name: "householdId", value: "a".repeat(CAP / 4) },
      { name: "passphrase", value: "b".repeat(CAP / 4) },
      { name: "archive", filename: "household.orbit-archive.json", value: fileValue },
    ]);
    const read = await readAll(chunkedStream(under, [65_536]), BOUNDARY);
    expect(read.fields.householdId).toHaveLength(CAP / 4);
    expect(read.bytes.equals(fileValue)).toBe(true);
  });
});
