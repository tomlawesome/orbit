import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants as fsConstants, readFileSync, statSync } from "node:fs";
import { type FileHandle, mkdir, open, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { log, operationalDetail } from "@/lib/logger";
import { documentQuarantineRoot } from "@/server/documents/config";
import {
  declaredImageDimensions,
  type DocumentStructureReason,
  type DocumentStructureVerdict,
  PDF_STRUCTURE_MAX_PAGES,
} from "@/server/documents/validation";

/**
 * Opens an untrusted document in a short-lived child process of its own,
 * killed at a process-memory ceiling and a wall-clock limit (#1316, #1427,
 * ADR-0038, ADR-0046): the standard way to handle hostile input, one process
 * per untrusted document under a supervisor that kills. A file that makes the
 * reader run out of memory, loop or crash costs one child, which is killed;
 * the check then answers that it reached no verdict
 * (`structure_check_unavailable`). The server never parses a PDF or decodes
 * an image itself, so it stays responsive and its own memory does not grow.
 *
 * PDFs are read by poppler (#1436, ADR-0046): the structure check is
 * `pdfinfo -f 1 -l 1` and a page is drawn by `pdftoppm` to a JPEG, each one
 * process started through `/bin/sh` under `ulimit -t` (RLIMIT_CPU) and
 * `ulimit -v` (RLIMIT_AS), with an empty environment, the file handed over as
 * the read-only descriptor 4 (`/dev/fd/4`), never by path and never through
 * stdin. The fences, in the order they fire: the wall clock from spawn; a
 * watchdog on the child's resident plus swapped memory (`VmRSS` + `VmSwap`)
 * every `pollMs`, SIGKILL past the job's ceiling; RLIMIT_AS at the ceiling
 * plus 128 MiB, the kernel backstop should the event loop be too busy to
 * poll; RLIMIT_CPU at the wall clock plus 5 s, so an orphan stops on its own.
 * The answer is then checked like any other input from a child that read a
 * hostile file.
 *
 * Images are still decoded by the canvas backend in a node child (#1572),
 * under their own ceiling and RLIMIT_DATA, as ADR-0038 describes.
 *
 * Jobs wait for a slot in one of three pools (#1436 D5): `check` (structure
 * and image checks), `view` (a page drawn because someone is looking) and
 * `background` (the kept-preview drawer, at `nice -n 10`), so an upload check
 * never waits behind a drawing and the drawer never takes a reader's slot.
 *
 * The child runs as the same user as the server, so this is not isolation
 * from the server's files or /proc.
 */

/** The three slot pools (#1436 D5). */
export type SandboxPool = "check" | "view" | "background";

export type PdfStructureSandboxLimits = {
  /** Time a structure or image check may take; for poppler from spawn, for an image child from its saying it is ready. */
  wallMs: number;
  /** Process memory (RSS + swap) a structure check (`pdfinfo`) may use. */
  structureMemoryMb: number;
  /** Process memory (RSS + swap) a page draw (`pdftoppm`) may use. */
  renderMemoryMb: number;
  /** Process memory an image child may use beyond one times the file (#1572; unchanged by #1436). */
  imageMemoryMb: number;
  /** The image child's V8 old-generation heap cap (its own `--max-old-space-size`). */
  heapMb: number;
  /** Time an image child may take from spawn to ready before it is stopped as a crash. */
  startupMs: number;
  /** How often the watchdog reads a child's memory. */
  pollMs: number;
  /** Jobs running at once in each pool; more wait their turn. */
  concurrency: Readonly<Record<SandboxPool, number>>;
  /** Absolute path of `pdfinfo`; by default found on the server's PATH. Tests point it at a stand-in. */
  pdfinfoPath?: string;
  /** Absolute path of `pdftoppm`; by default found on the server's PATH. Tests point it at a stand-in. */
  pdftoppmPath?: string;
  /** File URL of the canvas backend; tests point it elsewhere to force a crash. */
  canvasUrl?: string;
};

export const PDF_STRUCTURE_SANDBOX_LIMITS: Readonly<PdfStructureSandboxLimits> = Object.freeze({
  // The structure check's long-standing time budget.
  wallMs: 5_000,
  // 8x the largest check measured with pdfinfo (8 MiB; a 97 MB file with a
  // broken index rebuilt in 13 MiB). ADR-0046.
  structureMemoryMb: 64,
  // Every legitimate shape measured draws under 64 MiB except a large
  // JPEG 2000 image (a 300 dpi JPX scan peaks at 122 MiB); owner decision,
  // 2026-11-07. ADR-0046.
  renderMemoryMb: 256,
  // The image child's ceiling, kept from ADR-0038: the largest legitimate
  // decode measured peaks at 349 MiB.
  imageMemoryMb: 768,
  // Legitimate images decode in a small heap; a runaway allocation hits this.
  heapMb: 128,
  // An image child is ready in about 0.3 s; one that is not after this long
  // never will, and would hold its slot forever.
  startupMs: 5_000,
  pollMs: 25,
  concurrency: Object.freeze({ check: 2, view: 2, background: 1 }),
});

/** The most a page draw may write to stdout; the largest legitimate page measured is 231 KB. */
export const PREVIEW_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** RLIMIT_AS sits this far above a poppler job's RSS ceiling: a C program's address space is a few MiB above its resident set. */
const ADDRESS_SPACE_HEADROOM_MB = 128;
/** CPU seconds a child may use beyond its clock before the kernel stops it. */
const CPU_LIMIT_SLACK_SECONDS = 5;
/** How much of the child's stderr is kept, in memory only, to recognise a fixed library message. */
const STDERR_TAIL_CHARS = 4_096;
/** Fixed library messages a child prints when it ran out of memory: poppler's, the C++ allocator's, and V8's (image child). */
const OUT_OF_MEMORY_MESSAGES = ["Out of memory", "std::bad_alloc", "JavaScript heap out of memory"];
/** poppler's fixed message for a file that needs a password to open. */
const PASSWORD_MESSAGE = "Incorrect password";
/** pdftoppm's exit code for a page range the file does not have (and for a bad command line). */
const PDFTOPPM_WRONG_PAGE_RANGE = 99;
/** A kill that has not ended the child after this long is given up on. */
const EXIT_BACKSTOP_MS = 1_000;
const MiB = 1024 * 1024;

/** The image child's young-generation cap and stack, fixed: no test needs to move them. */
const SEMI_SPACE_MB = 8;
const STACK_SIZE_KB = 3_900;
/**
 * RLIMIT_DATA sits this far above the image child's RSS ceiling: V8 reserves
 * about 1 GB of data segment it never touches.
 */
const DATA_LIMIT_HEADROOM_MB = 1_536;

const SANDBOX_SHELL = "/bin/sh";
/**
 * The poppler wrapper (ADR-0046): `ulimit -t` and `ulimit -v`, then the tool.
 * The CPU limit, the address-space limit and the command follow as positional
 * parameters, so no value is ever part of the shell text. A limit the shell
 * refuses must not run unlimited: the wrapper exits 126 instead, which the
 * server reads as the renderer unavailable (not remembered against the file). `PWD` and `SHLVL` are unset because dash and
 * BusyBox ash export them to what they exec even from an empty environment.
 */
const POPPLER_WRAPPER = 'ulimit -t "$1" || exit 126; ulimit -v "$2" || exit 126; shift 2; unset PWD SHLVL; exec "$@"';
/**
 * The image child's wrapper: `ulimit -t` and `ulimit -d` (RLIMIT_DATA; empty
 * leaves it alone, for tests only), then node. A refused limit exits 126, which
 * the server reads as the image child unavailable (not remembered against the file).
 */
const NODE_WRAPPER = 'ulimit -t "$1" || exit 126; if [ -n "$2" ]; then ulimit -d "$2" || exit 126; fi; shift 2; unset PWD SHLVL; exec "$@"';

/** A file on disk, by path and exact size: the sandbox opens it read-only and hands the child that descriptor. */
export type DocumentFileOnDisk = { path: string; sizeBytes: number };
/**
 * What a PDF job reads: a file on disk; a descriptor the caller holds open
 * and keeps (the kept-preview drawer reuses one unlinked file for every page);
 * or bytes held only in memory, which the sandbox writes to an unlinked file
 * in the quarantine for the job's length.
 */
export type PdfInput = DocumentFileOnDisk | { handle: FileHandle; sizeBytes: number } | { bytes: Buffer };
/** What an image job's child is given to open: the bytes, sent over IPC, or a file, handed over as a descriptor. */
type ChildInput = { bytes: Buffer } | { file: DocumentFileOnDisk };
/** The descriptor's number in the child: stdio positions 0-2 are the standard streams, 3 the IPC channel (or nothing). */
const FILE_FD = 4;
const FILE_PATH_IN_CHILD = `/dev/fd/${FILE_FD}`;

/**
 * Why a job gave no answer. `timeout`, `memory` and `crash` are the child's
 * (the file's) doing; `unavailable` is ours: the tool is not installed, the
 * wrapper could not apply a limit or start it (126, 127), the file could not
 * be handed over (a full quarantine tmpfs), or the child could not be spawned.
 * An `unavailable` job says nothing about the file, so it is never remembered
 * as a refusal (#1433 D20).
 */
type StopKind = "timeout" | "memory" | "crash" | "unavailable";
type Job = "structure" | "render" | "image";

let limits: PdfStructureSandboxLimits = { ...PDF_STRUCTURE_SANDBOX_LIMITS };
let testDataLimitHeadroom: "unlimited" | number | undefined;
let lastChildPid: number | undefined;
let inFlight = 0;
const pools: Record<SandboxPool, { running: number; waiting: Array<() => void> }> = {
  check: { running: 0, waiting: [] },
  view: { running: 0, waiting: [] },
  background: { running: 0, waiting: [] },
};
let defaultCanvasUrl: string | undefined;

/** The answer to a page draw: drawn, refused as upload would refuse it, no such page, or not drawn. */
export type PdfPageRender =
  | { outcome: "drawn"; bytes: Buffer; width: number; height: number; pageCount?: number }
  | { outcome: "refused"; reason: Exclude<DocumentStructureReason, "supported_structure" | "structure_check_unavailable"> }
  | { outcome: "page_not_found"; pageCount: number }
  | { outcome: "failed"; stop?: StopKind };

/** The answer to an image's preview: drawn, refused as upload would refuse it, or not drawn. */
export type ImageRender =
  | { outcome: "drawn"; bytes: Buffer; width: number; height: number }
  | { outcome: "refused"; reason: "unsupported_structure" }
  | { outcome: "failed"; stop?: StopKind };

/** A first-come, first-served slot in `pool`: a finished job hands its slot straight to the next in line. */
async function acquire(pool: SandboxPool): Promise<void> {
  const state = pools[pool];
  if (state.running < limits.concurrency[pool]) {
    state.running += 1;
    return;
  }
  await new Promise<void>((resolve) => state.waiting.push(resolve));
}

function release(pool: SandboxPool): void {
  const state = pools[pool];
  const next = state.waiting.shift();
  if (next) next();
  else state.running -= 1;
}

async function inPool<T>(pool: SandboxPool, run: () => Promise<T>): Promise<T> {
  await acquire(pool);
  try {
    return await run();
  } finally {
    release(pool);
  }
}

/**
 * Records a stopped job under the body of what it was doing: a draw's (a page
 * draw, or an image job that draws) or the check's, naming the job, PDF or
 * image, in the detail. No file detail is ever recorded.
 */
function logStop(job: Job, draws: boolean, kind: StopKind, durationMs: number): void {
  const image = job === "image";
  // A crash or a child that cannot start would stop every job of its kind.
  const severe = kind === "crash" || kind === "unavailable";
  if (job === "render" || (image && draws)) {
    // preview.ts records the refusal itself; a timeout is already named
    // there (processing_interrupted), so only memory and crash say more.
    if (kind === "timeout") return;
    log[severe ? "warn" : "info"]({
      event: "document.preview",
      state: "blocked",
      reason: kind === "unavailable" ? "processing_interrupted" : "unsupported_structure",
      action: severe ? "check_parser" : "none",
      impact: severe ? "application_degraded" : "none",
      durationMs,
      detail: image
        ? operationalDetail`Image sandbox stopped the preview: ${kind}`
        : operationalDetail`PDF sandbox stopped the page render: ${kind}`,
    });
    return;
  }
  // A crash would stop every check of that kind, every PDF or every image, so
  // the operator is told; a timeout or memory stop is one job stopped, and the
  // caller decides whether that refuses the file or retries it.
  log[severe ? "warn" : "info"]({
    event: "document.inspection",
    state: "blocked",
    reason: "processing_interrupted",
    action: severe ? "check_parser" : "none",
    impact: severe ? "document_upload_blocked" : "none",
    durationMs,
    detail: image
      ? operationalDetail`Image sandbox stopped the decode: ${kind}`
      : operationalDetail`PDF structure sandbox stopped the check: ${kind}`,
  });
}

/** The host's disk, not the parser: the file to check could not be opened or is not what it was said to be. */
function logOpenFailure(code: string): void {
  log.warn({
    event: "document.inspection",
    state: "blocked",
    reason: "processing_interrupted",
    action: "inspect_admin_diagnostics",
    impact: "document_upload_blocked",
    detail: operationalDetail`Sandbox could not open the file to check: ${code}`,
  });
}

/** CPU seconds a child may use: its clock in whole seconds, plus the slack. */
function cpuLimitSeconds(clockMs: number): number {
  return Math.ceil(clockMs / 1000) + CPU_LIMIT_SLACK_SECONDS;
}

/**
 * The child's memory in bytes, resident plus swapped, from one read of the
 * kernel's status file; undefined if it cannot be read. `VmSwap` may be
 * absent (no swap support), which counts as none.
 */
function memoryBytes(pid: number): number | undefined {
  // `status` reports kB whatever the page size, unlike `statm`.
  const status = readFileSync(`/proc/${pid}/status`, "latin1");
  const resident = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
  if (!resident) return undefined;
  const swapped = /^VmSwap:\s+(\d+)\s+kB/m.exec(status);
  return (Number(resident[1]) + (swapped ? Number(swapped[1]) : 0)) * 1024;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A program's absolute path, from the server's PATH: the child is given an
 * empty environment, so it cannot search one itself. Undefined when it is not
 * installed, which the job reads as a child that cannot start.
 */
function findOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function toolPath(tool: "pdfinfo" | "pdftoppm"): string | undefined {
  const override = tool === "pdfinfo" ? limits.pdfinfoPath : limits.pdftoppmPath;
  return override ?? findOnPath(tool);
}

/** What one poppler run gave: how it ended and what it wrote, or why it was stopped. */
type PopplerOutcome =
  | { stop: StopKind }
  | { exitCode: number; stdout: Buffer; stderrTail: string; overflow: boolean };

type PopplerJob = {
  job: "structure" | "render";
  tool: "pdfinfo" | "pdftoppm";
  /** The tool's arguments before the file, which is always `/dev/fd/4`. */
  args: string[];
  handle: FileHandle;
  wallMs: number;
  memoryMb: number;
  nice: boolean;
};

/**
 * Kills the child's whole process group (it leads its own), so nothing it
 * started outlives it. Once the leader has exited and been reaped its pid may
 * be reused, so the group is signalled only while the leader is still there.
 * The poppler wrapper execs every stage in place, so the leader is the only
 * process the group ever holds.
 */
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  child.kill("SIGKILL");
}

/**
 * Runs one poppler tool under the wrapper and the watchdog, the file as
 * descriptor 4. Resolves once the child has exited and been reaped, whatever
 * happened, so `inFlight` and the pool's slot mean what they say.
 */
function runPopplerJob(job: PopplerJob): Promise<PopplerOutcome> {
  const started = Date.now();
  const program = toolPath(job.tool);
  const nicePath = job.nice ? findOnPath("nice") : undefined;
  if (!program || (job.nice && !nicePath)) {
    // Not installed: every job of this kind would fail, and the file is not at fault.
    logStop(job.job, true, "unavailable", 0);
    return Promise.resolve({ stop: "unavailable" });
  }
  const command = [program, ...job.args, FILE_PATH_IN_CHILD];
  const shellArgs = [String(cpuLimitSeconds(job.wallMs)), String((job.memoryMb + ADDRESS_SPACE_HEADROOM_MB) * 1024)];
  const wrapped = [SANDBOX_SHELL, "-c", POPPLER_WRAPPER, "sh", ...shellArgs, ...command];
  // `nice` comes first, so the wrapper shell itself already runs at nice 10:
  // no stage of a background child runs at the server's priority.
  const [file, ...argv] = nicePath ? [nicePath, "-n", "10", ...wrapped] : wrapped;
  let child: ChildProcess;
  try {
    child = spawn(file!, argv, {
      // stdout is the answer; stderr is read for fixed messages only. The file
      // is the child's descriptor 4; position 3 is left closed.
      stdio: ["ignore", "pipe", "pipe", "ignore", job.handle.fd],
      env: {},
      // Its own process group, so a stop kills anything it started too.
      detached: true,
    });
  } catch {
    logStop(job.job, true, "unavailable", Date.now() - started);
    return Promise.resolve({ stop: "unavailable" });
  }
  lastChildPid = child.pid;
  inFlight += 1;
  const ceilingBytes = job.memoryMb * MiB;
  const exited = new Promise<void>((done) => {
    child.once("exit", () => done());
    child.once("error", () => {
      if (child.pid === undefined) done();
    });
  });

  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let overflow = false;
    // Held in memory only to recognise fixed library messages; never logged,
    // since it can quote the file.
    let stderrTail = "";
    const settle = (outcome: PopplerOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      if ("stop" in outcome) logStop(job.job, job.job === "render", outcome.stop, Date.now() - started);
      killGroup(child);
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
    const watchdog = setInterval(() => {
      if (settled || child.pid === undefined) return;
      try {
        const used = memoryBytes(child.pid);
        if (used !== undefined && used > ceilingBytes) settle({ stop: "memory" });
      } catch {
        // The child already gone, or no /proc (boot warns): the clock still stops the job.
      }
    }, limits.pollMs);
    const timer = setTimeout(() => settle({ stop: "timeout" }), job.wallMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (overflow) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > PREVIEW_MAX_OUTPUT_BYTES) {
        // More than any page: a failed answer, and the child is stopped now.
        overflow = true;
        chunks.length = 0;
        killGroup(child);
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.setEncoding("latin1");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.once("error", () => settle({ stop: child.pid === undefined ? "unavailable" : "crash" }));
    // `close` comes after the child has exited and both pipes are drained.
    child.once("close", (code: number | null) => {
      if (OUT_OF_MEMORY_MESSAGES.some((text) => stderrTail.includes(text))) {
        settle({ stop: "memory" });
        return;
      }
      if (overflow) {
        settle({ exitCode: code ?? -1, stdout: Buffer.alloc(0), stderrTail, overflow: true });
        return;
      }
      // Killed by a signal not ours (SIGSEGV, SIGXCPU): the file's doing.
      if (code === null) {
        settle({ stop: "crash" });
        return;
      }
      // The wrapper could not apply a limit (126) or start the tool (127):
      // ours, not the file's; poppler's own exit codes are 0-3 and 99.
      if (code === 126 || code === 127) {
        settle({ stop: "unavailable" });
        return;
      }
      settle({ exitCode: code, stdout: Buffer.concat(chunks), stderrTail, overflow: false });
    });
  });
}

/**
 * Runs `use` with a descriptor on the job's file. A path is opened read-only
 * and must be a regular file of the stated size; bytes are written to a new
 * 0600 file in the quarantine, opened and unlinked at once, so only the
 * descriptor names it. Descriptors the sandbox opened are closed afterwards;
 * a caller's own is left open. Undefined when the file cannot be had.
 */
async function withPdfDescriptor<T>(input: PdfInput, use: (handle: FileHandle) => Promise<T>): Promise<T | undefined> {
  if ("handle" in input) return use(input.handle);
  let handle: FileHandle;
  try {
    if ("bytes" in input) {
      const root = documentQuarantineRoot();
      await mkdir(root, { recursive: true, mode: 0o700 });
      const path = join(root, `sandbox.${randomBytes(16).toString("hex")}.pdf`);
      handle = await open(path, "wx+", 0o600);
      try {
        await rm(path, { force: true });
        await handle.writeFile(input.bytes);
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    } else {
      handle = await open(input.path, "r");
      const status = await handle.stat().catch(() => undefined);
      if (!status?.isFile() || status.size !== input.sizeBytes) {
        await handle.close().catch(() => undefined);
        logOpenFailure("size_mismatch");
        return undefined;
      }
    }
  } catch (error) {
    // The code is Node's fixed one, never the path.
    logOpenFailure((error as NodeJS.ErrnoException | null)?.code ?? "error");
    return undefined;
  }
  try {
    return await use(handle);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** What `pdfinfo -f 1 -l 1` said about a file, read from its fixed output. */
type PdfInfo =
  | { stop: StopKind }
  | { pages?: number; firstPage: boolean; password: boolean; ok: boolean };

function readPdfInfo(outcome: PopplerOutcome): PdfInfo {
  if ("stop" in outcome) return outcome;
  if (outcome.overflow) return { firstPage: false, password: false, ok: false };
  const text = outcome.stdout.toString("latin1");
  const pages = /^Pages:\s+(\d{1,9})\s*$/m.exec(text);
  return {
    pages: pages ? Number(pages[1]) : undefined,
    firstPage: /^Page\s+1 size:/m.test(text),
    password: outcome.exitCode === 1 && outcome.stderrTail.includes(PASSWORD_MESSAGE),
    ok: outcome.exitCode === 0,
  };
}

function runPdfinfo(handle: FileHandle, nice: boolean): Promise<PdfInfo> {
  return runPopplerJob({
    job: "structure",
    tool: "pdfinfo",
    args: ["-f", "1", "-l", "1"],
    handle,
    wallMs: limits.wallMs,
    memoryMb: limits.structureMemoryMb,
    nice,
  }).then(readPdfInfo);
}

function verdictOf(info: PdfInfo, maxPages = PDF_STRUCTURE_MAX_PAGES): DocumentStructureVerdict {
  if ("stop" in info) return { reason: "structure_check_unavailable" };
  if (info.password) return { reason: "password_required" };
  if (info.ok && info.firstPage && info.pages !== undefined && info.pages >= 1 && info.pages <= maxPages) {
    return { reason: "supported_structure", pageCount: info.pages };
  }
  return { reason: "unsupported_structure" };
}

/**
 * The structure check (#1436 D3): `pdfinfo -f 1 -l 1` opens the PDF with no
 * password, within the page cap, and finds page one. A stop (memory, clock,
 * crash), a tool that cannot start, or a file that cannot be opened reaches
 * no verdict: `structure_check_unavailable`. Only the tool's own answer is a
 * verdict; a supported file comes with its page count. `options.maxPages`
 * is the bound a document already accepted carries (#1801 A-F14); absent,
 * the current cap, `PDF_STRUCTURE_MAX_PAGES`.
 */
export async function inspectPdfStructureInSandbox(input: PdfInput, options: { maxPages?: number } = {}): Promise<DocumentStructureVerdict> {
  return inPool("check", async () => {
    const verdict = await withPdfDescriptor(input, async (handle) => verdictOf(await runPdfinfo(handle, false), options.maxPages));
    return verdict ?? { reason: "structure_check_unavailable" };
  });
}

/** What `pdfinfo` says a file's page count is, whatever the cap; or why it said nothing. */
export type PdfPageCount =
  | { outcome: "counted"; pageCount: number }
  | { outcome: "refused" }
  | { outcome: "failed"; stop: StopKind };

/**
 * Reads a stored PDF's page count with `pdfinfo` in `pool` (at nice 10 in
 * `background`), with no page cap: a document accepted under the old
 * 1,000-page cap is counted as it is (#1433). A file pdfinfo cannot open, or
 * that needs a password, is `refused`.
 */
export async function readPdfPageCountInSandbox(input: PdfInput, pool: SandboxPool): Promise<PdfPageCount> {
  return inPool(pool, async () => {
    const answer = await withPdfDescriptor(input, async (handle): Promise<PdfPageCount> => {
      const info = await runPdfinfo(handle, pool === "background");
      if ("stop" in info) return { outcome: "failed", stop: info.stop };
      if (info.ok && info.pages !== undefined && info.pages >= 1) return { outcome: "counted", pageCount: info.pages };
      return { outcome: "refused" };
    });
    return answer ?? { outcome: "failed", stop: "unavailable" };
  });
}

/** A drawn page's edge: a whole number of pixels, at least one and at most the asked-for long edge. */
function isEdge(value: number, maxEdge: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maxEdge;
}

/**
 * Draws one page of a PDF with `pdftoppm` in a sandboxed child, to a JPEG of
 * at most `maxEdge` pixels a side (quality 85). `wallMs` is the caller's
 * budget, counted from spawn; `pool` is who is waiting (`view` for a person,
 * `background` for the kept-preview drawer, which also runs at nice 10). A
 * page past the end answers `page_not_found` with the file's page count,
 * read by `pdfinfo` in the same slot; `pageCount: true` asks for the count
 * with a drawn page too. The page cap is not applied here: a document stored
 * under the old 1,000-page cap has its first 100 pages drawn ahead by the
 * kept-preview worker, and any later page, up to its stored page count, is
 * drawn here when someone views it (#1433, owner answer 10a).
 */
export async function renderPdfPageInSandbox(
  input: PdfInput,
  request: { page: number; maxEdge: number; wallMs: number; pool: SandboxPool; pageCount?: boolean },
): Promise<PdfPageRender> {
  return inPool(request.pool, async () => {
    const answer = await withPdfDescriptor(input, (handle) => drawPage(handle, request));
    // The file could not be handed over (a full quarantine, a vanished file): ours.
    return answer ?? { outcome: "failed", stop: "unavailable" };
  });
}

async function drawPage(
  handle: FileHandle,
  request: { page: number; maxEdge: number; wallMs: number; pool: SandboxPool; pageCount?: boolean },
): Promise<PdfPageRender> {
  const nice = request.pool === "background";
  const page = String(request.page);
  const outcome = await runPopplerJob({
    job: "render",
    tool: "pdftoppm",
    args: [
      "-f", page, "-l", page, "-singlefile", "-cropbox",
      "-scale-to", String(request.maxEdge),
      "-jpeg", "-jpegopt", "quality=85,optimize=y",
    ],
    handle,
    wallMs: request.wallMs,
    memoryMb: limits.renderMemoryMb,
    nice,
  });
  if ("stop" in outcome) return { outcome: "failed", stop: outcome.stop };
  if (outcome.overflow) return { outcome: "failed" };
  if (outcome.exitCode === 0) {
    const drawn = checkedJpeg(outcome.stdout, request.maxEdge);
    if (!drawn) return { outcome: "failed" };
    if (!request.pageCount) return drawn;
    const info = await runPdfinfo(handle, nice);
    return "stop" in info || info.pages === undefined ? drawn : { ...drawn, pageCount: info.pages };
  }
  if (outcome.exitCode === 1) {
    return { outcome: "refused", reason: outcome.stderrTail.includes(PASSWORD_MESSAGE) ? "password_required" : "unsupported_structure" };
  }
  if (outcome.exitCode === PDFTOPPM_WRONG_PAGE_RANGE) {
    const info = await runPdfinfo(handle, nice);
    if ("stop" in info) return { outcome: "failed", stop: info.stop };
    if (info.password) return { outcome: "refused", reason: "password_required" };
    if (info.ok && info.pages !== undefined && info.pages >= 1 && request.page > info.pages) {
      return { outcome: "page_not_found", pageCount: info.pages };
    }
    if (!info.ok || info.pages === undefined || info.pages < 1) return { outcome: "refused", reason: "unsupported_structure" };
  }
  return { outcome: "failed" };
}

/**
 * The child read a hostile file, so its answer is checked like any other
 * input: 3 bytes to 4 MiB starting FF D8 FF, and a frame header whose size is
 * whole pixels within the asked-for edge. Anything else is a failed draw;
 * nothing of the answer is logged.
 */
function checkedJpeg(bytes: Buffer, maxEdge: number): Extract<PdfPageRender, { outcome: "drawn" }> | undefined {
  if (bytes.length < 3 || bytes.length > PREVIEW_MAX_OUTPUT_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return undefined;
  const frame = declaredImageDimensions(bytes, "image/jpeg");
  if (!frame || !isEdge(frame.width, maxEdge) || !isEdge(frame.height, maxEdge)) return undefined;
  return { outcome: "drawn", bytes, width: frame.width, height: frame.height };
}

/* ---- Images: the canvas backend in a node child (#1572, ADR-0038) ---- */

/**
 * The part of the image child that takes the job's bytes: from the inherited
 * descriptor, which must be a regular file of the stated size and is read
 * from position 0 before ready, or from the IPC message.
 */
const JOB_DATA_SOURCE = `
  let data;
  if (job.file) {
    const { closeSync, fstatSync, readSync } = await import("node:fs");
    const size = job.file.sizeBytes;
    try {
      const status = fstatSync(job.file.fd);
      if (!status.isFile() || !Number.isSafeInteger(size) || status.size !== size) process.exit(2);
      const buffer = Buffer.allocUnsafe(size);
      for (let offset = 0; offset < size;) {
        const read = readSync(job.file.fd, buffer, offset, size - offset, offset);
        if (read === 0) process.exit(2);
        offset += read;
      }
      data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      closeSync(job.file.fd);
    } catch {
      process.exit(2);
    }
  } else {
    data = new Uint8Array(job.data.buffer, job.data.byteOffset, job.data.byteLength);
  }
`;

/**
 * The image decoder's child body (#1572): the canvas backend is imported here
 * and nowhere in the server. It decodes the image and checks the header's size
 * against the decoded one; for a preview it also draws the bounded picture and
 * encodes it, so a preview is one child run with the gate inside. The backend
 * is imported before the child says it is ready: one that cannot load ends the
 * child before ready, which the server logs as a crash for a check and
 * answers as `unavailable` for a draw (#1433 D20: Orbit's fault, not the file's).
 */
const IMAGE_SOURCE = `
const received = new Promise((resolve) => process.on("message", resolve));
(async () => {
  const { loadImage, createCanvas } = await import(process.argv[1]);
  const job = await received;
${JOB_DATA_SOURCE}
  await new Promise((resolve) => process.send({ ready: true }, resolve));
  let result = { outcome: "failed" };
  try {
    const decoded = await loadImage(data);
    if (decoded.width !== job.width || decoded.height !== job.height) {
      result = { outcome: "refused", reason: "unsupported_structure" };
    } else if (!job.draw) {
      result = { outcome: "opened" };
    } else {
      const { width, height, mediaType } = job.draw;
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      if (mediaType === "image/jpeg") {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(decoded, 0, 0, width, height);
      const image = mediaType === "image/jpeg" ? canvas.toBuffer("image/jpeg", 82) : canvas.toBuffer("image/png");
      result = { outcome: "drawn", pageCount: 1, image, width, height };
    }
  } catch {
    result = { outcome: "failed" };
  }
  process.send(result, () => process.exit(0));
})();
`;

/** The canvas backend's entry, resolved from this module: the copy the server itself ships. */
function canvasUrl(): string {
  if (limits.canvasUrl) return limits.canvasUrl;
  defaultCanvasUrl ??= pathToFileURL(createRequire(import.meta.url).resolve("@napi-rs/canvas")).href;
  return defaultCanvasUrl;
}

/**
 * Starts `node` with `nodeArgs` under the node wrapper: `/bin/sh` sets
 * RLIMIT_CPU and RLIMIT_DATA and execs node, so the limits are the node
 * process's own. The environment is empty.
 */
function spawnSandboxedNode(
  limitsFor: { cpuSeconds: number; dataLimitKb: number | undefined },
  nodeArgs: string[],
  stdio: Array<"ignore" | "pipe" | "ipc" | number>,
  nicePath?: string,
): ChildProcess {
  const shellArgs = [String(limitsFor.cpuSeconds), limitsFor.dataLimitKb === undefined ? "" : String(limitsFor.dataLimitKb)];
  const wrapped = [SANDBOX_SHELL, "-c", NODE_WRAPPER, "sh", ...shellArgs, process.execPath, ...nodeArgs];
  // `nice` first, as for poppler, so no stage of a background child runs at the server's priority.
  const [file, ...argv] = nicePath ? [nicePath, "-n", "10", ...wrapped] : wrapped;
  return spawn(file!, argv, {
    stdio,
    serialization: "advanced",
    env: {},
  });
}

/** RLIMIT_DATA for an image job: the ceiling plus the headroom and the file, or none when a test lifts it. */
function dataLimitKbFor(memoryMb: number, fileBytes: number): number | undefined {
  if (testDataLimitHeadroom === "unlimited") return undefined;
  const headroomMb = testDataLimitHeadroom ?? DATA_LIMIT_HEADROOM_MB;
  return (memoryMb + headroomMb) * 1024 + Math.ceil(fileBytes / 1024);
}

type ImageRun = {
  /** Job-specific fields, beside the file, which every job gets. */
  message: Record<string, unknown>;
  wallMs: number;
  /** Starts the child under `nice -n 10`, as a background poppler draw is (#1436 D5). */
  nice?: boolean;
};

/** A child's answer, or why it was stopped before giving one. */
type ChildOutcome = { message: unknown } | { stop: StopKind };

function isReady(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { ready?: unknown }).ready === true;
}

/** Opens the job's file, if it has one, and runs the image child; the server's descriptor is closed as soon as the child is started. */
async function runImageChild(input: ChildInput, run: ImageRun): Promise<ChildOutcome> {
  if (!("file" in input)) return launchImageChild(input, run, undefined);
  let handle: FileHandle;
  try {
    handle = await open(input.file.path, "r");
  } catch (error) {
    logOpenFailure((error as NodeJS.ErrnoException | null)?.code ?? "error");
    return { stop: "unavailable" };
  }
  return launchImageChild(input, run, handle);
}

function launchImageChild(input: ChildInput, run: ImageRun, handle: FileHandle | undefined): Promise<ChildOutcome> {
  let started = Date.now();
  const draws = "draw" in run.message;
  const fileBytes = "file" in input ? input.file.sizeBytes : input.bytes.length;
  const ceilingBytes = limits.imageMemoryMb * MiB + fileBytes;
  const dataLimitKb = dataLimitKbFor(limits.imageMemoryMb, fileBytes);
  let child: ChildProcess;
  let closing: Promise<void> = Promise.resolve();
  let source: string;
  const nicePath = run.nice ? findOnPath("nice") : undefined;
  if (run.nice && !nicePath) {
    if (handle) void handle.close().catch(() => undefined);
    logStop("image", draws, "unavailable", 0);
    return Promise.resolve({ stop: "unavailable" });
  }
  try {
    source = canvasUrl();
    const cpuSeconds = cpuLimitSeconds(limits.startupMs + run.wallMs);
    child = spawnSandboxedNode({ cpuSeconds, dataLimitKb }, [
      `--max-old-space-size=${limits.heapMb}`,
      `--max-semi-space-size=${SEMI_SPACE_MB}`,
      `--stack-size=${STACK_SIZE_KB}`,
      "-e",
      IMAGE_SOURCE,
      "--",
      source,
    // stdout is discarded: the decoder's own output can quote the file.
    ], handle ? ["ignore", "ignore", "pipe", "ipc", handle.fd] : ["ignore", "ignore", "pipe", "ipc"], nicePath);
    if (handle) closing = handle.close().catch(() => undefined);
  } catch {
    if (handle) void handle.close().catch(() => undefined);
    logStop("image", draws, "unavailable", Date.now() - started);
    return Promise.resolve({ stop: "unavailable" });
  }
  lastChildPid = child.pid;
  inFlight += 1;
  const exited = new Promise<void>((done) => {
    child.once("exit", () => done());
    child.once("error", () => {
      if (child.pid === undefined) done();
    });
  });

  return new Promise((resolve) => {
    let settled = false;
    let ready = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stderrTail = "";
    const settle = (outcome: ChildOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(startup);
      clearTimeout(timer);
      clearInterval(watchdog);
      if ("stop" in outcome) logStop("image", draws, outcome.stop, Date.now() - started);
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
    const watchdog = setInterval(() => {
      if (settled || child.pid === undefined) return;
      try {
        const used = memoryBytes(child.pid);
        if (used !== undefined && used > ceilingBytes) settle({ stop: "memory" });
      } catch {
        // Nothing to judge this time.
      }
    }, limits.pollMs);
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
    child.once("close", (code: number | null) => {
      if (OUT_OF_MEMORY_MESSAGES.some((text) => stderrTail.includes(text))) {
        settle({ stop: "memory" });
        return;
      }
      // The wrapper could not apply a limit (126) or start node (127): Orbit's
      // side, never the file's (#1433 D20).
      if (code === 126 || code === 127) {
        settle({ stop: "unavailable" });
        return;
      }
      // Ended before ready: the file has not been read yet, so the canvas
      // backend could not load. A draw says so as `unavailable` (the view
      // answers 503 and nothing is stored, D20); a check, whose answer is
      // structure_check_unavailable either way, keeps logging it as a crash.
      settle({ stop: !ready && draws ? "unavailable" : "crash" });
    });

    const job = {
      ...run.message,
      ...("file" in input ? { file: { fd: FILE_FD, sizeBytes: input.file.sizeBytes } } : { data: input.bytes }),
    };
    void closing.then(() => {
      if (settled) return;
      try {
        child.send(job, () => {
          // A child that cannot take the job is judged by how it ends.
        });
      } catch {
        settle({ stop: "crash" });
      }
    });
  });
}

function isAnswer(message: unknown): message is Record<string, unknown> & { outcome: string } {
  return typeof message === "object" && message !== null && typeof (message as { outcome?: unknown }).outcome === "string";
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(value: unknown): value is ArrayBufferView {
  if (!ArrayBuffer.isView(value) || value.byteLength < PNG_SIGNATURE.length) return false;
  return Buffer.from(value.buffer, value.byteOffset, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function isJpeg(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value) && value.byteLength >= 3 && Buffer.from(value.buffer, value.byteOffset, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
}

/**
 * Decodes an image in a sandboxed child, in the `check` pool, under the image
 * ceiling and the check's clock: the decoder never runs in this process
 * (#1572, ADR-0038). `declared` is what the header said; a decoded size that
 * differs and a decode that fails are `unsupported_structure`; a stop, or a
 * child that could not start or open its file, is
 * `structure_check_unavailable`. With `file` the child reads that file through
 * the inherited descriptor and `bytes` goes unused. Run the header fence
 * (validation.ts) first.
 */
export async function inspectImageInSandbox(
  bytes: Buffer,
  mediaType: "image/jpeg" | "image/png",
  declared: { width: number; height: number },
  file?: DocumentFileOnDisk,
): Promise<DocumentStructureReason> {
  const outcome = await inPool("check", () => runImageChild(file ? { file } : { bytes }, {
    message: { mediaType, width: declared.width, height: declared.height },
    wallMs: limits.wallMs,
  }));
  if ("stop" in outcome) return "structure_check_unavailable";
  const message = outcome.message;
  return isAnswer(message) && message.outcome === "opened" ? "supported_structure" : "unsupported_structure";
}

/**
 * Draws an image at `width` x `height` in a sandboxed child, after the same
 * gate `inspectImageInSandbox` applies: one child per preview, nothing decoded
 * in this process. `wallMs` is the caller's render budget, counted from the
 * child saying it is ready; `pool` is who is waiting (`view` by default).
 * Run the header fence (validation.ts) first.
 */
export async function renderImageInSandbox(
  bytes: Buffer,
  request: {
    mediaType: "image/jpeg" | "image/png";
    declared: { width: number; height: number };
    width: number;
    height: number;
    wallMs: number;
    pool?: SandboxPool;
  },
): Promise<ImageRender> {
  const pool = request.pool ?? "view";
  const outcome = await inPool(pool, () => runImageChild({ bytes }, {
    message: {
      width: request.declared.width,
      height: request.declared.height,
      draw: { width: request.width, height: request.height, mediaType: request.mediaType },
    },
    wallMs: request.wallMs,
    nice: pool === "background",
  }));
  if ("stop" in outcome) return { outcome: "failed", stop: outcome.stop };
  const answer = outcome.message;
  if (!isAnswer(answer)) return { outcome: "failed" };
  if (answer.outcome === "refused") return { outcome: "refused", reason: "unsupported_structure" };
  // The child decoded a hostile file, so its answer is checked like a page's:
  // the size asked for and the right signature, or it is a failed render.
  const { image, width, height } = answer;
  if (answer.outcome !== "drawn" || width !== request.width || height !== request.height) return { outcome: "failed" };
  const signed = request.mediaType === "image/png" ? isPng(image) : isJpeg(image);
  if (!signed || !ArrayBuffer.isView(image)) return { outcome: "failed" };
  return { outcome: "drawn", bytes: Buffer.from(image.buffer, image.byteOffset, image.byteLength), width: request.width, height: request.height };
}

/** What the sandbox self-check found missing; each leaves the sandbox weaker in its own way. */
export type PdfSandboxSelfCheckProblem = "child_not_started" | "as_limit_not_applied" | "proc_unreadable";

/**
 * Two children started exactly as a check's is, wrapper and all (#1436 D11):
 * `pdfinfo -v`, which must start and exit 0 (so `/bin/sh` and poppler are
 * there), and `cat` reporting its own `/proc/self/limits` while the server
 * reads its `/proc/<pid>/status` once. Resolves with the first thing missing,
 * or undefined when the sandbox has everything it relies on: poppler, a
 * working `ulimit -v`, and a readable `/proc`.
 */
export async function pdfSandboxSelfCheck(): Promise<PdfSandboxSelfCheckProblem | undefined> {
  const program = toolPath("pdfinfo");
  if (!program) return "child_not_started";
  const cpuSeconds = String(cpuLimitSeconds(PDF_STRUCTURE_SANDBOX_LIMITS.wallMs));
  const asKiB = (PDF_STRUCTURE_SANDBOX_LIMITS.structureMemoryMb + ADDRESS_SPACE_HEADROOM_MB) * 1024;
  // The wrapper exits 126 when the shell refuses a limit: the child started,
  // but without its address-space limit, which is its own problem.
  const started = await new Promise<PdfSandboxSelfCheckProblem | undefined>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(SANDBOX_SHELL, ["-c", POPPLER_WRAPPER, "sh", cpuSeconds, String(asKiB), program, "-v"], { stdio: "ignore", env: {} });
    } catch {
      resolve("child_not_started");
      return;
    }
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("child_not_started");
    }, limits.startupMs);
    child.once("error", () => {
      clearTimeout(deadline);
      resolve("child_not_started");
    });
    child.once("exit", (code) => {
      clearTimeout(deadline);
      resolve(code === 0 ? undefined : code === 126 ? "as_limit_not_applied" : "child_not_started");
    });
  });
  if (started) return started;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      // `cat` prints its own limits, then waits on stdin until the server has
      // read its status.
      child = spawn(SANDBOX_SHELL, ["-c", POPPLER_WRAPPER, "sh", cpuSeconds, String(asKiB), "/bin/cat", "/proc/self/limits", "-"], {
        stdio: ["pipe", "pipe", "ignore"],
        env: {},
      });
    } catch {
      resolve("child_not_started");
      return;
    }
    let done = false;
    let text = "";
    const finish = (problem: PdfSandboxSelfCheckProblem | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve(problem);
    };
    const deadline = setTimeout(() => finish("child_not_started"), limits.startupMs);
    child.once("error", () => finish("child_not_started"));
    child.once("exit", (code) => finish(code === 126 ? "as_limit_not_applied" : "child_not_started"));
    child.stdout?.setEncoding("latin1");
    child.stdout?.on("data", (chunk: string) => {
      text += chunk;
      if (!/^Max address space.*\n/m.test(text)) return;
      let readByServer = false;
      try {
        readByServer = child.pid !== undefined && memoryBytes(child.pid) !== undefined;
      } catch {
        readByServer = false;
      }
      const applied = /^Max address space\s+(\S+)/m.exec(text)?.[1];
      if (!readByServer) finish("proc_unreadable");
      else if (applied !== String(asKiB * 1024)) finish("as_limit_not_applied");
      else finish(undefined);
      child.stdin?.end();
    });
  });
}

/** Overrides some or all limits for a test, over the defaults; `undefined` restores them. */
export function setPdfStructureSandboxLimitsForTests(override: Partial<PdfStructureSandboxLimits> | undefined): void {
  limits = { ...PDF_STRUCTURE_SANDBOX_LIMITS, ...override };
}

/**
 * Moves the image child's RLIMIT_DATA headroom above its ceiling for a test,
 * in MB; "unlimited" leaves `ulimit -d` out of the wrapper, so only the
 * watchdog bounds memory; `undefined` restores the default.
 */
export function setPdfSandboxDataLimitHeadroomForTests(headroom: "unlimited" | number | undefined): void {
  testDataLimitHeadroom = headroom;
}

/** The pid of the most recently started child; undefined before the first. */
export function lastPdfSandboxChildPidForTests(): number | undefined {
  return lastChildPid;
}

/** Child processes currently running. */
export function pdfStructureSandboxInFlightForTests(): number {
  return inFlight;
}
