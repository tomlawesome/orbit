import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { syntheticJpeg } from "../../../tests/support/synthetic-documents";
import { lastPdfSandboxChildPidForTests, renderImageInSandbox } from "./pdf-structure-sandbox";

/** Field 19 of /proc/<pid>/stat, the nice value (fields counted after the parenthesised name). */
function niceOf(stat: string): number {
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[16]);
}

/**
 * Runs `job`, sampling the nice value of every stage of the child it starts
 * once it runs its own program (not the fork copy of this process, nor `nice`
 * itself before it has lowered its priority).
 */
async function niceValuesDuring(job: () => Promise<unknown>): Promise<number[]> {
  const before = lastPdfSandboxChildPidForTests();
  const ownCmdline = readFileSync("/proc/self/cmdline", "latin1");
  const seen = new Set<number>();
  const sampler = setInterval(() => {
    const pid = lastPdfSandboxChildPidForTests();
    if (pid === undefined || pid === before) return;
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "latin1");
      if (cmdline === "" || cmdline === ownCmdline || cmdline.split("\0")[0]!.split("/").pop() === "nice") return;
      seen.add(niceOf(readFileSync(`/proc/${pid}/stat`, "latin1")));
    } catch {
      // gone between polls
    }
  }, 2);
  try {
    await job();
  } finally {
    clearInterval(sampler);
  }
  return [...seen];
}

const draw = (pool: "view" | "background") => () => renderImageInSandbox(syntheticJpeg(), {
  mediaType: "image/jpeg",
  declared: { width: 1, height: 1 },
  width: 1,
  height: 1,
  wallMs: 8_000,
  pool,
});

describe("an image draw's canvas child (#1436 D5, #1433 D21)", () => {
  const own = niceOf(readFileSync("/proc/self/stat", "latin1"));

  it("runs at nice 10 in the background pool", async () => {
    const seen = await niceValuesDuring(draw("background"));
    expect(seen).toEqual([Math.min(19, own + 10)]);
  }, 20_000);

  it("runs at this process's own priority in the view pool", async () => {
    const seen = await niceValuesDuring(draw("view"));
    expect(seen).toEqual([own]);
  }, 20_000);
});
