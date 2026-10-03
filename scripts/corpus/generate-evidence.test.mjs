import { describe, expect, it } from "vitest";

import { escapedCharacterCount } from "./generate-evidence.mjs";

/*
 * X-Q4 (#1151): the span-length calculation that uses this count used to be
 * `collapse(value).length + (unescape_(collapse(value)).length !== collapse(value).length ? 0 : 0)`
 * -- a ternary whose two branches are both 0, so it always added nothing,
 * regardless of its own condition. A value like "Marks & Spencer" gains one
 * escaping backslash per special character in Tika's own output ("Marks \&
 * Spencer"), so the matched span in the original (escaped) text is longer
 * than the plain value by that many characters, and undercounting it
 * truncated the needle. escapedCharacterCount() is the piece that now
 * supplies the real count.
 */
describe("escapedCharacterCount", () => {
  it("is zero for a value with nothing Tika would escape", () => {
    expect(escapedCharacterCount("British Gas")).toBe(0);
  });

  it("counts each character Tika's markdown escaping would add a backslash before", () => {
    expect(escapedCharacterCount("Marks & Spencer")).toBe(1);
    expect(escapedCharacterCount("A&B #1 <note>")).toBe(4);
  });
});
