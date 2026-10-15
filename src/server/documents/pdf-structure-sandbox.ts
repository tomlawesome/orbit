import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { log, operationalDetail } from "@/lib/logger";
import {
  type DocumentStructureReason,
  PDF_STRUCTURE_MAX_PAGES,
  PDF_STRUCTURE_PARSER_OPTIONS,
} from "@/server/documents/validation";

/**
 * Opens an untrusted PDF in a short-lived child process of its own, killed at
 * a process-memory ceiling and a wall-clock limit (#1316, #1427, ADR-0038):
 * the standard way to handle hostile input, one process per untrusted
 * document under a supervisor that kills, as browsers run a renderer and a
 * cgroup `memory.max` bounds a service. A file that makes pdf.js run out of
 * memory, loop or crash costs one child, which is killed and the file
 * refused as `unsupported_structure`; the server never runs the parser, so it
 * stays responsive and its own memory does not grow.
 *
 * The cheap pre-parse bound in validation.ts still runs first; this is the
 * fence behind it, for every entry path that bound does not model.
 *
 * The fence is the child's resident-set size (`VmRSS` in `/proc/<pid>/status`),
 * read every `pollMs`: it counts everything the child allocates, V8 heap,
 * decoded streams, Skia canvases, patterns, images and fonts alike, with no
 * bookkeeping of ours. Past the job's ceiling plus the file's size (the child
 * holds a copy) the child is killed with SIGKILL and the stop is memory. The
 * child's own V8 flags cap its heap first, and `ulimit -d` (RLIMIT_DATA) at
 * the ceiling plus 1.5 GB is a kernel-enforced backstop should the server's
 * event loop be too busy to poll. The child gets an empty environment; it
 * still shares the server's files and network.
 *
 * Page previews are drawn the same way: one child opens the file, applies the
 * same gate, and draws the asked-for page to a PNG, so no PDF is read in the
 * server's process for any purpose.
 *
 * Every child must say it is ready within `startupMs`; one that never does is
 * stopped and counted as a crash, so a stuck start cannot hold a slot.
 */

export type PdfStructureSandboxLimits = {
  /** Time a running check may take, from the child saying it is ready; queueing and start-up do not count. */
  wallMs: number;
  /** The child's V8 old-generation heap cap (its own `--max-old-space-size`). */
  heapMb: number;
  /** Process memory (RSS) a structure check may use beyond the file itself, which the child holds. */
  structureMemoryMb: number;
  /** Process memory (RSS) a page render may use beyond the file itself. */
  renderMemoryMb: number;
  /** Time a child may take from spawn to ready, the file's hand-over included, before it is stopped as a crash. */
  startupMs: number;
  /** How often the watchdog reads the child's memory. */
  pollMs: number;
  /** Checks running at once; more wait their turn. */
  concurrency: number;
  /** File URL of the parser module; tests point it elsewhere to force a crash. */
  pdfjsUrl?: string;
};

export const PDF_STRUCTURE_SANDBOX_LIMITS: Readonly<PdfStructureSandboxLimits> = Object.freeze({
  // The structure check's long-standing time budget.
  wallMs: 5_000,
  // Legitimate files, including 1,000 pages, parse in about 20 MB of heap; a
  // runaway allocation hits this within a second or two.
  heapMb: 128,
  // Measured child RSS (owner decision, 2026-10-15; reducing these is #1436):
  // a check of a 98 MB file peaks at 302 MB with the file included, so 320
  // plus the file is about twice the non-file part.
  structureMemoryMb: 320,
  // The largest legitimate render measured (a 1-bit 5316x7522 image mask, the
  // biggest image the 40 Mpx cap admits) peaks at 458 MB.
  renderMemoryMb: 768,
  // A child is ready in about 0.3 s; one that is not after this long never
  // will, and would hold its slot forever.
  startupMs: 5_000,
  pollMs: 25,
  concurrency: 2,
});

/** The child's young-generation cap and stack, fixed: no test needs to move them. */
const SEMI_SPACE_MB = 8;
const STACK_SIZE_KB = 3_900;
/**
 * RLIMIT_DATA sits this far above the RSS ceiling: V8 reserves about 1 GB of
 * data segment it never touches, so this puts the kernel's limit about half
 * a gigabyte above the watchdog's.
 */
