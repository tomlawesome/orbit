import { readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";

/**
 * Image fixtures for the sandbox and memory tests (#1572). Test code only: the
 * server never loads the canvas backend, but a test may use it to make a file.
 */

/** Edge of the largest square the 40 Mpx cap allows: 6324 x 6324 = 39,992,976 pixels. */
export const AT_CAP_EDGE = 6_324;

/**
 * A solid-colour, progressive, 6324 x 6324 JPEG of about 0.23 MiB, made
 * outside the repository (recipe in the commit that added it). A progressive
 * decode holds every coefficient of the image at once, which is what made the
 * in-process decode grow the server by 153-294 MiB.
 */
export const PROGRESSIVE_40MPX_PATH = new URL("../fixtures/images/progressive-40mpx.jpg", import.meta.url);

export function progressive40Mpx(): Buffer {
  return readFileSync(PROGRESSIVE_40MPX_PATH);
}

/** A real, decodable solid raster of the requested size, encoded by the canvas backend. */
export function solidRaster(mediaType: "image/jpeg" | "image/png", width: number, height: number): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#204070";
  context.fillRect(0, 0, width, height);
  return mediaType === "image/jpeg" ? canvas.toBuffer("image/jpeg", 90) : canvas.toBuffer("image/png");
}

/** `image` followed by zero bytes up to exactly `totalBytes`, after the EOI marker or the IEND chunk, where a decoder stops reading. */
export function paddedImage(image: Buffer, totalBytes: number): Buffer {
  if (totalBytes < image.length) throw new Error(`${totalBytes} bytes is smaller than the image (${image.length})`);
  return Buffer.concat([image, Buffer.alloc(totalBytes - image.length)]);
}

/** The same file, written in 1 MiB pieces so a 50 MiB fixture is not itself held whole. */
export async function writePaddedImageFile(path: string, image: Buffer, totalBytes: number): Promise<void> {
  if (totalBytes < image.length) throw new Error(`${totalBytes} bytes is smaller than the image (${image.length})`);
  const handle = await open(path, "w", 0o600);
  try {
    await handle.write(image);
    const piece = Buffer.alloc(Math.min(1_048_576, Math.max(1, totalBytes - image.length)));
    for (let remaining = totalBytes - image.length; remaining > 0; remaining -= piece.length) {
      await handle.write(piece, 0, Math.min(piece.length, remaining));
    }
  } finally {
    await handle.close();
  }
}
