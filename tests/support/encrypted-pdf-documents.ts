import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

/**
 * Encrypted synthetic PDFs, built here with the PDF standard security handler
 * (ISO 32000-1 7.6.3, revision 3: 128-bit RC4) so no real encrypted document
 * is ever committed (ADR-0033's fixtures for #1292).
 *
 * - `syntheticOwnerPasswordPdf`: an owner password only, as "no editing"
 *   certificates are written: the user password is empty, so any reader
 *   opens it, and its catalog, page tree and page sit in an encrypted object
 *   stream indexed by a cross-reference stream.
 * - `syntheticUserPasswordPdf`: a user password is set, so nothing can open
 *   it without being told the password.
 */

const PASSWORD_PADDING = Buffer.from(
  "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
  "hex",
);
const KEY_BYTES = 16;
/** Printing allowed, changing the document not: the "no editing" shape. */
const PERMISSIONS = -3904;
const IDENTIFIER = Buffer.from("4f72626974207379 6e74686574696320".replaceAll(" ", ""), "hex");

function md5(...parts: Buffer[]): Buffer {
  const hash = createHash("md5");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function rc4(key: Buffer, data: Buffer): Buffer {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + state[i] + key[i % key.length]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
  }
  const output = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let index = 0; index < data.length; index += 1) {
    i = (i + 1) & 0xff;
    j = (j + state[i]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
    output[index] = data[index] ^ state[(state[i] + state[j]) & 0xff];
  }
  return output;
}

function padded(password: string): Buffer {
  return Buffer.concat([Buffer.from(password, "latin1"), PASSWORD_PADDING]).subarray(0, 32);
}

/** Algorithm 3: the /O entry. */
function ownerEntry(ownerPassword: string, userPassword: string): Buffer {
  let hash = md5(padded(ownerPassword || userPassword));
  for (let round = 0; round < 50; round += 1) hash = md5(hash);
  const key = hash.subarray(0, KEY_BYTES);
  let value = rc4(key, padded(userPassword));
  for (let round = 1; round <= 19; round += 1) value = rc4(Buffer.from(key.map((byte) => byte ^ round)), value);
  return value;
}

/** Algorithm 2: the file key. */
function fileKey(userPassword: string, owner: Buffer): Buffer {
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(PERMISSIONS);
  let hash = md5(padded(userPassword), owner, permissions, IDENTIFIER);
  for (let round = 0; round < 50; round += 1) hash = md5(hash.subarray(0, KEY_BYTES));
  return hash.subarray(0, KEY_BYTES);
}

/** Algorithm 5: the /U entry. */
function userEntry(key: Buffer): Buffer {
  let value = rc4(key, md5(PASSWORD_PADDING, IDENTIFIER));
  for (let round = 1; round <= 19; round += 1) value = rc4(Buffer.from(key.map((byte) => byte ^ round)), value);
  return Buffer.concat([value, Buffer.alloc(16)]);
}

/** Algorithm 1: each object's own key. */
function objectKey(key: Buffer, id: number): Buffer {
  const suffix = Buffer.from([id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff, 0, 0]);
  return md5(key, suffix).subarray(0, Math.min(KEY_BYTES + 5, 16));
}

function text(value: string): Buffer {
  return Buffer.from(value, "latin1");
}

function encryption(ownerPassword: string, userPassword: string) {
  const owner = ownerEntry(ownerPassword, userPassword);
  const key = fileKey(userPassword, owner);
  return {
    key,
    dictionary: `<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${PERMISSIONS} /O <${owner.toString("hex")}> /U <${userEntry(key).toString("hex")}> >>`,
  };
}

function stream(dictionary: string, payload: Buffer): Buffer {
  return Buffer.concat([text(`<< ${dictionary} /Length ${payload.length} >>\nstream\n`), payload, text("\nendstream")]);
}

const PAGE_CONTENT = text("BT /F1 18 Tf 72 720 Td (Synthetic encrypted document) Tj ET");

function xrefRow(type: number, field2: number, field3: number): Buffer {
  const row = Buffer.alloc(6);
  row[0] = type;
  row.writeUInt32BE(field2, 1);
  row[5] = field3;
  return row;
}

/**
 * Catalog, page tree, page and font packed into object stream 7, which is
 * encrypted with the file key; the content stream 5 is encrypted too; the
 * encryption dictionary 6 and the cross-reference stream 8 are not, as the
 * standard requires.
 */
function objectStreamPdf(ownerPassword: string, userPassword: string): Buffer {
  const { key, dictionary } = encryption(ownerPassword, userPassword);
  const packed: Record<number, string> = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    4: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  };
  let header = "";
  let body = "";
  for (const id of [1, 2, 3, 4]) {
    header += `${id} ${body.length} `;
    body += `${packed[id]}\n`;
  }
  const objectStream = rc4(objectKey(key, 7), deflateSync(text(header + body)));
  const content = rc4(objectKey(key, 5), PAGE_CONTENT);

  let bytes = text("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
  const offsets = new Map<number, number>();
  const append = (id: number, value: Buffer) => {
    offsets.set(id, bytes.length);
    bytes = Buffer.concat([bytes, text(`${id} 0 obj\n`), value, text("\nendobj\n")]);
  };
  append(5, stream("", content));
  append(6, text(dictionary));
  append(7, stream(`/Type /ObjStm /N 4 /First ${header.length} /Filter /FlateDecode`, objectStream));

  const xrefOffset = bytes.length;
  const rows = [
    xrefRow(0, 0, 0xff),
    xrefRow(2, 7, 0),
    xrefRow(2, 7, 1),
    xrefRow(2, 7, 2),
    xrefRow(2, 7, 3),
    xrefRow(1, offsets.get(5)!, 0),
    xrefRow(1, offsets.get(6)!, 0),
    xrefRow(1, offsets.get(7)!, 0),
    xrefRow(1, xrefOffset, 0),
  ];
  const id = IDENTIFIER.toString("hex");
  const xref = stream(
    `/Type /XRef /Size 9 /W [1 4 1] /Index [0 9] /Root 1 0 R /Encrypt 6 0 R /ID [<${id}> <${id}>]`,
    Buffer.concat(rows),
  );
  return Buffer.concat([bytes, text("8 0 obj\n"), xref, text(`\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`)]);
}

/** "No editing": an owner password, no user password, an encrypted object stream. */
export function syntheticOwnerPasswordPdf(): Buffer {
  return objectStreamPdf("synthetic-owner", "");
}

/** Needs a password to open at all. */
export function syntheticUserPasswordPdf(): Buffer {
  return objectStreamPdf("synthetic-owner", "synthetic-user");
}
