import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * #1868: spoolPortableArchiveUpload answers 507 unless the real disk holds the
 * declared size x 1.01 + 256 MiB, and an unsized upload declares the archive
 * body limit (the household quota, 5 GiB by default). A unit test that drives
 * archive spooling therefore passes or fails with the runner's free space.
 *
 * Every such test file must either import the shared low-disk-safe setup
 * (tests/support/archive-low-disk-safe) or stub `statfs` itself (the full-disk
 * tests do). The check is on file contents, so it needs no clock and no disk.
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
const SELF = "tests/unit/archive-tests-ignore-host-disk-1868.test.mjs";

function testFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...testFiles(path));
    else if (/\.test\.(mjs|ts|js)$/.test(name)) found.push(path);
  }
  return found;
}

const DRIVES_SPOOLING = /spoolPortableArchiveUpload|portable-archives\/(import|preview)\/\+server|server\/archive-upload\.js/;
const SHARED_SETUP = /support\/archive-low-disk-safe/;
// A file about a full disk keeps its own disk stubs (#1868 issue text).
const OWN_STUB = /statfs/;
const ABOUT_FULL_DISK = /full-disk/;

describe("archive unit tests do not read the host's free disk (#1868)", () => {
  it("every file that drives archive spooling uses the shared low-disk-safe setup or stubs statfs", () => {
    const files = [...testFiles(join(root, "tests/unit")), ...testFiles(join(root, "src"))]
      .map((p) => relative(root, p))
      .filter((p) => p !== SELF);
    const driving = files.filter((p) => DRIVES_SPOOLING.test(readFileSync(join(root, p), "utf8")));
    expect(driving.length).toBeGreaterThan(0);
    const unsafe = driving.filter((p) => {
      const text = readFileSync(join(root, p), "utf8");
      return !SHARED_SETUP.test(text) && !OWN_STUB.test(text) && !ABOUT_FULL_DISK.test(p);
    });
    expect(unsafe).toEqual([]);
  });
});
