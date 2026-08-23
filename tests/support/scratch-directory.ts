import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A private temporary directory a test can prove stayed empty.
 *
 * Asserting against the shared `os.tmpdir()` is not evidence: every other
 * worker in the run writes there too, so the assertion fails on other people's
 * files and passes on its own. Redirecting `TMPDIR` for the duration of a test
 * gives the code under test somewhere to leak to that nothing else touches, so
 * "no plaintext was written" is a claim the assertion can actually carry.
 */
export interface ScratchDirectory {
  path: string;
  entries: () => string[];
  restore: () => void;
}

export function useScratchTemporaryDirectory(prefix: string): ScratchDirectory {
  const previous = process.env.TMPDIR;
  const path = mkdtempSync(join(tmpdir(), `${prefix}-`));
  process.env.TMPDIR = path;
  return {
    path,
    entries: () => readdirSync(path, { recursive: true }).map(String).sort(),
    restore: () => {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      rmSync(path, { recursive: true, force: true });
    },
  };
}
