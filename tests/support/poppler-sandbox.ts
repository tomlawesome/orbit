import { spawnSync } from "node:child_process";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import { lastPdfSandboxChildPidForTests } from "@/server/documents/pdf-structure-sandbox";

/**
 * Shared by the #1436 / #1433 tests: whether poppler is installed, the
 * sandbox API the design note names (loaded at run time, so the suite
 * type-checks before the build lands), a sampler for a child's own memory,
 * stand-in tool scripts, and JPEG readers that do not trust the code under
 * test.
 */

function onPath(tool: string): boolean {
  return spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0;
}

/** True when both poppler tools the sandbox runs are on this host's PATH. */
export const HAS_POPPLER = onPath("pdftoppm") && onPath("pdfinfo");

/** Outside CI, a poppler test skips where poppler is missing; in CI it runs and fails (`popplerIt`). */
const SKIP_POPPLER = !HAS_POPPLER && !process.env.CI;

/** The failure a poppler test gives in CI when the tools are missing. */
export const POPPLER_MISSING_IN_CI_MESSAGE =
  "poppler missing in CI: pdftoppm and pdfinfo must be on PATH in CI's test image (design note D9); the #1436/#1433 poppler tests cannot run";

/** Put in the name of every test that needs poppler, so a skip says why. */
export const NEEDS_POPPLER = HAS_POPPLER
  ? "(real pdftoppm/pdfinfo)"
  : process.env.CI
    ? "(FAILS: poppler missing in CI)"
    : "(SKIPPED: pdftoppm/pdfinfo not on PATH; runs in CI's poppler image)";

function guarded<A extends unknown[]>(body: (...args: A) => unknown): (...args: A) => unknown {
  return (...args: A) => {
    if (!HAS_POPPLER) expect.fail(POPPLER_MISSING_IN_CI_MESSAGE);
    return body(...args);
  };
}

/**
 * `it` for every test that needs the real poppler tools. Where they are
 * missing it skips outside CI and FAILS in CI (process.env.CI set) with
 * "poppler missing in CI", so these tests never skip silently there.
 */
export function popplerIt(name: string, body: () => unknown, timeout?: number): void {
  it.skipIf(SKIP_POPPLER)(name, guarded(body) as () => unknown, timeout);
}

/** `it.each` with the same rule as `popplerIt`. */
popplerIt.each = <C extends readonly unknown[]>(cases: readonly C[]) =>
  (name: string, body: (...args: [...C]) => unknown, timeout?: number): void => {
    it.skipIf(SKIP_POPPLER).each(cases as unknown as unknown[][])(name, guarded(body as (...args: unknown[]) => unknown) as never, timeout);
  };

/** A file on disk, as the sandbox takes it (`DocumentFileOnDisk`). */
export type FileOnDisk = { path: string; sizeBytes: number };
export type StopKind = "timeout" | "memory" | "crash";
export type Pool = "check" | "view" | "background";

/** The structure check's answer from #1436 on (D3): the reason, with the page count when it is supported. */
export type StructureAnswer = { reason: string; pageCount?: number };

/** A page draw's answer from #1436 on (D1, D2.5, D6): JPEG bytes when drawn. */
export type PageAnswer =
  | { outcome: "drawn"; bytes: Buffer; width: number; height: number; pageCount?: number }
  | { outcome: "refused"; reason: string }
  | { outcome: "page_not_found"; pageCount: number }
  | { outcome: "failed"; stop?: StopKind };

/** The sandbox exports the design note §1.4 names, typed as the note gives them. */
export type PopplerSandbox = {
  inspectPdfStructureInSandbox(file: FileOnDisk, options?: { maxPages?: number }): Promise<StructureAnswer>;
  renderPdfPageInSandbox(file: FileOnDisk, request: { page: number; maxEdge: number; wallMs: number; pool: Pool }): Promise<PageAnswer>;
  pdfSandboxSelfCheck(): Promise<string | undefined>;
  setPdfStructureSandboxLimitsForTests(override: Record<string, unknown> | undefined): void;
  pdfStructureSandboxInFlightForTests(): number;
  lastPdfSandboxChildPidForTests(): number | undefined;
  PDF_STRUCTURE_SANDBOX_LIMITS: Record<string, unknown>;
};

