import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve, sep } from "node:path";

/**
 * A minimal, self-contained text-bearing PDF (mirrors
 * `tests/support/synthetic-documents.ts`'s `syntheticPdf`, duplicated here
 * rather than imported: this script runs as plain Node against the built
 * standalone output, with no TypeScript loader available for `@/` path
 * aliases or the `tests/support` helper).
 */
function syntheticTextPdf(contents = "Standalone render check") {
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

const run = async () => {
  const projectRoot = resolve(import.meta.dirname, "..");
  const standaloneRoot = process.env.ORBIT_STANDALONE_ROOT
    ? resolve(process.env.ORBIT_STANDALONE_ROOT)
    : resolve(projectRoot, ".next", "standalone");
  const packageJson = JSON.parse(readFileSync(resolve(standaloneRoot, "package.json"), "utf8"));
  const pdfjsVersion = packageJson.dependencies["pdfjs-dist"];
  const canvasVersion = packageJson.dependencies["@napi-rs/canvas"];
  if (pdfjsVersion !== "6.2.108" || canvasVersion !== "1.0.3") {
    throw new Error("unexpected runtime versions");
  }
  const pdfjsRoot = resolve(standaloneRoot, "node_modules", ".pnpm", `pdfjs-dist@${pdfjsVersion}`, "node_modules", "pdfjs-dist");
  const pdfjsEntry = resolve(pdfjsRoot, "legacy", "build", "pdf.mjs");
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("unsupported runtime architecture");
  }
  const detectedNativePackage = process.report?.getReport?.().header?.glibcVersionRuntime
    ? "canvas-linux-x64-gnu"
    : "canvas-linux-x64-musl";
  // The override is reserved for explicit cross-libc diagnostics; normal builds detect the running libc.
  const nativePackage = process.env.ORBIT_EXPECTED_NATIVE_PACKAGE ?? detectedNativePackage;
  if (!new Set(["canvas-linux-x64-gnu", "canvas-linux-x64-musl"]).has(nativePackage)) {
    throw new Error("unsupported native runtime");
  }
  const nativeRoot = resolve(standaloneRoot, "node_modules", ".pnpm", `@napi-rs+${nativePackage}@${canvasVersion}`, "node_modules", "@napi-rs", nativePackage);
  const serverChunks = resolve(standaloneRoot, ".next", "server", "chunks");

  if (!existsSync(pdfjsEntry)) {
    throw new Error("missing PDF.js runtime");
  }
  if (!existsSync(nativeRoot) || !readdirSync(nativeRoot).some((name) => name.endsWith(".node"))) {
    throw new Error("missing native canvas runtime");
  }

  const validatorChunkFound = readdirSync(serverChunks)
    .filter((name) => name.endsWith(".js"))
    .map((name) => resolve(serverChunks, name))
    .some((path) => {
      const source = readFileSync(path, "utf8");
      return source.includes("pdfjs-dist-") && source.includes("/legacy/build/pdf.mjs");
    });
  if (!validatorChunkFound) throw new Error("missing traced PDF.js validator chunk");

  const standaloneRequire = createRequire(resolve(standaloneRoot, "package.json"));
  const canvas = standaloneRequire("@napi-rs/canvas");
  if (typeof canvas.createCanvas !== "function") throw new Error("missing native canvas import");

  // Page-one previews (#476) render text a document did not embed using the
  // standard-14 substitutes shipped inside pdfjs-dist. Next.js traces only the
  // files it sees imported, so their presence is asserted here rather than
  // discovered as blank text in a shipped image. The assertion takes the same
  // route the renderer does — resolve the traced entry point, then look beside
  // it — because the standalone copy of `node_modules/pdfjs-dist` holds only
  // traced files and so has no package.json to resolve through.
  const standardFonts = resolve(
    standaloneRequire.resolve("pdfjs-dist/legacy/build/pdf.mjs"),
    "..",
    "..",
    "..",
    "standard_fonts",
  );
  if (!existsSync(standardFonts) || !readdirSync(standardFonts).includes("LiberationSans-Regular.ttf")) {
    throw new Error("missing PDF.js standard font data");
  }

  const pdfjs = await import(pathToFileURL(pdfjsEntry).href);
  if (typeof pdfjs.getDocument !== "function") throw new Error("missing PDF.js getDocument export");
  const fixturePath = process.env.ORBIT_PDF_FIXTURE;
  if (fixturePath) {
    const task = pdfjs.getDocument({
      data: new Uint8Array(readFileSync(fixturePath)),
      disableAutoFetch: true,
      disableFontFace: true,
      disableRange: true,
      disableStream: true,
      enableScripting: false,
      enableXfa: true,
      isEvalSupported: false,
      isImageDecoderSupported: false,
      isOffscreenCanvasSupported: false,
      stopAtErrors: true,
      useSystemFonts: false,
      useWasm: false,
      useWorkerFetch: false,
    });
    try {
      const pdf = await task.promise;
      if (pdf.numPages < 1) throw new Error("PDF.js produced no pages");
    } finally {
      await task.destroy();
    }
  }

  // Parsing metadata (above) is not rendering: #493 root-caused a container
  // 422 that this check did not catch, because the standalone image's
  // triplicated `@napi-rs/canvas` copies broke `page.render` while leaving
  // `getDocument`/`numPages` untouched. This step actually draws a
  // text-bearing page with the standalone build's own native canvas, the way
  // `src/server/documents/preview.ts` does — pinning the same globals PDF.js
  // polyfills onto (see that file's `pinRenderingGlobals`), so a
  // reintroduced packaging duplication (foreign Skia types) fails this check
  // instead of shipping silently.
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
    data: new Uint8Array(syntheticTextPdf("Standalone render check")),
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
  } finally {
    await renderTask.destroy();
  }
};

try {
  await run();
  console.log("Standalone PDF.js runtime check passed");
} catch (error) {
  console.error("Standalone PDF.js runtime check failed:", error);
  process.exitCode = 1;
}
