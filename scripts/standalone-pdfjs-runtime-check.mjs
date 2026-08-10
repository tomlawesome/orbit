import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

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
};

try {
  await run();
  console.log("Standalone PDF.js runtime check passed");
} catch {
  console.error("Standalone PDF.js runtime check failed");
  process.exitCode = 1;
}
