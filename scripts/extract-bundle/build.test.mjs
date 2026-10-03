import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { digest, download, downloadVerified } from "./build.mjs";

/*
 * O2-R5 (#1151): a download interrupted partway used to leave a half-written
 * file at the cache path, and `download()`'s own `existsSync` check then
 * protected that half file forever -- every later build failed the same
 * checksum with no way out but a human deleting the cache by hand. These
 * tests stand in a fake `fetch` (no real network) to prove the fix without
 * depending on nodejs.org or archive.apache.org.
 */

let directory;

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function okResponse(body) {
  return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body) };
}

describe("download", () => {
  it("writes the file and leaves no temp name behind", async () => {
    directory = mkdtempSync(join(tmpdir(), "orbit-extract-bundle-"));
    const to = join(directory, "node.zip");

    await download("https://example.invalid/node.zip", to, {
      fetchImpl: async () => okResponse("real content"),
    });

    expect(readFileSync(to, "utf8")).toBe("real content");
    expect(existsSync(`${to}.part`)).toBe(false);
  });

  it("never writes to the final path when the fetch fails partway", async () => {
    directory = mkdtempSync(join(tmpdir(), "orbit-extract-bundle-"));
    const to = join(directory, "node.zip");

    await expect(
      download("https://example.invalid/node.zip", to, {
        fetchImpl: async () => {
          throw new Error("connection reset");
        },
      }),
    ).rejects.toThrow("connection reset");

    expect(existsSync(to)).toBe(false);
    expect(existsSync(`${to}.part`)).toBe(false);
  });

  it("does not fetch again when a cached file is already there", async () => {
    directory = mkdtempSync(join(tmpdir(), "orbit-extract-bundle-"));
    const to = join(directory, "node.zip");
    writeFileSync(to, "already cached");
    let calls = 0;

    await download("https://example.invalid/node.zip", to, {
      fetchImpl: async () => {
        calls += 1;
        return okResponse("fresh content");
      },
    });

    expect(calls).toBe(0);
    expect(readFileSync(to, "utf8")).toBe("already cached");
  });
});

describe("downloadVerified", () => {
  // Reproduces the bug directly: a cache entry left over from a previous
  // half-finished run (simulated here by writing garbage straight to `to`,
  // the same place a killed `download()` used to leave one) must be deleted
  // and fetched again, not believed forever.
  it("deletes a corrupt cached file and fetches it again once", async () => {
    directory = mkdtempSync(join(tmpdir(), "orbit-extract-bundle-"));
    const to = join(directory, "node.zip");
    writeFileSync(to, "half-written garbage from a killed run");
    const good = "the real archive bytes";
    const expected = createHash("sha256").update(good).digest("hex");
    let calls = 0;

    await downloadVerified(
      "https://example.invalid/node.zip",
      to,
      () => {
        if (digest(to, "sha256") !== expected) throw new Error("checksum mismatch");
      },
      {
        fetchImpl: async () => {
          calls += 1;
          return okResponse(good);
        },
      },
    );

    expect(calls).toBe(1);
    expect(readFileSync(to, "utf8")).toBe(good);
  });

  it("throws, and does not retry a second time, when the refetched file is still bad", async () => {
    directory = mkdtempSync(join(tmpdir(), "orbit-extract-bundle-"));
    const to = join(directory, "node.zip");
    writeFileSync(to, "garbage");
    let calls = 0;

    await expect(
      downloadVerified(
        "https://example.invalid/node.zip",
        to,
        () => {
          throw new Error("checksum mismatch");
        },
        {
          fetchImpl: async () => {
            calls += 1;
            return okResponse("still not the right bytes");
          },
        },
      ),
    ).rejects.toThrow("checksum mismatch");

    // The first `download()` call is a cache hit (the garbage file already
    // exists) and fetches nothing; the one real fetch is the single retry
    // after the cache is deleted. A second retry would make this 2.
    expect(calls).toBe(1);
  });

  it("does not touch a cache entry that already verifies", async () => {
    directory = mkdtempSync(join(tmpdir(), "orbit-extract-bundle-"));
    const to = join(directory, "node.zip");
    writeFileSync(to, "already good");
    let calls = 0;

    await downloadVerified(
      "https://example.invalid/node.zip",
      to,
      () => {},
      {
        fetchImpl: async () => {
          calls += 1;
          return okResponse("should never be fetched");
        },
      },
    );

    expect(calls).toBe(0);
    expect(readFileSync(to, "utf8")).toBe("already good");
  });
});
