import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/*
 * design/v19/home-sun/round-4/build.py writes the pages next to itself, so it
 * is run on a copy of the round folder. Rebuilding must reproduce the
 * committed pages byte for byte, or a rebuild silently loses hand edits.
 */
const round = join(dirname(fileURLToPath(import.meta.url)), "..", "design", "v19", "home-sun", "round-4");
const PAGES = ["g-log-tuner.html", "h-importance-weights.html", "i-importance-hues.html"];

describe("design/v19/home-sun/round-4/build.py", () => {
  const scratch = mkdtempSync(join(tmpdir(), "orbit-round-4-"));
  const copy = join(scratch, "round-4");
  cpSync(round, copy, { recursive: true });
  const built = spawnSync("python3", ["-I", join(copy, "build.py")], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });

  it("runs", () => {
    expect(built.status, built.stderr).toBe(0);
  });

  for (const page of PAGES) {
    it(`reproduces the committed ${page} byte for byte`, () => {
      expect(readFileSync(join(copy, page), "utf8")).toBe(readFileSync(join(round, page), "utf8"));
    });
  }

  it("cleans up", () => {
    rmSync(scratch, { recursive: true, force: true });
  });
});
