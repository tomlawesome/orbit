import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { log, operationalDetail } from "@/lib/logger";
import {
  type DocumentStructureReason,
  PDF_STRUCTURE_MAX_PAGES,
  PDF_STRUCTURE_PARSER_OPTIONS,
} from "@/server/documents/validation";

/**
 * Opens an untrusted PDF's structure in a worker thread with its own memory
 * cap and a wall-clock limit (#1316, ADR-0038), the standard way to parse
 * hostile input: an isolated, memory-capped, killable worker. A file that
 * makes pdf.js run out of memory, loop or crash costs one worker, which is
 * killed and the file refused as `unsupported_structure`; the server's own
 * thread never runs the parser for this check, so it stays responsive.
 *
 * The cheap pre-parse bound in validation.ts still runs first; this is the
 * fence behind it, for every entry path that bound does not model.
 *
 * The heap cap does not count ArrayBuffer memory, and pdf.js decodes a
 * compressed stream into exactly that, so a watchdog polls the worker's
 * off-heap (`external_memory`) use and kills it past the file's own size plus
 * an allowance, as a cgroup memory limit kills a process. The worker does
 * not inherit the server's environment; a worker thread still shares the
 * process, so this is not isolation from its files or network.
 *
 * Page previews are drawn the same way (#1427, ADR-0038 amendment): one
 * worker opens the file, applies the same gate, and draws the asked-for page
 * to a PNG, so no PDF is read on the server's own thread for any purpose. A
 * render may use twice the check's off-heap allowance, since drawing decodes
 * the content, fonts and images the check never opens. The scratch canvases
 * pdf.js draws on are native memory neither cap sees, so the render worker's
 * own canvas factory books every one against `canvasAllowanceMb` and refuses
 * past it, which stops the render as a memory stop.
 *
 * Every worker must come online within `startupMs`; one that never does is
 * stopped and counted as a crash, so a stuck start cannot hold a slot.
 *
 * TRAP: Node silently ignores a worker's `resourceLimits` when the process
 * runs with a heap flag (`--max-old-space-size`, `--max-semi-space-size`,
 * directly or in NODE_OPTIONS). The wall-clock limit still applies, but the
 * memory cap does not. `sandboxMemoryCapEnforced` detects it; boot warns.
 */

export type PdfStructureSandboxLimits = {
  /** Time a running check may take, from the worker coming online; queueing and start-up do not count. */
  wallMs: number;
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
  stackSizeMb: number;
  /** Off-heap memory a check may use beyond the file itself, which the worker holds; a page render may use twice this. */
  externalAllowanceMb: number;
  /** Live canvas memory (width x height x 4 bytes, summed) a page render may draw on, the page itself included. */
  canvasAllowanceMb: number;
  /** Time a worker may take to come online before it is stopped as a crash. */
  startupMs: number;
  /** How often the watchdog reads the worker's off-heap memory. */
  pollMs: number;
  /** Checks running at once; more wait their turn. */
  concurrency: number;
  /** File URL of the parser module; tests point it elsewhere to force a crash. */
  pdfjsUrl?: string;
};

/** How much more off-heap memory drawing a page may use than the structure check. */
const RENDER_EXTERNAL_ALLOWANCE_FACTOR = 2;

export const PDF_STRUCTURE_SANDBOX_LIMITS: Readonly<PdfStructureSandboxLimits> = Object.freeze({
  // The structure check's long-standing time budget.
  wallMs: 5_000,
  // Legitimate files, including 1,000 pages, parse in about 20 MB; 128 MB
  // leaves room for large real scans while two at once stay small next to
  // the server's own heap.
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4,
  // Decoded streams live outside the heap cap. Legitimate files use a few MB
  // beyond their own size (a 98 MB file measured 104 MB in all); a stream
  // bomb is stopped about half a second in, before the process grows much.
  externalAllowanceMb: 64,
  // Canvases are native memory the two caps above do not see. The largest
  // image the pixel cap admits (a 1-bit 5316x7522 mask) peaks at 208 MiB of
  // live canvas; a soft-mask bomb of a few KB otherwise reaches gigabytes.
  canvasAllowanceMb: 256,
  // A worker comes online in tens of milliseconds; one that has not after
  // this long never will, and would hold its slot forever.
  startupMs: 5_000,
  pollMs: 25,
  concurrency: 2,
});

