import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

const tikaUrl = new URL(process.env.TIKA_TEST_URL ?? "http://orbit-tika:9998");
const maximumResponseBytes = 1_000_000;

function buildPdf(text, embeddedText) {
  const escapedText = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const pageStream = `BT /F1 18 Tf 72 720 Td (${escapedText}) Tj ET`;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R${embeddedText ? " /Names << /EmbeddedFiles 6 0 R >>" : ""} >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(pageStream)} >>\nstream\n${pageStream}\nendstream`,
  ];
  if (embeddedText) {
    objects.push(
      "<< /Names [(payload.txt) 7 0 R] >>",
      "<< /Type /Filespec /F (payload.txt) /EF << /F 8 0 R >> >>",
      `<< /Type /EmbeddedFile /Length ${Buffer.byteLength(embeddedText)} >>\nstream\n${embeddedText}\nendstream`,
    );
  }
  let value = "%PDF-1.7\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(value));
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  value += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(value);
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return result;
}

function ocrContractPng() {
  const glyphs = {
    O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
    R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
    E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  };
  const phrase = "OCR BLOCKED";
  const scale = 16;
  const margin = 40;
  const width = (phrase.length * 6 * scale) + (margin * 2);
  const height = (7 * scale) + (margin * 2);
  const scanlines = Buffer.alloc(height * ((width * 3) + 1), 0xff);
  for (let y = 0; y < height; y += 1) scanlines[y * ((width * 3) + 1)] = 0;
  for (const [characterIndex, character] of [...phrase].entries()) {
    const glyph = glyphs[character];
    glyph.forEach((row, glyphY) => {
      [...row].forEach((pixel, glyphX) => {
        if (pixel !== "1") return;
        for (let y = 0; y < scale; y += 1) {
          for (let x = 0; x < scale; x += 1) {
            const pixelX = margin + (characterIndex * 6 * scale) + (glyphX * scale) + x;
            const pixelY = margin + (glyphY * scale) + y;
            const offset = (pixelY * ((width * 3) + 1)) + 1 + (pixelX * 3);
            scanlines.fill(0, offset, offset + 3);
          }
        }
      });
    });
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const fixtures = [
  {
    mediaType: "application/pdf",
    bytes: buildPdf("Orbit parser contract"),
    expectedText: "Orbit parser contract",
  },
  {
    mediaType: "image/png",
    bytes: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  },
  {
    mediaType: "image/jpeg",
    bytes: Buffer.from(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==",
      "base64",
    ),
  },
];

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForReady() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/version", tikaUrl), { redirect: "error" });
      if (response.ok) {
        // The version resource can become reachable just before the forked
        // parser worker has completed initialization.
        await delay(5_000);
        return;
      }
    } catch {
      // The exact image is still starting.
    }
    await delay(1_000);
  }
  throw new Error("The exact Tika image did not become ready within 120 seconds");
}

async function extract(fixture) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(new URL("/tika/text", tikaUrl), {
      method: "PUT",
      headers: {
        Accept: "text/plain",
        "Content-Type": fixture.mediaType,
        "X-Tika-OCRskipOcr": "true",
        "X-Tika-Skip-Embedded": "true",
      },
      body: fixture.bytes,
      redirect: "error",
      signal: controller.signal,
    });
    assert.equal(
      response.ok,
      true,
      `Tika rejected the ${fixture.mediaType} contract fixture with HTTP ${response.status}`,
    );
    assert.equal(response.redirected, false);
    assert.match(response.headers.get("content-type") ?? "", /^text\/plain(?:;|$)/iu);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length <= maximumResponseBytes, "Tika exceeded the response byte contract");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (fixture.expectedText) assert.ok(text.includes(fixture.expectedText));
    return text;
  } finally {
    clearTimeout(timer);
  }
}

await waitForReady();
for (const fixture of fixtures) await extract(fixture);
const embeddedSentinel = "EMBEDDED-CONTENT-MUST-NOT-APPEAR";
const embeddedText = await extract({
  mediaType: "application/pdf",
  bytes: buildPdf("Visible outer document", embeddedSentinel),
});
assert.equal(embeddedText.includes(embeddedSentinel), false, "Tika recursed into an embedded file");
const ocrText = await extract({ mediaType: "image/png", bytes: ocrContractPng() });
assert.equal(
  ocrText.toUpperCase().replaceAll(/[^A-Z]/gu, "").includes("OCRBLOCKED"),
  false,
  "Tika OCR was active despite the v1 opt-out",
);
console.log("Exact Tika processor contract passed for PDF, PNG and JPEG.");
