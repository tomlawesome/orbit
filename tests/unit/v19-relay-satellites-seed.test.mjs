// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { mountSatellites } from "../../web/src/lib/backdrops/satellites.js";

/*
 * #475: the relay's living backdrop takes its one seed from the caller
 * (`data.fixtures ? seedFromWorkspace(id) : rollSeed()` on the screen) and
 * never rolls its own — every other draw in the module comes from
 * $lib/sky.js's shared streamFactory, addressed by that seed. This is the
 * ratchet on that contract: the same seed must produce the same arrangement
 * every time (what the fidelity gate depends on), and two different seeds
 * must not collide by accident.
 *
 * happy-dom has no layout engine, so getBoundingClientRect() reports an
 * all-zero box for both the relay card and the dish regardless of CSS —
 * checked directly while writing this test. That does not matter here: the
 * module still builds full chunk content (stars, the fleet, the distant
 * households) against window.innerWidth/innerHeight, and it is exactly that
 * content — not pixel placement against a real layout — this test pins.
 */

/** @type {(() => void)[]} */
const teardowns = [];
afterEach(() => {
  while (teardowns.length) teardowns.pop()?.();
});

/** @param {number} seed */
function arrangementFor(seed) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const teardown = mountSatellites(root, seed);
  teardowns.push(teardown);
  teardowns.push(() => root.remove());
  const html = root.innerHTML;
  teardown();
  root.remove();
  return html;
}

describe("the relay backdrop's seeding contract", () => {
  it("draws the same arrangement from the same seed", () => {
    const a = arrangementFor(424242);
    const b = arrangementFor(424242);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toBe(b);
  });

  it("draws a different arrangement from a different seed", () => {
    const a = arrangementFor(424242);
    const b = arrangementFor(99118822);
    expect(a).not.toBe(b);
  });
});
