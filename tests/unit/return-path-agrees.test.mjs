import { describe, expect, it } from "vitest";

import { safeReturnPath } from "@/lib/auth/crypto";
import { isApplicationRelative } from "../../web/src/lib/return-path.js";

/*
 * ADR-0034 decision 4 (#1335): the browser and the engine must not disagree on
 * which sign-in return paths are acceptable. The browser's check decides
 * whether to offer the path; the engine's decides whether to follow it.
 */

const cases = [
  ["empty", ""],
  ["null", null],
  ["root", "/"],
  ["a path", "/home"],
  ["a path with query and fragment", "/home?x=1#y"],
  ["protocol-relative", "//evil.example"],
  ["slash then backslash", "/\\evil.example"],
  ["leading backslash", "\\home"],
  ["no leading slash", "home"],
  ["absolute URL", "https://evil.example"],
  ["NUL control character", "/a\u0000b"],
  ["unit separator control character", "/a\u001fb"],
  ["DEL control character", "/a\u007fb"],
];

describe("the sign-in return-path check agrees across the seam (#1335)", () => {
  it.each(cases)("browser and engine agree on %s", (_name, value) => {
    expect(isApplicationRelative(value)).toBe(safeReturnPath(value) === value);
  });

  it("both reject a DEL character", () => {
    const value = "/a\u007fb";
    expect(isApplicationRelative(value)).toBe(false);
    expect(safeReturnPath(value)).toBe("/");
  });
});
