/**
 * Test mode: the host has little free disk (#1868).
 *
 * When ORBIT_TEST_FREE_DISK_BYTES is set, `statfs` from node:fs/promises
 * reports that many free bytes for every path, so a suite can be run as if the
 * CI runner were short of disk without filling a real one. Unset, `statfs` is
 * the real one. Registered as a setup file, so it covers every unit test file
 * that does not mock node:fs/promises itself.
 *
 *   ORBIT_TEST_FREE_DISK_BYTES=1073741824 pnpm exec vitest run <files>
 */
import { vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const forced = Number(process.env.ORBIT_TEST_FREE_DISK_BYTES);
  if (!Number.isFinite(forced) || forced <= 0) return real;
  const bsize = 4096;
  const statfs = async (path: Parameters<typeof real.statfs>[0]) => {
    const actual = await real.statfs(path);
    return { ...actual, bsize, bavail: Math.floor(forced / bsize), bfree: Math.floor(forced / bsize) };
  };
  return { ...real, default: { ...(real as { default?: object }).default, statfs }, statfs };
});