type Inspector = (bytes: Buffer) => Promise<DocumentStructureReason>;
type StopKind = "timeout" | "memory" | "crash";
type Job = "structure" | "render";

let limits: PdfStructureSandboxLimits = { ...PDF_STRUCTURE_SANDBOX_LIMITS };
let testInspector: Inspector | undefined;
let inFlight = 0;
let running = 0;
const waiting: Array<() => void> = [];
let defaultPdfjsUrl: string | undefined;
let defaultCanvasUrl: string | undefined;
let cachedStandardFontDirectory: string | null | undefined;

const REASONS = new Set<string>(["supported_structure", "unsupported_structure", "password_required"]);

/**
 * The worker body, as source text: the server is bundled and the bundler
 * emits no separate worker file, so the worker is evaluated from this string
 * and imports pdf.js by the file URL the main thread resolved. The parser
 * module is imported outside the try, so a parser that cannot load crashes
 * the worker (logged as a crash) rather than refusing files quietly.
 */
const STRUCTURE_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const { getDocument } = await import(workerData.pdfjsUrl);
  let task;
  let reason = "unsupported_structure";
  try {
    task = getDocument({ ...workerData.options, data: new Uint8Array(workerData.data) });
    const pdf = await task.promise;
    if (pdf.numPages >= 1 && pdf.numPages <= workerData.maxPages) {
      await pdf.getPage(1);
      reason = "supported_structure";
    }
  } catch (error) {
    if (error && error.name === "PasswordException") reason = "password_required";
  } finally {
    if (task) await task.destroy().catch(() => undefined);
  }
  parentPort.postMessage(reason);
})();
`;

/**
 * The page renderer's worker body: the structure check's gate, then the
 * asked-for page drawn on a white page to a PNG of at most `maxEdge` pixels
 * a side, posted back as a transferred buffer. The canvas backend is the one
 * this worker imports, pinned for pdf.js's scratch surfaces (the factory) and
 * for the Path2D and DOMMatrix it reads off globalThis: a second copy of the
 * native addon draws foreign objects Skia refuses (#476, #493).
 */
const RENDER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const { createCanvas, DOMMatrix, Path2D } = await import(workerData.canvasUrl);
  globalThis.Path2D = Path2D;
  globalThis.DOMMatrix = DOMMatrix;
  const { getDocument } = await import(workerData.pdfjsUrl);
  globalThis.Path2D = Path2D;
  globalThis.DOMMatrix = DOMMatrix;
  // Every canvas this worker draws on is booked here before it is allocated,
  // and a request past the allowance is refused with nothing allocated.
  const canvasAllowance = workerData.canvasAllowanceMb * 1024 * 1024;
  let canvasBytes = 0;
  const booked = new WeakMap();
  const book = (bytes) => {
    if (canvasBytes + bytes > canvasAllowance) {
      const error = new Error("canvas allowance exceeded");
      error.code = "canvas_allowance";
      throw error;
    }
    canvasBytes += bytes;
  };
  class CanvasFactory {
    create(width, height) {
      if (!(width > 0 && height > 0)) throw new Error("empty canvas");
      const bytes = width * height * 4;
      book(bytes);
      let canvas;
      try {
        canvas = createCanvas(width, height);
      } catch (error) {
        canvasBytes -= bytes;
        throw error;
      }
      const canvasAndContext = { canvas, context: canvas.getContext("2d") };
      booked.set(canvasAndContext, bytes);
      return canvasAndContext;
    }
    reset(canvasAndContext, width, height) {
      if (!canvasAndContext.canvas || !(width > 0 && height > 0)) throw new Error("empty canvas");
      const bytes = width * height * 4;
      book(bytes - (booked.get(canvasAndContext) ?? 0));
      booked.set(canvasAndContext, bytes);
      canvasAndContext.canvas.width = width;
      canvasAndContext.canvas.height = height;
    }
    destroy(canvasAndContext) {
      canvasBytes -= booked.get(canvasAndContext) ?? 0;
      booked.delete(canvasAndContext);
      if (!canvasAndContext.canvas) return;
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
      canvasAndContext.canvas = null;
      canvasAndContext.context = null;
    }
  }
  let task;
  let result = { outcome: "refused", reason: "unsupported_structure" };
  try {
    task = getDocument({
      ...workerData.options,
      CanvasFactory,
      standardFontDataUrl: workerData.standardFontDataUrl,
      data: new Uint8Array(workerData.data),
    });
    const pdf = await task.promise;
    if (pdf.numPages >= 1 && pdf.numPages <= workerData.maxPages) {
      await pdf.getPage(1);
      result = { outcome: "page_not_found", pageCount: pdf.numPages };
      if (workerData.page <= pdf.numPages) {
        result = { outcome: "failed" };
        const page = await pdf.getPage(workerData.page);
        const unscaled = page.getViewport({ scale: 1 });
        const longest = Math.max(unscaled.width, unscaled.height);
        if (Number.isFinite(longest) && longest > 0) {
          const width = Math.min(workerData.maxEdge, Math.max(1, Math.round(unscaled.width * workerData.maxEdge / longest)));
          const height = Math.min(workerData.maxEdge, Math.max(1, Math.round(unscaled.height * workerData.maxEdge / longest)));
          const viewport = page.getViewport({ scale: width / unscaled.width });
          // The preview's own canvas is outside the factory, so it is booked first.
          book(width * height * 4);
          const canvas = createCanvas(width, height);
          const context = canvas.getContext("2d");
          // Pages are transparent; a preview is shown against unknown chrome.
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, width, height);
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          page.cleanup();
          const png = canvas.toBuffer("image/png");
          const buffer = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
          result = { outcome: "drawn", pageCount: pdf.numPages, png: buffer, width, height };
        }
      }
    }
  } catch (error) {
    if (error && error.name === "PasswordException") result = { outcome: "refused", reason: "password_required" };
    else if (error && error.code === "canvas_allowance") result = { outcome: "failed", stop: "memory" };
    else if (result.outcome !== "refused") result = { outcome: "failed" };
  } finally {
    if (task) await task.destroy().catch(() => undefined);
  }
  parentPort.postMessage(result, result.png ? [result.png] : []);
})();
`;

