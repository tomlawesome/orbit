import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/*
 * #1604 R6-FR1: if only the session read fails on the very first load of the
 * administration page, the desk header showed a blank name until "try again",
 * although the server already knows who is signed in. The page load has that
 * session on locals (it is what gates the page), so it hands the signed-in
 * name to the page, and the header falls back to it when no read has
 * confirmed an account yet.
 */
function load(locals) {
  return import("../../web/src/routes/administration/+page.server.js").then((module) => module.load({ locals }));
}

beforeEach(() => { delete process.env.ORBIT_FIXTURES; });
afterEach(() => { delete process.env.ORBIT_FIXTURES; });

describe("administration header on a first load whose session read fails (#1604 R6-FR1)", () => {
  it("the page load carries the signed-in administrator's name", async () => {
    const data = await load({ session: { user: { id: "admin-1", displayName: "Ada Example", isInstanceAdmin: true } } });
    expect(data.user?.displayName).toBe("Ada Example");
  });

  it("the page load does not carry the session's secrets", async () => {
    const data = await load({
      session: { csrfToken: "csrf-placeholder", user: { id: "admin-1", displayName: "Ada Example", isInstanceAdmin: true } },
    });
    expect(JSON.stringify(data)).not.toContain("csrf-placeholder");
  });

  it("the header falls back to the load's user when nothing has been confirmed", () => {
    const src = readFileSync(new URL("../../web/src/routes/administration/+page.svelte", import.meta.url), "utf8");
    const chrome = src.match(/<Chrome [^>]*>/)?.[0] ?? "";
    expect(chrome).toMatch(/data\.user/);
  });
});
