import { afterEach, describe, expect, it, vi } from "vitest";

// A shell that refuses `ulimit -d`: the image child's wrapper exits 126.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((file: string, args: readonly string[], options: object) => {
      if (args.some((argument) => typeof argument === "string" && argument.includes("ulimit -t"))) {
        return actual.spawn("/bin/sh", ["-c", "exit 126"], options);
      }
      return actual.spawn(file, args as string[], options);
    }) as typeof actual.spawn,
  };
});

import { syntheticJpeg } from "../../../tests/support/synthetic-documents";
import { pdfStructureSandboxInFlightForTests, renderImageInSandbox, setPdfStructureSandboxLimitsForTests } from "./pdf-structure-sandbox";

afterEach(() => setPdfStructureSandboxLimitsForTests(undefined));

describe("the image child when the shell refuses its limits (#1433 D20)", () => {
  it("answers a render as failed with stop unavailable: a fault on Orbit's side, never stored as a crash", async () => {
    const rendered = await renderImageInSandbox(syntheticJpeg(), {
      mediaType: "image/jpeg",
      declared: { width: 1, height: 1 },
      width: 1,
      height: 1,
      wallMs: 8_000,
    });

    expect(rendered).toEqual({ outcome: "failed", stop: "unavailable" });
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
  }, 20_000);
});