const DATA_LIMIT_HEADROOM_MB = 1_536;
/** How much of the child's stderr is kept, in memory only, to recognise an out-of-memory end. */
const STDERR_TAIL_CHARS = 4_096;
/** Fixed library messages a child prints when it dies of memory: V8's heap cap, and the allocator under RLIMIT_DATA. */
const OUT_OF_MEMORY_MESSAGES = ["JavaScript heap out of memory", "std::bad_alloc"];
/** A kill that has not ended the child after this long is given up on. */
const EXIT_BACKSTOP_MS = 1_000;
const MiB = 1024 * 1024;

/** Runs `node` under `ulimit -d`; the limit and node's own arguments follow as positional parameters. */
const SANDBOX_SHELL = "/bin/sh";
const SANDBOX_WRAPPER = 'ulimit -d "$1"; shift; exec "$@"';

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
 * The child's body, as source text run with `node -e`: the server is bundled
 * and the bundler emits no separate file for it, so pdf.js is imported by the
 * file URL the server resolved, passed on the command line. The message
 * listener is registered before anything else, so the job the server sends
 * right after spawning is never missed; the child says it is ready only once
 * the parser is loaded and the job has arrived. A parser that cannot load
 * crashes the child (logged as a crash) rather than refusing files quietly.
 */
const STRUCTURE_SOURCE = `
const received = new Promise((resolve) => process.on("message", resolve));
(async () => {
  const { getDocument } = await import(process.argv[1]);
  const job = await received;
  await new Promise((resolve) => process.send({ ready: true }, resolve));
  let task;
  let reason = "unsupported_structure";
  try {
    task = getDocument({ ...job.options, data: new Uint8Array(job.data.buffer, job.data.byteOffset, job.data.byteLength) });
    const pdf = await task.promise;
    if (pdf.numPages >= 1 && pdf.numPages <= job.maxPages) {
      await pdf.getPage(1);
      reason = "supported_structure";
    }
  } catch (error) {
    if (error && error.name === "PasswordException") reason = "password_required";
  } finally {
    if (task) await task.destroy().catch(() => undefined);
  }
  process.send(reason, () => process.exit(0));
})();
`;

/**
 * The page renderer's child body: the structure check's gate, then the
 * asked-for page drawn on a white page to a PNG of at most `maxEdge` pixels
 * a side. The canvas backend is the one this child imports, pinned for
 * pdf.js's scratch surfaces (the factory) and for the Path2D and DOMMatrix it
 * reads off globalThis: a second copy of the native addon draws foreign
 * objects Skia refuses (#476, #493). The factory only makes and clears
 * canvases; their memory is the child's, which the watchdog reads whole.
 */
