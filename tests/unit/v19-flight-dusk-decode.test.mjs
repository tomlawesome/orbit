import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

/*
 * #1299: the dusk's six full-screen pictures load when the sign-out starts
 * but stay invisible until the dusk beat (3.6 s), and a browser decodes a
 * picture only when it is first drawn -- so Firefox decoded all six, the two
 * Earth photographs among them, in the very frames the dusk fades in. They
 * are now decoded in the background as the dusk mounts.
 *
 * Shaped like v19-flight-home-ready.test.mjs (a behavioural check of the
 * module with the page stubbed) and v19-flight-glyph-visibility-dedup.test.mjs
 * (the component read as text).
 */

const FLIGHT = resolve(import.meta.dirname, "../../web/src/lib/flight");

function picture({ fails = false } = {}) {
  /** @type {() => void} */
  let finish = () => {};
  const done = new Promise((ok, no) => { finish = () => (fails ? no(new Error("EncodingError")) : ok(undefined)); });
  return { src: "", decoding: "", decode: vi.fn(() => done), finish };
}

describe("the dusk's pictures are decoded before the dusk beat (#1299)", () => {
  it("decodes every picture it is given, in the background, and holds them", async () => {
    expect(existsSync(resolve(FLIGHT, "decode-ahead.js"))).toBe(true);
    const { decodeAhead } = await import("$lib/flight/decode-ahead.js");
    const made = [picture(), picture()];
    let i = 0;
    const { ready, held } = decodeAhead(["/a.webp", "/b.webp"], () => /** @type {any} */ (made[i++]));
    expect(held).toEqual(made);
    expect(made.map((p) => [p.src, p.decoding])).toEqual([["/a.webp", "async"], ["/b.webp", "async"]]);
    for (const p of made) expect(p.decode).toHaveBeenCalledOnce();
    let settled = false;
    ready.then(() => { settled = true; });
    made[0].finish();
    await Promise.resolve();
    expect(settled).toBe(false);
    made[1].finish();
    await ready;
    expect(settled).toBe(true);
  });

  it("a picture that cannot be decoded does not stop the rest", async () => {
    const { decodeAhead } = await import("$lib/flight/decode-ahead.js");
    const made = [picture({ fails: true }), picture()];
    let i = 0;
    const { ready } = decodeAhead(["/a.webp", "/b.webp"], () => /** @type {any} */ (made[i++]));
    for (const p of made) p.finish();
    await expect(ready).resolves.toBeUndefined();
  });

  it("the dusk asks for every one of its pictures as it mounts, and lets them go when it goes", () => {
    const dusk = readFileSync(resolve(FLIGHT, "Dusk.svelte"), "utf8");
    expect(dusk).toMatch(/import \{ decodeAhead \} from "\.\/decode-ahead\.js";/u);
    const mount = dusk.slice(dusk.indexOf('world.dataset.rasterised = "pending";'));
    const ask = mount.indexOf("decodeAhead(images.map((im) => /** @type {string} */ (im.dataset.href))).held");
    expect(ask).toBeGreaterThan(-1);
    /* asked at once, not a frame later when the pictures' addresses are set */
    expect(ask).toBeLessThan(mount.indexOf("requestAnimationFrame("));
    expect(mount).toMatch(/return \(\) => \{[^}]*pictures\.length = 0;/u);
    /* all six: the glow, the belt, the afterglow, both Earth photographs, the rim */
    expect([...dusk.matchAll(/<image[^>]*data-href=/gu)]).toHaveLength(6);
  });
});
