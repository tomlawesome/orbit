import { randomBytes } from "node:crypto";
import { createDeflate, deflateSync } from "node:zlib";
import { createCanvas, type Canvas } from "@napi-rs/canvas";

/**
 * The #1436 measurement shapes (design note §1.6), as in-memory generators the
 * tests reuse: text pages with a non-embedded Helvetica, phone-photo and
 * home-scanner pages, the largest 1-bit page the old pixel cap admitted, and
 * the hostile shapes poppler was measured against. Built at test time, never
 * committed. Painted with `@napi-rs/canvas`, which tests may load (the
 * in-process tripwire covers src/server only).
 */

function classicPdf(objects: Buffer[]): Buffer {
  const parts = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const wrapped = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    parts.push(wrapped);
    length += wrapped.length;
  });
  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  trailer += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  trailer += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(trailer));
  return Buffer.concat(parts);
}

function stream(dict: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`<< ${dict} /Length ${body.length} >>\nstream\n`), body, Buffer.from("\nendstream")]);
}

/** Deflates `total` bytes of `fill` without holding them: 1 MiB pieces through a streaming deflater. */
async function deflatedRun(total: number, fill: number, head = Buffer.alloc(0)): Promise<Buffer> {
  const deflater = createDeflate({ level: 9 });
  const out: Buffer[] = [];
  deflater.on("data", (chunk: Buffer) => out.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    deflater.once("end", resolve);
    deflater.once("error", reject);
  });
  const piece = Buffer.alloc(1_048_576, fill);
  let written = 0;
  if (head.length > 0) {
    deflater.write(head);
    written += head.length;
  }
  while (written < total) {
    const slice = piece.subarray(0, Math.min(piece.length, total - written));
    written += slice.length;
    if (!deflater.write(slice)) await new Promise((resolve) => deflater.once("drain", resolve));
  }
  deflater.end();
  await done;
  return Buffer.concat(out);
}

/** A paper-coloured page with lines of text, painted. */
function paintedPage(width: number, height: number, dpi: number, grey = false): Canvas {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = grey ? "#f0f0f0" : "#f4f1e8";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#222222";
  context.font = `${dpi / 4}px sans-serif`;
  for (let y = dpi; y < height; y += dpi / 2) {
    context.fillText(`Lorem ipsum dolor sit amet, consectetur adipiscing elit ${y}`, dpi / 2, y);
  }
  return canvas;
}

type ImageSpec = { width: number; height: number; colorSpace: string; bpc: number; filter: string };

