import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Proves that page-one document previews (#476) can actually be RENDERED by
 * the artefacts the image ships — not merely that the packages are listed.
 *
 * It replaces `scripts/standalone-pdfjs-runtime-check.mjs`, which asserted the
 * same thing against Next's traced standalone output before the cut (#735).
 * The output it inspects is now SvelteKit's adapter-node build plus the
 * production `node_modules` that `pnpm deploy` prunes for it; the proof is
 * unchanged, because the failure it guards against is unchanged.
 *
 * That failure is specific and has happened: #493 root-caused a container 422
 * to triplicated `@napi-rs/canvas` copies, which broke `page.render` while
 * leaving `getDocument` and `numPages` working perfectly. Parsing a PDF is not
 * rendering one, so this script draws a real text-bearing page and counts the
 * pixels.
 *
 * Two roots, because they are one directory in the image and two in a
 * checkout:
 *   ORBIT_WEB_RUNTIME_ROOT  the directory whose node_modules serves the app
 *                           (default: web/)
 *   ORBIT_WEB_BUILD_ROOT    the adapter-node output, holding server/
 *                           (default: web/build/)
 */

/**
 * A minimal, self-contained text-bearing PDF (mirrors
 * `tests/support/synthetic-documents.ts`'s `syntheticPdf`, duplicated here
 * rather than imported: this script runs as plain Node against built output,
 * with no TypeScript loader available for `@/` path aliases or the
 * `tests/support` helper).
 */
function syntheticTextPdf(contents = "Web render check") {
  const escaped = contents.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const pageStream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
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

/** Every `.js` file under a directory, depth-first. */
function javascriptFiles(directory) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".js")) found.push(path);
    }
  };
  walk(directory);
  return found;
}

