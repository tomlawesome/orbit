import { describe, expect, it } from "vitest";

import { pageKeyTarget, pageTurn } from "../../web/src/lib/data/page-turn.js";

/*
 * #1300: the words and arrows both page-turners draw -- the preview's small
 * pager and the reader -- as design/v19/document-card/round-6 places them:
 * the reader's head says "page N of M", its foot and the preview's pager
 * "N of M"; an arrow only where there is a page that way; a one-page file
 * says "one page" and has no arrows. Until a response has said how many
 * pages there are, nothing claims a count and nothing turns.
 */

describe("pageTurn", () => {
  it("page 1 of 3: no way back, a way forward", () => {
    expect(pageTurn(1, 3)).toEqual({ head: "page 1 of 3", of: "1 of 3", arrows: true, back: false, forward: true });
  });

  it("page 2 of 3: both ways", () => {
    expect(pageTurn(2, 3)).toEqual({ head: "page 2 of 3", of: "2 of 3", arrows: true, back: true, forward: true });
  });

  it("page 3 of 3: a way back, no way forward", () => {
    expect(pageTurn(3, 3)).toEqual({ head: "page 3 of 3", of: "3 of 3", arrows: true, back: true, forward: false });
  });

  it("a one-page file says one page and has no arrows at all", () => {
    expect(pageTurn(1, 1)).toEqual({ head: "one page", of: "one page", arrows: false, back: false, forward: false });
  });

  it("an unknown count claims none and offers nothing to turn", () => {
    expect(pageTurn(1, null)).toEqual({ head: "page 1", of: "", arrows: false, back: false, forward: false });
  });
});

describe("pageKeyTarget", () => {
  it("← and PageUp go back one; → and PageDown forward one", () => {
    expect(pageKeyTarget("ArrowLeft", 2, 3)).toBe(1);
    expect(pageKeyTarget("PageUp", 3, 3)).toBe(2);
    expect(pageKeyTarget("ArrowRight", 1, 3)).toBe(2);
    expect(pageKeyTarget("PageDown", 2, 3)).toBe(3);
  });

  it("Home is the first page and End the last", () => {
    expect(pageKeyTarget("Home", 3, 3)).toBe(1);
    expect(pageKeyTarget("End", 1, 3)).toBe(3);
  });

  it("a page key with nowhere to go is still a page key, and turns nothing", () => {
    expect(pageKeyTarget("ArrowLeft", 1, 3)).toBeNull();
    expect(pageKeyTarget("End", 3, 3)).toBeNull();
    expect(pageKeyTarget("ArrowRight", 1, 1)).toBeNull();
    expect(pageKeyTarget("ArrowRight", 1, null)).toBeNull();
  });

  it("any other key is not a page key", () => {
    expect(pageKeyTarget("Enter", 1, 3)).toBeUndefined();
    expect(pageKeyTarget("+", 1, 3)).toBeUndefined();
    expect(pageKeyTarget("Escape", 1, 3)).toBeUndefined();
  });
});
