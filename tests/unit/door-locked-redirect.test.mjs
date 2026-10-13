import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #1405: the sign-in door is a prerendered page, served by the static layer
 * before the server's gate can answer, so it is the door's own JavaScript that
 * must not show a sign-in button to somebody who cannot sign in. When
 * `GET /api/auth/availability` says the encryption key is unusable
 * (door-state.js turns that into LOCKED), the door replaces itself with
 * /maintenance, the one screen that says why. A source tripwire in the style of
 * door-host-wiring.test.mjs, because the Svelte component itself needs a browser.
 */
const root = path.resolve(import.meta.dirname, "../..");
const signIn = readFileSync(path.join(root, "web/src/lib/flight/SignIn.svelte"), "utf8");

describe("the sign-in door sends a locked instance to /maintenance (#1405)", () => {
  it("knows the LOCKED state from door-state.js", () => {
    expect(signIn).toMatch(/\bLOCKED\b/u);
    const imports = [...signIn.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/door-state\.js["']/gu)].map((match) => match[1]).join(",");
    expect(imports).toMatch(/\bLOCKED\b/u);
  });

  it("replaces the page with /maintenance, rather than pushing history, so Back is not a loop", () => {
    expect(signIn).toMatch(/location\.replace\(\s*["']\/maintenance["']\s*\)/u);
  });

  it("does that on the LOCKED branch", () => {
    const at = signIn.search(/location\.replace\(\s*["']\/maintenance["']\s*\)/u);
    expect(at).toBeGreaterThan(-1);
    const window = signIn.slice(Math.max(0, at - 400), at);
    expect(window).toMatch(/\bLOCKED\b/u);
  });
});