const run = async () => {
  const projectRoot = resolve(import.meta.dirname, "..");
  const runtimeRoot = resolve(process.env.ORBIT_WEB_RUNTIME_ROOT ?? join(projectRoot, "web"));
  const buildRoot = resolve(process.env.ORBIT_WEB_BUILD_ROOT ?? join(projectRoot, "web", "build"));

  if (!existsSync(join(runtimeRoot, "node_modules"))) {
    throw new Error(`no node_modules under the runtime root ${runtimeRoot}`);
  }

  /* Resolution starts at the runtime root, which is where the built server's
     own chunks resolve from: Node walks up from the importing file, and in the
     image the chunks sit under the directory that holds this node_modules. */
  const runtimeRequire = createRequire(join(runtimeRoot, "package.json"));

  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("unsupported runtime architecture");
  }

  /* The native binding is the thing that breaks, and it breaks by loading a
     copy built for the wrong libc. Requiring it is the only honest test:
     @napi-rs/canvas picks its own .node file at import time. */
  const canvas = runtimeRequire("@napi-rs/canvas");
  if (typeof canvas.createCanvas !== "function") throw new Error("missing native canvas import");

  const pdfjsEntry = runtimeRequire.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  if (!existsSync(pdfjsEntry)) throw new Error("missing PDF.js runtime");

  /* Page-one previews render text a document did not embed using the
     standard-14 substitutes shipped inside pdfjs-dist. `pnpm deploy` copies
     whole packages, so this is not the file-tracing hazard it was under Next —
     but a pruning change that dropped the font data would still show up only
     as blank text in a shipped image, so it is asserted rather than assumed.
     The path is taken the same way src/server/documents/preview.ts takes it:
     from the resolved entry point, up three, then look beside it. */
  const standardFonts = resolve(pdfjsEntry, "..", "..", "..", "standard_fonts");
  if (!existsSync(standardFonts) || !readdirSync(standardFonts).includes("LiberationSans-Regular.ttf")) {
    throw new Error("missing PDF.js standard font data");
  }

  /* Both packages must stay OUTSIDE the bundle: pdfjs-dist resolves worker and
     cmap assets by on-disk path, @napi-rs/canvas is a native addon, and a
     bundler that inlined either would produce an output that imports nothing
     and fails at the first render. The bare specifier surviving into a server
     chunk is what proves the adapter externalised them; this is the successor
     to the traced-chunk assertion the Next-era check made. */
  const serverRoot = join(buildRoot, "server");
  if (!existsSync(serverRoot) || !statSync(serverRoot).isDirectory()) {
    throw new Error(`no adapter-node server output under ${buildRoot}`);
  }
  const chunkSources = javascriptFiles(serverRoot).map((path) => readFileSync(path, "utf8"));
  for (const specifier of ["pdfjs-dist/legacy/build/pdf.mjs", "@napi-rs/canvas"]) {
    if (!chunkSources.some((source) => source.includes(`from '${specifier}'`) || source.includes(`from "${specifier}"`))) {
      throw new Error(`${specifier} is not imported as an external package by the built server`);
    }
  }

  const pdfjs = await import(pathToFileURL(pdfjsEntry).href);
  if (typeof pdfjs.getDocument !== "function") throw new Error("missing PDF.js getDocument export");

  /* Draw a text-bearing page with the shipped native canvas, the way
     src/server/documents/preview.ts does — pinning the same globals PDF.js
     polyfills onto (see that file's `pinRenderingGlobals`), so a reintroduced
     packaging duplication (foreign Skia types) fails here instead of shipping
     silently. */
  const { createCanvas, Path2D, DOMMatrix } = canvas;
  const globals = globalThis;
  if (globals.Path2D !== Path2D) globals.Path2D = Path2D;
  if (globals.DOMMatrix !== DOMMatrix) globals.DOMMatrix = DOMMatrix;
  class CheckCanvasFactory {
    create(width, height) {
      const created = createCanvas(width, height);
      return { canvas: created, context: created.getContext("2d") };
    }
    reset(canvasAndContext, width, height) {
      canvasAndContext.canvas.width = width;
      canvasAndContext.canvas.height = height;
    }
    destroy(canvasAndContext) {
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
      canvasAndContext.canvas = null;
      canvasAndContext.context = null;
    }
  }
  const renderTask = pdfjs.getDocument({
    data: new Uint8Array(syntheticTextPdf("Web render check")),
    CanvasFactory: CheckCanvasFactory,
    standardFontDataUrl: standardFonts + sep,
    disableAutoFetch: true,
    disableFontFace: true,
    disableRange: true,
    disableStream: true,
    enableScripting: false,
    enableXfa: false,
    isEvalSupported: false,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    stopAtErrors: true,
    useSystemFonts: false,
    useWasm: false,
    useWorkerFetch: false,
    verbosity: 0,
  });
  try {
    const pdf = await renderTask.promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const renderedCanvas = createCanvas(viewport.width, viewport.height);
    const context = renderedCanvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, viewport.width, viewport.height);
    await page.render({ canvas: renderedCanvas, canvasContext: context, viewport }).promise;
    page.cleanup();
    const pixels = context.getImageData(0, 0, viewport.width, viewport.height).data;
    let nonWhitePixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset] !== 255 || pixels[offset + 1] !== 255 || pixels[offset + 2] !== 255) nonWhitePixels += 1;
    }
    if (nonWhitePixels === 0) {
      throw new Error("rendered page has no drawn pixels — text did not reach the canvas");
    }
    console.log(
      `Web PDF.js runtime check passed: pdfjs-dist ${runtimeRequire("pdfjs-dist/package.json").version}, ` +
        `@napi-rs/canvas ${runtimeRequire("@napi-rs/canvas/package.json").version}, ${nonWhitePixels} pixels drawn`,
    );
  } finally {
    await renderTask.destroy();
  }
};

try {
  await run();
} catch (error) {
  console.error("Web PDF.js runtime check failed:", error);
  process.exitCode = 1;
}
