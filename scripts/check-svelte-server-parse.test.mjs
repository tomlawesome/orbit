import { describe, expect, it } from "vitest";

import { serverParseError } from "./check-svelte-server-parse.mjs";

describe("serverParseError (#1138)", () => {
  it("flags a JSDoc-typed arrow parameter in the script", () => {
    expect(serverParseError("<script>const f = (/** @type {string} */ t) => t;</script>")).toMatch(/destructuring|binding/i);
  });

  it("flags one inside a nested function", () => {
    expect(serverParseError("<script>function g(a) { return a.map((/** @type {string} */ p) => p); }</script>")).not.toBeNull();
  });

  it("passes the same function typed on its variable", () => {
    expect(serverParseError("<script>/** @type {(t: string) => string} */\nconst f = (t) => t;</script>")).toBeNull();
  });

  it("passes the cast idiom the codebase uses", () => {
    expect(serverParseError("<script>let e = null; const m = /** @type {{ message?: string }} */ (e)?.message;</script>")).toBeNull();
  });
});