export async function loadPopplerSandbox(): Promise<PopplerSandbox> {
  return await import("@/server/documents/pdf-structure-sandbox") as unknown as PopplerSandbox;
}

export const MiB = 1024 * 1024;

/** The child's resident memory (VmRSS + VmSwap) in bytes, or undefined once it is gone. */
function childMemoryBytes(pid: number): number | undefined {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "latin1");
    const field = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(status)?.[1] ?? 0) * 1024;
    return field("VmRSS") + field("VmSwap");
  } catch {
    return undefined;
  }
}

/**
 * Runs `run` while sampling, every 2 ms, the memory of every child the sandbox
 * starts meanwhile (the pid the sandbox last reported); the highest seen,
 * independently of the sandbox's own watchdog.
 */
export async function peakChildMemory<T>(run: () => Promise<T>): Promise<{ result: T; peakBytes: number; pids: number[] }> {
  const before = lastPdfSandboxChildPidForTests();
  const pids: number[] = [];
  let peak = 0;
  const sample = () => {
    const pid = lastPdfSandboxChildPidForTests();
    if (pid === undefined || pid === before) return;
    if (!pids.includes(pid)) pids.push(pid);
    const bytes = childMemoryBytes(pid);
    if (bytes !== undefined) peak = Math.max(peak, bytes);
  };
  const sampler = setInterval(sample, 2);
  try {
    const result = await run();
    return { result, peakBytes: peak, pids };
  } finally {
    clearInterval(sampler);
  }
}

/** Every live process (other than this one) whose command line names one of `needles`. */
export function processesNaming(needles: string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${entry}/cmdline`, "latin1").replaceAll("\0", " ");
    } catch {
      continue;
    }
    if (needles.some((needle) => cmdline.includes(needle))) found.push(`${entry}: ${cmdline.trim()}`);
  }
  return found;
}

/** Waits up to `withinMs` for `pid` to be gone (ESRCH); fails the test otherwise. */
export async function expectPidGoneWithin(pid: number | undefined, withinMs: number): Promise<void> {
  expect(pid).toEqual(expect.any(Number));
  const deadline = Date.now() + withinMs;
  for (;;) {
    try {
      process.kill(pid as number, 0);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
      return;
    }
    if (Date.now() > deadline) throw new Error(`child ${pid} still running ${withinMs} ms after the job settled`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Writes an executable stand-in for a poppler tool: `/bin/sh` running `body`.
 * The sandbox gives its child an empty environment, so `body` names every
 * program by absolute path.
 */
export function writeStubTool(directory: string, name: string, body: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** What a stand-in `pdfinfo` prints for a one-page A4 file. */
export const ONE_PAGE_PDFINFO = "Pages:          1\nEncrypted:      no\nPage    1 size: 595 x 842 pts (A4)\n";

/** A real JPEG of the given size, painted with a dark block in the top-left quarter. */
export function jpegOf(width: number, height: number): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#000000";
  context.fillRect(0, 0, Math.ceil(width / 2), Math.ceil(height / 2));
  return canvas.toBuffer("image/jpeg", 85);
}

/** The frame size a JPEG's first SOF marker declares, read here by hand. */
export function jpegFrameSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return undefined;
}

/**
 * Decodes the JPEG and counts pixels darker than mid-grey inside the box
 * (pixel coordinates from the top-left), with the box's area.
 */
export async function darkPixelsIn(bytes: Buffer, box: { left: number; top: number; right: number; bottom: number }): Promise<{ dark: number; area: number }> {
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const width = Math.max(1, Math.round(box.right - box.left));
  const height = Math.max(1, Math.round(box.bottom - box.top));
  const { data } = context.getImageData(Math.round(box.left), Math.round(box.top), width, height);
  let dark = 0;
  for (let index = 0; index < data.length; index += 4) {
    const luma = 0.299 * data[index]! + 0.587 * data[index + 1]! + 0.114 * data[index + 2]!;
    if (luma < 128) dark += 1;
  }
  return { dark, area: width * height };
}

/** One soft limit from `/proc/<pid>/limits` text, e.g. "Max address space". */
export function softLimit(limitsText: string, name: string): string | undefined {
  const line = limitsText.split("\n").find((entry) => entry.startsWith(name));
  return line ? /^Max [a-z ]+?\s{2,}(\S+)/.exec(line)?.[1] : undefined;
}
