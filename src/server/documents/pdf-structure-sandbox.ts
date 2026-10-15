import { createRequire } from "node:module";
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
 * an allowance, as a cgroup memory limit kills a process. The worker starts
 * with an empty environment: the parser never sees the server's secrets.
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
  /** Off-heap memory a check may use beyond the file itself, which the worker holds. */
  externalAllowanceMb: number;
  /** How often the watchdog reads the worker's off-heap memory. */
  pollMs: number;
  /** Checks running at once; more wait their turn. */
  concurrency: number;
  /** File URL of the parser module; tests point it elsewhere to force a crash. */
  pdfjsUrl?: string;
};

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
  pollMs: 25,
  concurrency: 2,
});

type Inspector = (bytes: Buffer) => Promise<DocumentStructureReason>;
type StopKind = "timeout" | "memory" | "crash";

let limits: PdfStructureSandboxLimits = { ...PDF_STRUCTURE_SANDBOX_LIMITS };
let testInspector: Inspector | undefined;
let inFlight = 0;
let running = 0;
const waiting: Array<() => void> = [];
let defaultPdfjsUrl: string | undefined;

const REASONS = new Set<string>(["supported_structure", "unsupported_structure", "password_required"]);

/**
 * The worker body, as source text: the server is bundled and the bundler
 * emits no separate worker file, so the worker is evaluated from this string
 * and imports pdf.js by the file URL the main thread resolved. The parser
 * module is imported outside the try, so a parser that cannot load crashes
 * the worker (logged as a crash) rather than refusing files quietly.
 */
const WORKER_SOURCE = `
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

function pdfjsUrl(): string {
  if (limits.pdfjsUrl) return limits.pdfjsUrl;
  // Resolved from this module, as preview.ts resolves pdf.js, so the bundled
  // server finds the package beside its own node_modules.
  defaultPdfjsUrl ??= pathToFileURL(createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.mjs")).href;
  return defaultPdfjsUrl;
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

function logStop(kind: StopKind, durationMs: number): void {
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

function startWorker(data: ArrayBuffer): Worker {
  return new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { pdfjsUrl: pdfjsUrl(), data, options: PDF_STRUCTURE_PARSER_OPTIONS, maxPages: PDF_STRUCTURE_MAX_PAGES },
    transferList: [data],
    resourceLimits: {
      maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb,
      maxYoungGenerationSizeMb: limits.maxYoungGenerationSizeMb,
      stackSizeMb: limits.stackSizeMb,
    },
    // The parser needs no environment, and must not see the server's secrets.
    env: {},
    // The parser's own console output can quote the file; it is discarded.
    stdout: true,
    stderr: true,
  });
}

function runWorker(bytes: Buffer): Promise<DocumentStructureReason> {
  const data = new Uint8Array(bytes).buffer;
  const capBytes = bytes.length + limits.externalAllowanceMb * 1024 * 1024;
  let started = Date.now();
  let worker: Worker;
  try {
    worker = startWorker(data);
  } catch {
    // No parser could be found or no thread started: every PDF would fail.
    logStop("crash", Date.now() - started);
    return Promise.resolve("unsupported_structure");
  }
  inFlight += 1;
  worker.stdout.resume();
  worker.stderr.resume();

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    const settle = (reason: DocumentStructureReason, stop?: StopKind): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      if (stop) logStop(stop, Date.now() - started);
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
        resolve(reason);
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
        if (external > capBytes) settle("unsupported_structure", "memory");
      } catch {
        // Nothing to judge this time.
      } finally {
        polling = false;
      }
    };
    // The clock and the watchdog start once the thread is running, so a slow
    // start-up does not eat the check's budget.
    worker.once("online", () => {
      if (settled) return;
      started = Date.now();
      timer = setTimeout(() => settle("unsupported_structure", "timeout"), limits.wallMs);
      watchdog = setInterval(() => void poll(), limits.pollMs);
    });
    worker.once("message", (message: unknown) => {
      settle(typeof message === "string" && REASONS.has(message) ? message as DocumentStructureReason : "unsupported_structure");
    });
    worker.once("error", (error: Error & { code?: string }) => {
      settle("unsupported_structure", error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "memory" : "crash");
    });
    worker.once("exit", () => settle("unsupported_structure", "crash"));
  });
}

/** Opens the PDF in a sandboxed worker: no password, within the page cap, and finds page one. */
export async function inspectPdfStructureInSandbox(bytes: Buffer): Promise<DocumentStructureReason> {
  if (testInspector) return testInspector(bytes);
  await acquire();
  try {
    return await runWorker(bytes);
  } finally {
    release();
  }
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