const RENDER_SOURCE = `
const received = new Promise((resolve) => process.on("message", resolve));
(async () => {
  const [pdfjsUrl, canvasUrl, standardFontDirectory] = process.argv.slice(1);
  const { createCanvas, DOMMatrix, Path2D } = await import(canvasUrl);
  globalThis.Path2D = Path2D;
  globalThis.DOMMatrix = DOMMatrix;
  const { getDocument } = await import(pdfjsUrl);
  globalThis.Path2D = Path2D;
  globalThis.DOMMatrix = DOMMatrix;
  class CanvasFactory {
    create(width, height) {
      if (!(width > 0 && height > 0)) throw new Error("empty canvas");
      const canvas = createCanvas(width, height);
      return { canvas, context: canvas.getContext("2d") };
    }
    reset(canvasAndContext, width, height) {
      if (!canvasAndContext.canvas || !(width > 0 && height > 0)) throw new Error("empty canvas");
      canvasAndContext.canvas.width = width;
      canvasAndContext.canvas.height = height;
    }
    destroy(canvasAndContext) {
      if (!canvasAndContext.canvas) return;
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
      canvasAndContext.canvas = null;
      canvasAndContext.context = null;
    }
  }
  const job = await received;
  await new Promise((resolve) => process.send({ ready: true }, resolve));
  let task;
  let result = { outcome: "refused", reason: "unsupported_structure" };
  try {
    task = getDocument({
      ...job.options,
      CanvasFactory,
      standardFontDataUrl: standardFontDirectory || undefined,
      data: new Uint8Array(job.data.buffer, job.data.byteOffset, job.data.byteLength),
    });
    const pdf = await task.promise;
    if (pdf.numPages >= 1 && pdf.numPages <= job.maxPages) {
      await pdf.getPage(1);
      result = { outcome: "page_not_found", pageCount: pdf.numPages };
      if (job.page <= pdf.numPages) {
        result = { outcome: "failed" };
        const page = await pdf.getPage(job.page);
        const unscaled = page.getViewport({ scale: 1 });
        const longest = Math.max(unscaled.width, unscaled.height);
        if (Number.isFinite(longest) && longest > 0) {
          const width = Math.min(job.maxEdge, Math.max(1, Math.round(unscaled.width * job.maxEdge / longest)));
          const height = Math.min(job.maxEdge, Math.max(1, Math.round(unscaled.height * job.maxEdge / longest)));
          const viewport = page.getViewport({ scale: width / unscaled.width });
          const canvas = createCanvas(width, height);
          const context = canvas.getContext("2d");
          // Pages are transparent; a preview is shown against unknown chrome.
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, width, height);
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          page.cleanup();
          result = { outcome: "drawn", pageCount: pdf.numPages, png: canvas.toBuffer("image/png"), width, height };
        }
      }
    }
  } catch (error) {
    if (error && error.name === "PasswordException") result = { outcome: "refused", reason: "password_required" };
    else if (result.outcome !== "refused") result = { outcome: "failed" };
  } finally {
    if (task) await task.destroy().catch(() => undefined);
  }
  process.send(result, () => process.exit(0));
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

/**
 * Starts `node` with `nodeArgs` under the sandbox's wrapper: `/bin/sh` sets
 * RLIMIT_DATA and execs node, so the limit is the node process's own. The
 * environment is empty: the server's secrets are not the child's business.
 */
function spawnSandboxedNode(
  dataLimitKb: number,
  nodeArgs: string[],
  stdio: Array<"ignore" | "pipe" | "ipc">,
): ChildProcess {
  return spawn(SANDBOX_SHELL, ["-c", SANDBOX_WRAPPER, "sh", String(dataLimitKb), process.execPath, ...nodeArgs], {
    stdio,
    serialization: "advanced",
    env: {},
  });
}

/** The child's resident-set size in bytes, from the kernel; undefined if it cannot be read. */
function residentBytes(pid: number): number | undefined {
  // `status` reports kB whatever the page size, unlike `statm`.
  const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(readFileSync(`/proc/${pid}/status`, "latin1"));
  return match ? Number(match[1]) * 1024 : undefined;
}

type ChildRun = {
  job: Job;
  source: string;
  /** Command-line arguments for the child's source, after `--`. */
  args: string[];
  /** Job-specific fields, beside the file and the parser options, which every job gets. */
  message: Record<string, unknown>;
  wallMs: number;
  /** The job's RSS ceiling before the file's own size is added. */
  memoryMb: number;
};

/** A child's answer, or why it was stopped before giving one. */
type ChildOutcome = { message: unknown } | { stop: StopKind };

function isReady(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { ready?: unknown }).ready === true;
}

function startChild(run: ChildRun, dataLimitKb: number): ChildProcess {
  return spawnSandboxedNode(dataLimitKb, [
    `--max-old-space-size=${limits.heapMb}`,
    `--max-semi-space-size=${SEMI_SPACE_MB}`,
    `--stack-size=${STACK_SIZE_KB}`,
    "-e",
    run.source,
    "--",
    ...run.args,
  // stdout is discarded: the parser's own output can quote the file.
  ], ["ignore", "ignore", "pipe", "ipc"]);
}

function runChild(bytes: Buffer, run: ChildRun): Promise<ChildOutcome> {
  let started = Date.now();
  const ceilingBytes = run.memoryMb * MiB + bytes.length;
  const dataLimitKb = (run.memoryMb + DATA_LIMIT_HEADROOM_MB) * 1024 + Math.ceil(bytes.length / 1024);
  let child: ChildProcess;
  try {
    child = startChild(run, dataLimitKb);
  } catch {
    // No process could be started: every PDF would fail.
    logStop(run.job, "crash", Date.now() - started);
    return Promise.resolve({ stop: "crash" });
  }
  inFlight += 1;
  const exited = new Promise<void>((done) => {
    child.once("exit", () => done());
    child.once("error", () => {
      // A child that never started has no exit to wait for.
      if (child.pid === undefined) done();
    });
  });

  return new Promise((resolve) => {
    let settled = false;
    let ready = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The stderr tail is held in memory only to recognise the two fixed
    // out-of-memory messages; it is never logged, since it can quote the file.
    let stderrTail = "";
    const settle = (outcome: ChildOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(startup);
      clearTimeout(timer);
      clearInterval(watchdog);
      if ("stop" in outcome) logStop(run.job, outcome.stop, Date.now() - started);
      // Always killed, answer or not, and waited for, so the slot and the
      // count mean what they say; a kill that hangs is given up on after a second.
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      let backstop: ReturnType<typeof setTimeout> | undefined;
      void Promise.race([
        exited,
        new Promise((done) => {
          backstop = setTimeout(done, EXIT_BACKSTOP_MS);
        }),
      ]).then(() => {
        clearTimeout(backstop);
        inFlight -= 1;
        resolve(outcome);
      });
    };
    // The fence: the child's whole resident memory, from spawn on. A failed
    // read (the child already gone, or no /proc; boot warns) is skipped, and
    // the clock still stops the job.
    const watchdog = setInterval(() => {
      if (settled || child.pid === undefined) return;
      try {
        const resident = residentBytes(child.pid);
        if (resident !== undefined && resident > ceilingBytes) settle({ stop: "memory" });
      } catch {
        // Nothing to judge this time.
      }
    }, limits.pollMs);
    // A child that never says it is ready would hold its slot with no clock
    // running, so start-up has its own, separate deadline.
    const startup = setTimeout(() => settle({ stop: "crash" }), limits.startupMs);

    child.stderr?.setEncoding("latin1");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on("message", (message: unknown) => {
      if (settled) return;
      if (ready) {
        settle({ message });
        return;
      }
      if (!isReady(message)) {
        settle({ stop: "crash" });
        return;
      }
      // The clock starts once the child is ready, so a slow start-up or a
      // large file's hand-over does not eat the job's budget.
      ready = true;
      clearTimeout(startup);
      started = Date.now();
      timer = setTimeout(() => settle({ stop: "timeout" }), run.wallMs);
    });
    child.once("error", () => settle({ stop: "crash" }));
    // An end without an answer: memory if the child said it ran out of it,
    // otherwise a crash. `close` comes after stderr is drained.
    child.once("close", () => {
      settle({ stop: OUT_OF_MEMORY_MESSAGES.some((text) => stderrTail.includes(text)) ? "memory" : "crash" });
    });

    try {
      child.send({
        ...run.message,
        data: bytes,
        options: PDF_STRUCTURE_PARSER_OPTIONS,
        maxPages: PDF_STRUCTURE_MAX_PAGES,
      }, () => {
        // A child that cannot take the job is judged by how it ends.
      });
    } catch {
      settle({ stop: "crash" });
    }
  });
}

/** Runs one job in a fresh child once a slot is free. */
async function inSlot(bytes: Buffer, run: ChildRun): Promise<ChildOutcome> {
  await acquire();
  try {
    return await runChild(bytes, run);
  } finally {
    release();
  }
}

/** Opens the PDF in a sandboxed child: no password, within the page cap, and finds page one. */
export async function inspectPdfStructureInSandbox(bytes: Buffer): Promise<DocumentStructureReason> {
  if (testInspector) return testInspector(bytes);
  let args: string[];
  try {
    args = [pdfjsUrl()];
  } catch {
    logStop("structure", "crash", 0);
    return "unsupported_structure";
  }
  const outcome = await inSlot(bytes, {
    job: "structure",
    source: STRUCTURE_SOURCE,
    args,
    message: {},
    wallMs: limits.wallMs,
    memoryMb: limits.structureMemoryMb,
  });
  const message = "message" in outcome ? outcome.message : undefined;
  return typeof message === "string" && REASONS.has(message) ? message as DocumentStructureReason : "unsupported_structure";
}

function isRenderAnswer(message: unknown): message is Record<string, unknown> & { outcome: string } {
  return typeof message === "object" && message !== null && typeof (message as { outcome?: unknown }).outcome === "string";
}

/**
 * Draws one page of a PDF in a sandboxed child, after the same gate the
 * structure check applies: one child per preview, and nothing of the file
 * read in this process. `wallMs` is the caller's render budget, counted from
 * the child saying it is ready; the long edge is at most `maxEdge` pixels.
 * Run the cheap pre-parse bound (validation.ts) first, as the check does.
 */
export async function renderPdfPageInSandbox(
  bytes: Buffer,
  request: { page: number; maxEdge: number; wallMs: number },
): Promise<PdfPageRender> {
  let args: string[];
  try {
    args = [pdfjsUrl(), canvasUrl(), standardFontDirectory() ?? ""];
  } catch {
    logStop("render", "crash", 0);
    return { outcome: "failed", stop: "crash" };
  }
  const outcome = await inSlot(bytes, {
    job: "render",
    source: RENDER_SOURCE,
    args,
    message: { page: request.page, maxEdge: request.maxEdge },
    wallMs: request.wallMs,
    memoryMb: limits.renderMemoryMb,
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
  if (answer.outcome === "drawn" && ArrayBuffer.isView(png) && typeof width === "number" && typeof height === "number") {
    return { outcome: "drawn", pageCount, png: Buffer.from(png.buffer, png.byteOffset, png.byteLength), width, height };
  }
  return { outcome: "failed" };
}

/** What the sandbox self-check found missing; each leaves the sandbox weaker in its own way. */
export type PdfSandboxSelfCheckProblem = "child_not_started" | "data_limit_not_applied" | "proc_unreadable";

/**
 * A child started exactly as a job's is, `ulimit -d` wrapper and all, with a
 * trivial script that reports its own `VmRSS` and data limit from `/proc`;
 * the server also reads the child's `/proc/<pid>/status` once. Resolves with
 * the first thing missing, or undefined when the sandbox has everything it
 * relies on: `/bin/sh`, a working `ulimit -d`, and a readable `/proc`.
 */
export function pdfSandboxSelfCheck(): Promise<PdfSandboxSelfCheckProblem | undefined> {
  const dataLimitKb = (PDF_STRUCTURE_SANDBOX_LIMITS.renderMemoryMb + DATA_LIMIT_HEADROOM_MB) * 1024;
  const source = `
