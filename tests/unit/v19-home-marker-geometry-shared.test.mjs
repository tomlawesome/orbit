import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-Q12: renderGalaxy() (the live sky) and mountEmptySky() (the
 * newcomer's labelled sky) each computed the identical constellation-marker
 * geometry from scratch — the same mx()/ringX formula and the same veer-path
 * formula, byte-for-byte, in two different DOM-construction styles (an
 * innerHTML SVG string vs createElementNS calls). A future change to the
 * ring layout made in one had no mechanism forcing the other to follow.
 *
 * markerX()/markerRingX()/markerVeer() are now the one place that geometry
 * lives, called by both; each function keeps its own DOM-construction
 * style untouched.
 */

const BEHAVIOUR = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/home/home.behaviour.js"),
  "utf8",
);

describe("#1151 W1-Q12: one shared marker-geometry formula", () => {
  it("declares markerX/markerRingX/markerVeer once, at module scope", () => {
    expect(BEHAVIOUR).toMatch(/function markerX\(x, away\) \{/u);
    expect(BEHAVIOUR).toMatch(/function markerRingX\(away\) \{/u);
    expect(BEHAVIOUR).toMatch(/function markerVeer\(width, away\) \{/u);
    // each defined exactly once (not re-declared inside either function)
    expect([...BEHAVIOUR.matchAll(/function markerX\(/gu)].length).toBe(1);
    expect([...BEHAVIOUR.matchAll(/function markerVeer\(/gu)].length).toBe(1);
  });

  it("renderGalaxy calls the shared functions instead of its own mx/veerFor closures", () => {
    const renderGalaxy = BEHAVIOUR.slice(BEHAVIOUR.indexOf("function renderGalaxy(settle)"), BEHAVIOUR.indexOf("function mountAccount"));
    expect(renderGalaxy).toMatch(/const ringX = markerRingX\(away\);/u);
    expect(renderGalaxy).toMatch(/markerX\(6, away\)/u);
    expect(renderGalaxy).toMatch(/markerVeer\(tw, away\)/u);
    expect(renderGalaxy).toMatch(/markerVeer\(measured, away\)/u);
    expect(renderGalaxy).not.toMatch(/const mx = \(x\)/u);
    expect(renderGalaxy).not.toMatch(/const veerFor = /u);
  });

  it("mountEmptySky calls the shared functions instead of its own mx/veer", () => {
    const mountEmptySky = BEHAVIOUR.slice(BEHAVIOUR.indexOf("export function mountEmptySky("));
    expect(mountEmptySky).toMatch(/const ringX = markerRingX\(away\);/u);
    expect(mountEmptySky).toMatch(/const veer = markerVeer\(tw, away\);/u);
    expect(mountEmptySky).toMatch(/x: markerX\(6, away\)/u);
    expect(mountEmptySky).not.toMatch(/const mx = \(x\)/u);
  });
});
