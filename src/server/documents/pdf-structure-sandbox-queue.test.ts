import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { largeFixtureDirectory, removeFixtureDirectory, writeFixtureFile } from "../../../tests/support/large-pdf";
import { jpegOf, ONE_PAGE_PDFINFO, writeStubTool } from "../../../tests/support/poppler-sandbox";
import { setSandboxLimits, withLogRecords } from "../../../tests/support/sandbox-test-helpers";
import { textPagesPdf } from "../../../tests/support/pdf-measure/fixtures";
import {
  readPdfPageCountInSandbox,
  renderPdfPageInSandbox,
  VIEW_SLOT_WAIT_MS,
  VIEW_WAITING_LIMIT,
  type SandboxPool,
} from "./pdf-structure-sandbox";

/**
 * #1446 decision 1: the view pool's wait is bounded (VIEW_SLOT_WAIT_MS = 4,000
 * ms, at most VIEW_WAITING_LIMIT = 8 waiting; a ninth is refused at once). A
 * refused or timed-out view draw answers `{ outcome: "failed", stop: "queue_full" }`
 * without starting a child. The check and background pools keep unbounded
 * first-in-first-out waits. Children are stand-in tools held open by gate
 * files; only setTimeout/clearTimeout are faked, so the children's real I/O
 * still runs.
 */

const FOREVER_MS = 10 * 60_000;
let directory: string;
let file: { path: string; sizeBytes: number };
let pending: Promise<unknown>[] = [];

beforeAll(() => {
  directory = largeFixtureDirectory();
  const bytes = textPagesPdf(1);
  file = { path: writeFixtureFile(directory, "queue.pdf", bytes), sizeBytes: bytes.length };
});
afterAll(() => removeFixtureDirectory(directory));

const gate = (name: string) => join(directory, `gate-${name}`);
const ran = (name: string) => join(directory, `ran-${name}`);
const open = (name: string) => writeFileSync(gate(name), "");

/** A renderer that marks it started for page $2, waits for that page's gate, then answers a JPEG. */
function holdingRenderer(): string {
  const jpegPath = join(directory, "queue.jpg");
  writeFileSync(jpegPath, jpegOf(848, 1_200));
  return writeStubTool(directory, "pdftoppm-hold", `: > "${directory}/ran-$2"\nwhile [ ! -e "${directory}/gate-$2" ]; do /bin/sleep 0.02; done\nexec /bin/cat "${jpegPath}"`);
}

/** A pdfinfo that marks itself started, waits for the "info" gate, then answers. */
function holdingInfo(tag: string): string {
  return writeStubTool(directory, `pdfinfo-hold-${tag}`, `: > "${directory}/ran-${tag}-$$"\nwhile [ ! -e "${directory}/gate-${tag}" ]; do /bin/sleep 0.02; done\n/usr/bin/printf '${ONE_PAGE_PDFINFO.replaceAll("\n", "\\n")}'`);
}

const draw = (page: number, pool: SandboxPool = "view") => {
  const run = renderPdfPageInSandbox(file, { page, maxEdge: 1_200, wallMs: FOREVER_MS, pool });
  pending.push(run);
  return run;
};

/** Lets real I/O run (the clock is faked) until `check` holds, or fails after 10 real seconds. */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
const started = (name: string) => until(() => existsSync(ran(name)), `job ${name} started`);