/** The answer to a page render: drawn, refused as upload would refuse it, no such page, or not drawn. */
export type PdfPageRender =
  | { outcome: "drawn"; pageCount: number; png: Buffer; width: number; height: number }
  | { outcome: "refused"; reason: Exclude<DocumentStructureReason, "supported_structure"> }
  | { outcome: "page_not_found"; pageCount: number }
  | { outcome: "failed"; stop?: StopKind };

function pdfjsUrl(): string {
  if (limits.pdfjsUrl) return limits.pdfjsUrl;
  // Resolved from this module, so the bundled server finds the package
  // beside its own node_modules.
  defaultPdfjsUrl ??= pathToFileURL(createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.mjs")).href;
  return defaultPdfjsUrl;
}

/** The canvas backend's entry, resolved like pdf.js: the copy the server itself ships. */
function canvasUrl(): string {
  defaultCanvasUrl ??= pathToFileURL(createRequire(import.meta.url).resolve("@napi-rs/canvas")).href;
  return defaultCanvasUrl;
}

/** Every place the shipped font data can sit, most specific first. */
function standardFontCandidates(): string[] {
  const candidates: string[] = [];
  const nodeRequire = createRequire(import.meta.url);
  // The entry point first, not `pdfjs-dist/package.json`: a pruned
  // deployment may carry the package without a package.json to resolve.
  const packageRoots: Array<[specifier: string, depth: number]> = [
    ["pdfjs-dist/legacy/build/pdf.mjs", 3],
    ["pdfjs-dist/package.json", 1],
  ];
  for (const [specifier, depth] of packageRoots) {
    try {
      let root = nodeRequire.resolve(specifier);
      for (let step = 0; step < depth; step += 1) root = dirname(root);
      candidates.push(join(root, "standard_fonts"));
    } catch {
      // A specifier that does not resolve simply is not a candidate.
    }
  }
  candidates.push(join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts"));
  return candidates;
}

/**
 * The substitutes pdf.js ships for the standard 14 fonts, as a directory path
 * with a trailing separator (pdf.js reads them through Node's filesystem).
 * Fallible on purpose: without them a page still draws, minus the text of
 * fonts the file did not embed, which beats no preview.
 */
function standardFontDirectory(): string | undefined {
  if (cachedStandardFontDirectory !== undefined) return cachedStandardFontDirectory ?? undefined;
  cachedStandardFontDirectory = null;
  try {
    const found = standardFontCandidates().find((candidate) => existsSync(candidate));
    if (found) cachedStandardFontDirectory = found + sep;
  } catch {
    cachedStandardFontDirectory = null;
  }
  return cachedStandardFontDirectory ?? undefined;
}

/** A first-come, first-served slot: a finished check hands its slot straight to the next in line. */
async function acquire(): Promise<void> {
  if (running < limits.concurrency) {
    running += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

function logStop(job: Job, kind: StopKind, durationMs: number): void {
  if (job === "render") {
    // preview.ts records the refusal itself; a timeout is already named
    // there (processing_interrupted), so only memory and crash say more.
    if (kind === "timeout") return;
    log[kind === "crash" ? "warn" : "info"]({
      event: "document.preview",
      state: "blocked",
      reason: "unsupported_structure",
      action: kind === "crash" ? "check_parser" : "none",
      impact: kind === "crash" ? "application_degraded" : "none",
      durationMs,
      detail: operationalDetail`PDF sandbox stopped the page render: ${kind}`,
    });
    return;
  }
  // A crash would refuse every PDF, so the operator is told; a timeout or
  // memory stop is a refused file. No file detail is ever recorded.
  log[kind === "crash" ? "warn" : "info"]({
    event: "document.inspection",
    state: "blocked",
    reason: "unsupported_structure",
    action: kind === "crash" ? "check_parser" : "none",
    impact: kind === "crash" ? "document_upload_blocked" : "none",
    durationMs,
    detail: operationalDetail`PDF structure sandbox stopped the check: ${kind}`,
  });
}

type WorkerRun = {
  job: Job;
  source: string;
  /** Job-specific fields, beside the file and the parser, which every job gets. */
  workerData: Record<string, unknown>;
  wallMs: number;
  externalAllowanceMb: number;
};

/** A worker's answer, or why it was stopped before giving one. */
type WorkerOutcome = { message: unknown } | { stop: StopKind };

function startWorker(run: WorkerRun, data: ArrayBuffer): Worker {
  return new Worker(run.source, {
    eval: true,
    workerData: {
      ...run.workerData,
      pdfjsUrl: pdfjsUrl(),
      data,
      options: PDF_STRUCTURE_PARSER_OPTIONS,
      maxPages: PDF_STRUCTURE_MAX_PAGES,
    },
    transferList: [data],
    resourceLimits: {
      maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb,
      maxYoungGenerationSizeMb: limits.maxYoungGenerationSizeMb,
      stackSizeMb: limits.stackSizeMb,
    },
    // The worker does not inherit the server's environment; a worker thread
    // still shares the process, so this is not isolation from its files or
    // network.
    env: {},
    // The parser's own console output can quote the file; it is discarded.
    stdout: true,
    stderr: true,
  });
}

/** Whether a worker's answer is its own memory stop, which the main thread logs and reports as one. */
function reportsMemoryStop(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { stop?: unknown }).stop === "memory";
}

function runWorker(bytes: Buffer, run: WorkerRun): Promise<WorkerOutcome> {
  const data = new Uint8Array(bytes).buffer;
  const capBytes = bytes.length + run.externalAllowanceMb * 1024 * 1024;
  let started = Date.now();
  let worker: Worker;
  try {
    worker = startWorker(run, data);
  } catch {
    // No parser could be found or no thread started: every PDF would fail.
    logStop(run.job, "crash", Date.now() - started);
    return Promise.resolve({ stop: "crash" });
  }
  inFlight += 1;
  worker.stdout.resume();
  worker.stderr.resume();

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    const settle = (outcome: WorkerOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(startup);
      clearTimeout(timer);
      clearInterval(watchdog);
      if ("stop" in outcome) logStop(run.job, outcome.stop, Date.now() - started);
      // Wait for the thread to be gone, so the slot and the count mean what
      // they say; a kill that hangs is given up on after a second.
      let backstop: ReturnType<typeof setTimeout> | undefined;
      void Promise.race([
        worker.terminate().catch(() => undefined),
        new Promise((done) => {
          backstop = setTimeout(done, 1_000);
        }),
      ]).then(() => {
        clearTimeout(backstop);
        inFlight -= 1;
        resolve(outcome);
      });
    };
    // Polls the worker's off-heap memory, which its heap cap does not count.
    // A failed read (the worker already gone, or a Node without the call;
    // boot warns) is skipped, and the clock still stops the check.
    let polling = false;
    const poll = async (): Promise<void> => {
      if (polling || settled) return;
      polling = true;
      try {
        const { external_memory: external } = await worker.getHeapStatistics();
        if (external > capBytes) settle({ stop: "memory" });
      } catch {
        // Nothing to judge this time.
      } finally {
        polling = false;
      }
    };
    // A thread that never comes online would hold its slot with no clock
    // running, so start-up has its own, separate deadline.
    const startup = setTimeout(() => settle({ stop: "crash" }), limits.startupMs);
    // The clock and the watchdog start once the thread is running, so a slow
    // start-up does not eat the job's budget.
    worker.once("online", () => {
      if (settled) return;
      clearTimeout(startup);
      started = Date.now();
      timer = setTimeout(() => settle({ stop: "timeout" }), run.wallMs);
      watchdog = setInterval(() => void poll(), limits.pollMs);
    });
    // A worker that stops itself on memory (the render's canvas allowance)
    // says so; it is treated like the watchdog's own stop.
    worker.once("message", (message: unknown) => settle(reportsMemoryStop(message) ? { stop: "memory" } : { message }));
    worker.once("error", (error: Error & { code?: string }) => {
      settle({ stop: error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "memory" : "crash" });
    });
    worker.once("exit", () => settle({ stop: "crash" }));
  });
}

/** Runs one job in a fresh worker once a slot is free. */
async function inSlot(bytes: Buffer, run: WorkerRun): Promise<WorkerOutcome> {
  await acquire();
  try {
    return await runWorker(bytes, run);
  } finally {
    release();
  }
}

/** Opens the PDF in a sandboxed worker: no password, within the page cap, and finds page one. */
export async function inspectPdfStructureInSandbox(bytes: Buffer): Promise<DocumentStructureReason> {
  if (testInspector) return testInspector(bytes);
  const outcome = await inSlot(bytes, {
    job: "structure",
    source: STRUCTURE_SOURCE,
    workerData: {},
    wallMs: limits.wallMs,
    externalAllowanceMb: limits.externalAllowanceMb,
  });
  const message = "message" in outcome ? outcome.message : undefined;
  return typeof message === "string" && REASONS.has(message) ? message as DocumentStructureReason : "unsupported_structure";
}

function isRenderAnswer(message: unknown): message is Record<string, unknown> & { outcome: string } {
  return typeof message === "object" && message !== null && typeof (message as { outcome?: unknown }).outcome === "string";
}

/**
 * Draws one page of a PDF in a sandboxed worker, after the same gate the
 * structure check applies: one worker run per preview, and nothing of the
 * file read on this thread. `wallMs` is the caller's render budget, counted
 * from the worker coming online; the long edge is at most `maxEdge` pixels.
 * Run the cheap pre-parse bound (validation.ts) first, as the check does.
 */
export async function renderPdfPageInSandbox(
  bytes: Buffer,
  request: { page: number; maxEdge: number; wallMs: number },
): Promise<PdfPageRender> {
  const outcome = await inSlot(bytes, {
    job: "render",
    source: RENDER_SOURCE,
    workerData: {
      canvasUrl: canvasUrl(),
      standardFontDataUrl: standardFontDirectory(),
      page: request.page,
      maxEdge: request.maxEdge,
      canvasAllowanceMb: limits.canvasAllowanceMb,
    },
    wallMs: request.wallMs,
    externalAllowanceMb: limits.externalAllowanceMb * RENDER_EXTERNAL_ALLOWANCE_FACTOR,
  });
  if ("stop" in outcome) return { outcome: "failed", stop: outcome.stop };
  const answer = outcome.message;
  if (!isRenderAnswer(answer)) return { outcome: "failed" };
  if (answer.outcome === "refused") {
    return { outcome: "refused", reason: answer.reason === "password_required" ? "password_required" : "unsupported_structure" };
  }
  const pageCount = answer.pageCount;
  if (typeof pageCount !== "number" || !Number.isSafeInteger(pageCount)) return { outcome: "failed" };
  if (answer.outcome === "page_not_found") return { outcome: "page_not_found", pageCount };
  const { png, width, height } = answer;
  if (answer.outcome === "drawn" && png instanceof ArrayBuffer && typeof width === "number" && typeof height === "number") {
    return { outcome: "drawn", pageCount, png: Buffer.from(png), width, height };
  }
  return { outcome: "failed" };
}

/**
 * Whether a worker's memory cap is actually enforced in this process: a
 * trivial capped worker reports its heap limit. False under a heap flag.
 */
export function sandboxMemoryCapEnforced(): Promise<boolean> {
  const capMb = PDF_STRUCTURE_SANDBOX_LIMITS.maxOldGenerationSizeMb + PDF_STRUCTURE_SANDBOX_LIMITS.maxYoungGenerationSizeMb;
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      'require("node:worker_threads").parentPort.postMessage(require("node:v8").getHeapStatistics().heap_size_limit)',
      {
        eval: true,
        resourceLimits: {
          maxOldGenerationSizeMb: PDF_STRUCTURE_SANDBOX_LIMITS.maxOldGenerationSizeMb,
          maxYoungGenerationSizeMb: PDF_STRUCTURE_SANDBOX_LIMITS.maxYoungGenerationSizeMb,
          stackSizeMb: PDF_STRUCTURE_SANDBOX_LIMITS.stackSizeMb,
        },
      },
    );
    worker.unref();
    worker.once("message", (limit: number) => {
      // V8 adds some overhead to the two generations; a heap flag lifts the
      // limit to the flag's value, far past this.
      resolve(limit <= capMb * 1.5 * 1024 * 1024);
      void worker.terminate();
    });
    worker.once("error", reject);
    worker.once("exit", () => reject(new Error("heap limit probe exited without an answer")));
  });
}

/** Overrides some or all limits for a test, over the defaults; `undefined` restores them. */
export function setPdfStructureSandboxLimitsForTests(override: Partial<PdfStructureSandboxLimits> | undefined): void {
  limits = { ...PDF_STRUCTURE_SANDBOX_LIMITS, ...override };
}

/** Replaces the sandbox call with `fn(bytes)` for a test; `undefined` restores it. */
export function setPdfStructureInspectorForTests(fn: Inspector | undefined): void {
  testInspector = fn;
}

/** Workers currently running. */
export function pdfStructureSandboxInFlightForTests(): number {
  return inFlight;
}
