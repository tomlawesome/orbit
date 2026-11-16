import { describe, expect, it } from "vitest";
import { documentsOwed, storeSize } from "../../web/src/routes/administration/words.js";

/*
 * #1803: the Document jobs card says a preview store's size as a store, not as
 * a limit: KB under a megabyte, GB from a gigabyte, 0 MB when empty, "unknown"
 * when the health read could not reach the database.
 */
const KiB = 1024;
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

describe("storeSize (#1803)", () => {
  it.each([
    [null, "unknown"],
    [0, "0 MB"],
    [1, "1 KB"],
    [KiB, "1 KB"],
    [48 * KiB, "48 KB"],
    [MiB, "1 MB"],
    [5 * MiB, "5 MB"],
    [5.5 * MiB, "5.5 MB"],
    [GiB, "1 GB"],
    [2 * GiB, "2 GB"],
    [1.5 * GiB, "1.5 GB"],
  ])("%s bytes is %s", (bytes, shown) => {
    expect(storeSize(bytes)).toBe(shown);
  });
});

describe("documentsOwed for an unknown count (#1803)", () => {
  it("says unknown for null", () => {
    expect(documentsOwed(null)).toBe("unknown");
  });
});