/** Whether a promise has settled, without waiting for it. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  return done;
}

beforeEach(() => {
  pending = [];
  setSandboxLimits({ pdftoppmPath: holdingRenderer(), pdfinfoPath: holdingInfo("count"), wallMs: FOREVER_MS, concurrency: { check: 2, view: 2, background: 1 } });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(async () => {
  for (const name of ["1", "2", "3", "4", "5", "count", "a", "b"]) open(name);
  for (let page = 6; page < 30; page += 1) open(String(page));
  vi.useRealTimers();
  await Promise.allSettled(pending);
  setSandboxLimits(undefined);
});

describe("the view pool's wait is bounded (#1446 decision 1)", () => {
  it("names its two figures", () => {
    expect(VIEW_SLOT_WAIT_MS).toBe(4_000);
    expect(VIEW_WAITING_LIMIT).toBe(8);
  });

  it("answers queue_full after VIEW_SLOT_WAIT_MS, not before, and never starts a child for it", async () => {
    const one = draw(1);
    const two = draw(2);
    await started("1");
    await started("2");
    const three = draw(3);

    await vi.advanceTimersByTimeAsync(VIEW_SLOT_WAIT_MS - 1);
    expect(await settled(three)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await three).toEqual({ outcome: "failed", stop: "queue_full" });
    expect(existsSync(ran("3")), "no child started for the timed-out waiter").toBe(false);

    open("1");
    open("2");
    expect((await one).outcome).toBe("drawn");
    expect((await two).outcome).toBe("drawn");
  });

  it("refuses the ninth waiter at once, with no clock movement, and keeps the eight", async () => {
    draw(1);
    draw(2);
    await started("1");
    await started("2");
    const waiters = Array.from({ length: VIEW_WAITING_LIMIT }, (_, index) => draw(3 + index));
    expect(await settled(waiters[0]!)).toBe(false);

    const { result: ninth, records } = await withLogRecords(() => draw(99));
    expect(ninth).toEqual({ outcome: "failed", stop: "queue_full" });
    for (const waiter of waiters) expect(await settled(waiter), "the eight waiting are still waiting").toBe(false);
    expect(records.filter((record) => record.level === "info")).toHaveLength(1);
    expect(existsSync(ran("99"))).toBe(false);

    await vi.advanceTimersByTimeAsync(VIEW_SLOT_WAIT_MS);
    for (const waiter of waiters) expect(await waiter).toEqual({ outcome: "failed", stop: "queue_full" });
  });

  it("removes a timed-out waiter: the next waiter gets the freed slot and two jobs still run at once", async () => {
    draw(1);
    const two = draw(2);
    await started("1");
    await started("2");
    const three = draw(3);
    await vi.advanceTimersByTimeAsync(2_000);
    const four = draw(4);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await three).toEqual({ outcome: "failed", stop: "queue_full" });
    expect(await settled(four), "page 4 has waited only 2 s").toBe(false);

    open("1");
    await started("4");
    expect(existsSync(ran("3")), "the timed-out waiter never gets a slot").toBe(false);
    expect(await settled(two), "page 2 still holds a slot, beside page 4").toBe(false);

    // Two at once again: a fresh waiter must wait for one of them, and gets a slot when one ends.
    const five = draw(5);
    expect(existsSync(ran("5"))).toBe(false);
    open("2");
    await started("5");
    open("4");
    open("5");
    expect((await four).outcome).toBe("drawn");
    expect((await five).outcome).toBe("drawn");
  });

  it("is not tripped by a waiter that was served in time: a freed slot within the wait hands over", async () => {
    draw(1);
    draw(2);
    await started("1");
    await started("2");
    const three = draw(3);
    await vi.advanceTimersByTimeAsync(VIEW_SLOT_WAIT_MS - 1_000);
    open("1");
    await started("3");
    await vi.advanceTimersByTimeAsync(VIEW_SLOT_WAIT_MS * 3);
    open("3");
    expect((await three).outcome).toBe("drawn");
  });
});

describe("the check and background pools keep unbounded waits (#1446 decision 1)", () => {
  it("background: one job runs, ten wait past any bound, none refused, all drawn in turn", async () => {
    const first = draw(1, "background");
    await started("1");
    const waiters = Array.from({ length: 10 }, (_, index) => draw(10 + index, "background"));
    await vi.advanceTimersByTimeAsync(10 * VIEW_SLOT_WAIT_MS);
    for (const waiter of waiters) expect(await settled(waiter)).toBe(false);

    open("1");
    for (let page = 10; page < 20; page += 1) open(String(page));
    expect((await first).outcome).toBe("drawn");
    for (const waiter of waiters) expect((await waiter).outcome).toBe("drawn");
  });

  it("check: two jobs run, ten wait past any bound, none refused", async () => {
    setSandboxLimits({ pdftoppmPath: holdingRenderer(), pdfinfoPath: holdingInfo("a"), wallMs: FOREVER_MS, concurrency: { check: 2, view: 2, background: 1 } });
    const jobs = Array.from({ length: 12 }, () => {
      const run = readPdfPageCountInSandbox(file, "check");
      pending.push(run);
      return run;
    });
    await vi.advanceTimersByTimeAsync(10 * VIEW_SLOT_WAIT_MS);
    for (const job of jobs.slice(2)) expect(await settled(job)).toBe(false);

    open("a");
    for (const job of jobs) expect(await job).toEqual({ outcome: "counted", pageCount: 1 });
  });
});
