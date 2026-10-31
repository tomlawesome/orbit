import { describe, expect, it } from "vitest";

import { serverParseError } from "./check-svelte-server-parse.mjs";

describe("serverParseError (#1138)", () => {
  // svelte 5.57.1 fixed #1138 upstream: the sources that used to compile to
  // unparseable output now give no error.
  it("passes a JSDoc-typed arrow parameter in the script", () => {
    expect(serverParseError("<script>const f = (/** @type {string} */ t) => t;</script>")).toBeNull();
  });

  it("passes one inside a nested function", () => {
    // Fixed upstream in svelte 5.57.1, like the top-level case above.
    expect(serverParseError("<script>function g(a) { return a.map((/** @type {string} */ p) => p); }</script>")).toBeNull();
  });

  it("passes the same function typed on its variable", () => {
    expect(serverParseError("<script>/** @type {(t: string) => string} */\nconst f = (t) => t;</script>")).toBeNull();
  });

  it("passes the cast idiom the codebase uses", () => {
    expect(serverParseError("<script>let e = null; const m = /** @type {{ message?: string }} */ (e)?.message;</script>")).toBeNull();
  });
});