/** A PDF whose A4 pages each draw one image XObject filling the page. */
function imagePdf(image: Buffer, spec: ImageSpec, pages = 1): Buffer {
  const content = Buffer.from("q 595 0 0 842 0 0 cm /Im0 Do Q\n");
  const kids = Array.from({ length: pages }, (_, index) => `${5 + index} 0 R`).join(" ");
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`),
    stream("", content),
    stream(`/Type /XObject /Subtype /Image /Width ${spec.width} /Height ${spec.height} /ColorSpace /${spec.colorSpace} /BitsPerComponent ${spec.bpc} /Filter /${spec.filter}`, image),
  ];
  for (let index = 0; index < pages; index += 1) {
    objects.push(Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 3 0 R >>"));
  }
  return classicPdf(objects);
}

/** The A4 page every text fixture uses, in points. */
export const TEXT_PAGE = { width: 595, height: 842 } as const;
/**
 * Where the text sits on a text page, in points from the top-left: 40 lines
 * from 42 pt to about 744 pt down, starting 50 pt in and running to about
 * 550 pt (11 pt Helvetica).
 */
export const TEXT_AREA_POINTS = { left: 50, top: 32, right: 480, bottom: 744 } as const;

/**
 * `pages` A4 pages of 40 lines of 11 pt text each, in Helvetica, not
 * embedded: poppler must substitute a font (Liberation Sans in the image).
 */
export function textPagesPdf(pages: number): Buffer {
  const objects: Array<Buffer | null> = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    null,
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  const kids: string[] = [];
  for (let page = 1; page <= pages; page += 1) {
    const text = Array.from({ length: 40 }, (_, line) => `BT /F1 11 Tf 50 ${800 - line * 18} Td (Page ${page} line ${line} the quick brown fox jumps over the lazy dog 0123456789) Tj ET`).join("\n");
    const contentIndex = objects.length + 1;
    objects.push(stream("", Buffer.from(text)));
    kids.push(`${objects.length + 1} 0 R`);
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${TEXT_PAGE.width} ${TEXT_PAGE.height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentIndex} 0 R >>`));
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`);
  return classicPdf(objects as Buffer[]);
}

/** One page of text with the given page-dictionary entries (a /Rotate, a /CropBox, a /MediaBox), nothing else. */
function textPageWith(entries: string): Buffer {
  const text = Array.from({ length: 40 }, (_, line) => `BT /F1 11 Tf 50 ${800 - line * 18} Td (Line ${line} the quick brown fox jumps over the lazy dog) Tj ET`).join("\n");
  return classicPdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [4 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.from(`<< /Type /Page /Parent 2 0 R ${entries} /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>`),
    stream("", Buffer.from(text)),
  ]);
}

/** An A4 portrait page (595x842 pt) turned 90 degrees: it shows landscape. */
export function rotatedPagePdf(): Buffer {
  return textPageWith(`/MediaBox [0 0 ${TEXT_PAGE.width} ${TEXT_PAGE.height}] /Rotate 90`);
}

/** The shape of the crop box in `cropBoxPdf`, in points: landscape, 500x300. */
export const CROP_BOX_POINTS = { width: 500, height: 300 } as const;

/**
 * A page whose MediaBox is large (1600x2400 pt, portrait) and whose CropBox is
 * a small landscape window (500x300 pt) inside it, where text sits: the page
 * as shown is the crop.
 */
export function cropBoxPdf(): Buffer {
  return textPageWith(`/MediaBox [0 0 1600 2400] /CropBox [100 100 ${100 + CROP_BOX_POINTS.width} ${100 + CROP_BOX_POINTS.height}]`);
}

/** A well-formed PDF whose catalog's page tree has no pages at all. */
export function noPagesPdf(): Buffer {
  return classicPdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [] /Count 0 >>"),
  ]);
}

/** A 12 Mpx (4000x3000) phone photo as one DCT image on an A4 page. */
export function phonePhotoPdf(): Buffer {
  const width = 4000;
  const height = 3000;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#3a6ea5");
  gradient.addColorStop(0.5, "#c0a060");
  gradient.addColorStop(1, "#204020");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  const noise = randomBytes(data.length);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = Math.min(255, data[index]! + (noise[index]! >> 3));
    data[index + 1] = Math.min(255, data[index + 1]! + (noise[index + 1]! >> 3));
    data[index + 2] = Math.min(255, data[index + 2]! + (noise[index + 2]! >> 3));
  }
  context.putImageData(image, 0, 0);
  return imagePdf(canvas.toBuffer("image/jpeg", 90), { width, height, colorSpace: "DeviceRGB", bpc: 8, filter: "DCTDecode" });
}

/** A colour A4 home-scanner page at `dpi` (300: 2480x3508; 600: 4960x7016), JPEG (DCT) q85; `pages` pages share the one image. */
export function colourScanPdf(dpi: 300 | 600, pages = 1): Buffer {
  const width = Math.round(8.27 * dpi);
  const height = Math.round(11.69 * dpi);
  const canvas = paintedPage(width, height, dpi);
  return imagePdf(canvas.toBuffer("image/jpeg", 85), { width, height, colorSpace: "DeviceRGB", bpc: 8, filter: "DCTDecode" }, pages);
}

/** The largest 1-bit page the old 40 Mpx cap admitted: 5316x7522, Flate. */
export function oneBitPagePdf(): Buffer {
  const width = 5316;
  const height = 7522;
  const rowBytes = Math.ceil(width / 8);
  const bits = Buffer.alloc(rowBytes * height, 0xff);
  for (let y = 0; y < height; y += 1) if (y % 40 < 6) bits.fill(0x00, y * rowBytes + 100, y * rowBytes + rowBytes - 100);
  return imagePdf(deflateSync(bits, { level: 6 }), { width, height, colorSpace: "DeviceGray", bpc: 1, filter: "FlateDecode" });
}

/** Hostile: one operator followed by 128 MB of spaces, Flate packed (a content-stream bomb). */
export async function contentBombPdf(): Promise<Buffer> {
  const packed = await deflatedRun(128 * 1024 * 1024, 0x20, Buffer.from("0 0 1 rg 10 10 100 100 re f\n", "latin1"));
  return classicPdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>"),
    stream("/Filter /FlateDecode", packed),
  ]);
}

/** Hostile: 80 soft-mask transparency groups over the full page. */
export function softMaskBombPdf(): Buffer {
  const content = Buffer.from("q /GS1 gs 1 0 0 rg 0 0 612 792 re f Q\n".repeat(80));
  return classicPdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /ExtGState << /GS1 5 0 R >> >> /Contents 4 0 R >>"),
    stream("", content),
    Buffer.from("<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G 6 0 R >> >>"),
    stream("/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Group << /S /Transparency /CS /DeviceGray >>", Buffer.from("0.5 g 0 0 612 792 re f")),
  ]);
}

function patternPdf(fills: number, pattern: Buffer): Buffer {
  return classicPdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Pattern << /P0 5 0 R >> >> /Contents 4 0 R >>"),
    stream("", Buffer.from(`/Pattern cs /P0 scn\n${"0 0 612 792 re f\n".repeat(fills)}`)),
    pattern,
  ]);
}

/** Hostile: 60 full-page fills with a 3,000 pt tiling pattern. */
export function tilingBombPdf(): Buffer {
  return patternPdf(60, stream("/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 3000 3000] /XStep 3000 /YStep 3000 /Resources << >>", Buffer.from("0 0 1 rg 0 0 3000 3000 re f")));
}

/** Hostile: a tiling pattern with a 0.01 pt step; poppler never finishes it, so only the clock stops it. */
export function tinyStepTilingPdf(): Buffer {
  return patternPdf(1, stream("/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 1 1] /XStep 0.01 /YStep 0.01 /Resources << >>", Buffer.from("0 0 1 rg 0 0 1 1 re f")));
}

/** Hostile: a 30,000 x 30,000 grey image of zeros (900 Mpx), Flate packed to under a megabyte. */
export async function hugeImagePdf(): Promise<Buffer> {
  const width = 30_000;
  const height = 30_000;
  const packed = await deflatedRun(width * height, 0x00);
  return imagePdf(packed, { width, height, colorSpace: "DeviceGray", bpc: 8, filter: "FlateDecode" });
}
