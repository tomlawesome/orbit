import * as realFs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Audit Low Config P-16: atomicWriteFile renamed without fsync of the temp
// file or the folder. node:fs is wrapped here so the sync calls are visible;
// a separate file because the mock applies to the whole module graph.
const fsyncCalls: number[] = [];
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      fsyncCalls.push(fd);
      return actual.fsyncSync(fd);
    },
  };
});

import { internal as configureEngineInternal } from "./configure-engine";

let dir: string;
beforeEach(() => {
  fsyncCalls.length = 0;
  dir = mkdtempSync(join(tmpdir(), "orbit-fsync-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("atomicWriteFile durability (P-16)", () => {
  it("fsyncs both the new file and its folder before the write counts as done", () => {
    configureEngineInternal.atomicWriteFile(join(dir, "secret"), "x\n", 0o600, "installing");
    expect(realFs.readFileSync(join(dir, "secret"), "utf8")).toBe("x\n");
    expect(fsyncCalls.length).toBeGreaterThanOrEqual(2);
  });
});
