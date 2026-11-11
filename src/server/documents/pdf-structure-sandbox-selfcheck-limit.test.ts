import { afterEach, describe, expect, it, vi } from "vitest";

// Stands in for a shell that refuses `ulimit`: the sandbox's wrapper script is
// replaced by one that exits 126, exactly what `|| exit 126` does when the
// shell says no. Everything else spawns as it is.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((file: string, args: readonly string[], options: object) => {
      if (args.some((argument) => typeof argument === "string" && argument.includes("ulimit -"))) {
        return actual.spawn("/bin/sh", ["-c", "exit 126"], options);
      }
      return actual.spawn(file, args as string[], options);
    }) as typeof actual.spawn,
  };
});

import { pdfSandboxSelfCheck, setPdfStructureSandboxLimitsForTests } from "./pdf-structure-sandbox";

afterEach(() => setPdfStructureSandboxLimitsForTests(undefined));

describe("the sandbox self-check when the shell refuses ulimit -v (#1436 D11)", () => {
  it("reports as_limit_not_applied, not child_not_started: the child started, without its limit", async () => {
    // Any existing program: the wrapper exits 126 before it would run.
    setPdfStructureSandboxLimitsForTests({ pdfinfoPath: process.execPath });
    await expect(pdfSandboxSelfCheck()).resolves.toBe("as_limit_not_applied");
  }, 10_000);
});
