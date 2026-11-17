/**
 * Archive-spooling tests must not depend on the host's free disk (#1868).
 *
 * spoolPortableArchiveUpload answers 507 unless the real disk holds the
 * declared size x 1.01 + 256 MiB, and an unsized upload declares the archive
 * body limit (the household quota, 5 GiB by default). This test seam, at the
 * host boundary, makes `statfs` from node:fs/promises report a generous fixed
 * free figure for every path, whatever the runner has (and whatever
 * ORBIT_TEST_FREE_DISK_BYTES says), so the default limits stay in force and
 * the tests' 200/413/422/500 assertions do not move with the disk.
 *
 * Import it for its side effect, before the code under test is loaded:
 *   import "../support/archive-low-disk-safe.ts";
 * A test about a full disk stubs `statfs` itself instead.
 */
import { vi } from "vitest";

/** 1 TiB: well over two unsized reservations at the default 5 GiB limit. */
export const GENEROUS_FREE_DISK_BYTES = 1024 ** 4;

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const bsize = 4096;
  const statfs = async (path: Parameters<typeof real.statfs>[0]) => {
    const actual = await real.statfs(path);
    const blocks = Math.floor(GENEROUS_FREE_DISK_BYTES / bsize);
    return { ...actual, bsize, bavail: blocks, bfree: blocks };
  };
  return { ...real, default: { ...(real as { default?: object }).default, statfs }, statfs };
});
