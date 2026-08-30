import { existsSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the setup file in temp-root.ts (#654). Without it the suites leak
 * every mkdtemp they make — ~88k directories filled this host's 12G /tmp and
 * started failing runs with ENOSPC. Deleting the setup file would otherwise
 * break nothing visible until the disk filled again weeks later.
 */
describe("per-test-file temporary root (#654)", () => {
  it("points TMPDIR at a private root, not the shared temporary directory", () => {
    const root = process.env.TMPDIR;
    expect(root, "TMPDIR is unset: the temp-root setup file is not running").toBeTruthy();
    expect(statSync(root as string).isDirectory()).toBe(true);
    expect(basename(root as string)).toMatch(/^orbit-vitest-/);
  });

  it("puts every mkdtemp inside that root, so removing the root removes them all", () => {
    const root = realpathSync(process.env.TMPDIR as string);
    // Exactly how the leaking suites build their paths: join(tmpdir(), prefix).
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "orbit-temp-root-check-")));
    expect(existsSync(scratch)).toBe(true);
    expect(dirname(scratch)).toBe(root);
    // Deliberately not removed: the point is that the root's removal covers it.
  });
});
