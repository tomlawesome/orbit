import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/**
 * Proves that document previews can actually be drawn by what the image ships
 * (#476, #493, #1436 D10): poppler's pdfinfo and pdftoppm, run through the same
 * /bin/sh wrapper the server uses (so /bin/sh, `ulimit -t` and `ulimit -v` are
 * proven too), on a text-bearing PDF whose font is the standard Helvetica.
 *
 * It asserts that pdfinfo reads `Pages: 1`, that pdftoppm writes a JPEG of at
 * least 20 KB with dark pixels in it (decoded with the shipped
 * `@napi-rs/canvas`), and that fontconfig substitutes Liberation Sans for
 * Helvetica, without which the standard-14 text would draw in whatever font
 * happens to be present, or not at all.
 *
 * It replaces `scripts/web-pdfjs-runtime-check.mjs`. It is a build-time gate
 * in the runner stage and is removed again after it runs.
 *
 *   ORBIT_WEB_RUNTIME_ROOT  the directory whose node_modules holds
 *                           @napi-rs/canvas (default: web/)
 */

/**
 * The server's wrapper, kept identical to `POPPLER_WRAPPER` in
 * src/server/documents/pdf-structure-sandbox.ts: this script runs as plain Node
 * with no TypeScript loader, so it cannot import it.
 */
const WRAPPER = 'ulimit -t "$1" || exit 126; ulimit -v "$2" || exit 126; shift 2; unset PWD SHLVL; exec "$@"';
const CPU_SECONDS = "20";
const ADDRESS_SPACE_KIB = String((256 + 128) * 1024);

/** A one-page PDF of `lines` lines of Helvetica text, enough ink to make a JPEG of some size. */
function syntheticTextPdf(lines = 40) {
  const rows = Array.from({ length: lines }, (_, index) =>
    `BT /F1 12 Tf 54 ${750 - index * 17} Td (Renderer check line ${index + 1}: the quick brown fox jumps over the lazy dog) Tj ET`);
  const pageStream = rows.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(pageStream)} >>\nstream\n${pageStream}\nendstream`,
  ];
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

/** The tool's absolute path on PATH, as the server finds it; the child itself gets an empty environment. */
function onPath(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  throw new Error(`${name} is not on PATH: the image does not ship poppler-utils`);
}

/** Runs a tool through the wrapper with an empty environment, as the server does. */
function wrapped(tool, args) {
  const result = spawnSync("/bin/sh", ["-c", WRAPPER, "orbit-poppler", CPU_SECONDS, ADDRESS_SPACE_KIB, tool, ...args], {
    env: {},
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return result;
}

const run = async () => {
  const projectRoot = resolve(import.meta.dirname, "..");
  const runtimeRoot = resolve(process.env.ORBIT_WEB_RUNTIME_ROOT ?? join(projectRoot, "web"));
  if (!existsSync(join(runtimeRoot, "node_modules"))) throw new Error(`no node_modules under the runtime root ${runtimeRoot}`);

  const pdfinfo = onPath("pdfinfo");
  const pdftoppm = onPath("pdftoppm");
  const fcMatch = onPath("fc-match");

  const directory = mkdtempSync(join(tmpdir(), "orbit-pdf-renderer-check-"));
  try {
    const file = join(directory, "check.pdf");
    writeFileSync(file, syntheticTextPdf(), { mode: 0o600 });

    const info = wrapped(pdfinfo, [file]);
    if (info.status !== 0) throw new Error(`pdfinfo through the wrapper exited ${info.status ?? info.signal}`);
    if (!/^Pages:\s+1\s*$/mu.test(info.stdout.toString("latin1"))) throw new Error("pdfinfo did not read Pages: 1");

    const drawn = wrapped(pdftoppm, ["-f", "1", "-l", "1", "-singlefile", "-cropbox", "-scale-to", "1200", "-jpeg", "-jpegopt", "quality=85,optimize=y", file]);
    if (drawn.status !== 0) throw new Error(`pdftoppm through the wrapper exited ${drawn.status ?? drawn.signal}`);
    const jpeg = drawn.stdout;
    if (jpeg.length < 20 * 1024) throw new Error(`pdftoppm wrote ${jpeg.length} bytes, under the 20 KB a drawn text page makes`);
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) throw new Error("pdftoppm did not write a JPEG");

    const { createCanvas, loadImage } = createRequire(join(runtimeRoot, "package.json"))("@napi-rs/canvas");
    const image = await loadImage(jpeg);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let dark = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] < 128 && pixels[index + 1] < 128 && pixels[index + 2] < 128) dark += 1;
    }
    if (dark < 1_000) throw new Error(`the drawn page has ${dark} dark pixels: the text did not draw`);

    const font = spawnSync(fcMatch, ["Helvetica"], { encoding: "utf8", timeout: 30_000 });
    if (font.status !== 0 || !/Liberation Sans/u.test(font.stdout)) {
      throw new Error("fontconfig does not substitute Liberation Sans for Helvetica: font-liberation is missing or fc-cache was not run");
    }

    console.log(`PDF renderer runtime check passed: Pages: 1, a ${image.width}x${image.height} JPEG of ${jpeg.length} bytes with ${dark} dark pixels, Helvetica as Liberation Sans`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

run().catch((error) => {
  console.error(`PDF renderer runtime check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