const { readFileSync } = require("node:fs");
const read = (path, pattern) => { try { return pattern.exec(readFileSync(path, "latin1"))?.[1] ?? null; } catch { return null; } };
process.on("message", () => process.exit(0));
process.send({
  residentKb: read("/proc/self/status", /^VmRSS:\\s+(\\d+)/m),
  dataLimit: read("/proc/self/limits", /^Max data size\\s+(\\S+)/m),
});
`;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnSandboxedNode(dataLimitKb, ["-e", source], ["ignore", "ignore", "ignore", "ipc"]);
    } catch {
      resolve("child_not_started");
      return;
    }
    let done = false;
    const finish = (problem: PdfSandboxSelfCheckProblem | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve(problem);
    };
    const deadline = setTimeout(() => finish("child_not_started"), limits.startupMs);
    child.once("error", () => finish("child_not_started"));
    child.once("exit", () => finish("child_not_started"));
    child.once("message", (message: { residentKb?: unknown; dataLimit?: unknown }) => {
      let readByServer = false;
      try {
        readByServer = child.pid !== undefined && residentBytes(child.pid) !== undefined;
      } catch {
        readByServer = false;
      }
      if (!readByServer || typeof message?.residentKb !== "string") finish("proc_unreadable");
      else if (message.dataLimit !== String(dataLimitKb * 1024)) finish("data_limit_not_applied");
      else finish(undefined);
    });
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

/** Child processes currently running. */
export function pdfStructureSandboxInFlightForTests(): number {
  return inFlight;
}
