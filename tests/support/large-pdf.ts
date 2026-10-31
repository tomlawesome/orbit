import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "node:fs/promises";

/**
 * Large, valid, one-page classic PDFs for the document-stream tests (#1567),
 * generated at test time and never committed. The page content is one
 * uncompressed stream of spaces, so the file is exactly `totalBytes` long and
 * opens in the real parser.
 *
 * `writePaddedPdfFile` writes it in 1 MiB pieces, so building a 98 MB fixture
 * does not itself hold 98 MB in the test process.
 */

const PIECE = 1_048_576;

interface Layout {
  head: Buffer;
  tail: Buffer;
}

function layoutFor(paddingBytes: number): Layout {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
  ];
  let head = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(head, "latin1"));
    head += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  offsets.push(Buffer.byteLength(head, "latin1"));
  head += `4 0 obj\n<< /Length ${paddingBytes} >>\nstream\n`;
  const headBytes = Buffer.from(head, "latin1");
  const afterPadding = "\nendstream\nendobj\n";
  const xrefOffset = headBytes.length + paddingBytes + afterPadding.length;
  let tail = afterPadding;
  tail += `xref\n0 5\n0000000000 65535 f \n`;
  tail += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  tail += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return { head: headBytes, tail: Buffer.from(tail, "latin1") };
}

/** The layout of a valid PDF whose total length is exactly `totalBytes`. */
function layoutOfSize(totalBytes: number): Layout & { paddingBytes: number } {
  let padding = Math.max(0, totalBytes - 700);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const layout = layoutFor(padding);
    const total = layout.head.length + padding + layout.tail.length;
    if (total === totalBytes) return { ...layout, paddingBytes: padding };
    padding += totalBytes - total;
    if (padding < 0) break;
  }
  throw new Error(`no PDF of ${totalBytes} bytes`);
}

/** A valid PDF of exactly `totalBytes`, in memory. */
export function paddedPdfOfSize(totalBytes: number): Buffer {
  const { head, tail, paddingBytes } = layoutOfSize(totalBytes);
  return Buffer.concat([head, Buffer.alloc(paddingBytes, 0x20), tail]);
}

/** Writes a valid PDF of exactly `totalBytes` to `path` without holding it whole. */
export async function writePaddedPdfFile(path: string, totalBytes: number): Promise<void> {
  const { head, tail, paddingBytes } = layoutOfSize(totalBytes);
  const handle = await open(path, "w", 0o600);
  try {
    await handle.write(head);
    const piece = Buffer.alloc(Math.min(PIECE, Math.max(paddingBytes, 1)), 0x20);
    for (let remaining = paddingBytes; remaining > 0; remaining -= piece.length) {
      await handle.write(piece, 0, Math.min(piece.length, remaining));
    }
    await handle.write(tail);
  } finally {
    await handle.close();
  }
}

/** A fresh scratch directory for large fixtures; remove it with `rmSync(dir, { recursive: true, force: true })`. */
export function largeFixtureDirectory(): string {
  return mkdtempSync(join(tmpdir(), "orbit-1567-large-"));
}

/** Writes `bytes` to a file in `directory` and returns the path. */
export function writeFixtureFile(directory: string, name: string, bytes: Buffer): string {
  const path = join(directory, name);
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

export function removeFixtureDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}
