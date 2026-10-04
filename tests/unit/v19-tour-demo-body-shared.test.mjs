// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { dialPlacement } from "../../web/src/lib/data/chart.js";
import { drawDemoBody, ease, positionDemoBody } from "../../web/src/lib/tour/chapters/demo-body.js";

/*
 * #1151 W3-Q4: 05-time-runs.js and 09-done.js's ease()/drawTimeBody()/
 * positionTimeBody() were byte-for-byte identical; 12-yours.js repeated the
 * same shape renamed to drawYearBody/positionYearBody; 03-lands.js repeated
 * the static half (drawLandedBody, which never repositions). A future
 * retune of the demo dot's radius or fill had to be remembered in all four
 * places.
 *
 * demo-body.js is the one place that scaffolding lives now, taking each
 * chapter's own class names as arguments rather than hard-coding one
 * chapter's. This pins the shared module's own real behaviour (import and
 * run it, not just read its text), plus that all four chapters now call it.
 */

describe("#1151 W3-Q4: demo-body.js's shared drawing", () => {
  it("ease() matches the mockup's own walk curve", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(1 - Math.pow(0.5, 3), 10);
  });

  it("drawDemoBody appends a <g class={groupClass}> with one <circle class={dotClass}> at dialPlacement's spot", () => {
    const dial = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const group = drawDemoBody(document, dial, 10, "my-group", "my-dot");
    expect(group.getAttribute("class")).toBe("my-group");
    expect(dial.contains(group)).toBe(true);
    const dot = group.querySelector(".my-dot");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("r")).toBe("5.5");
    const { x, y } = dialPlacement(10);
    expect(dot?.getAttribute("cx")).toBe(String(x));
    expect(dot?.getAttribute("cy")).toBe(String(y));
  });

  it("positionDemoBody moves an already-drawn body to a new day's spot", () => {
    const dial = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const group = drawDemoBody(document, dial, 10, "my-group", "my-dot");
    positionDemoBody(group, 5, "my-dot");
    const { x, y } = dialPlacement(5);
    const dot = group.querySelector(".my-dot");
    expect(dot?.getAttribute("cx")).toBe(String(x));
    expect(dot?.getAttribute("cy")).toBe(String(y));
  });
});

describe("#1151 W3-Q4: every chapter calls the shared helper", () => {
  const files = {
    "03-lands.js": { draw: "drawLandedBody", group: "tourfilm-lands-body", dot: "tourfilm-lands-dot", positions: false },
    "05-time-runs.js": { draw: "drawTimeBody", position: "positionTimeBody", group: "tourfilm-time-body", dot: "tourfilm-time-dot", positions: true },
    "09-done.js": { draw: "drawTimeBody", position: "positionTimeBody", group: "tourfilm-time-body", dot: "tourfilm-time-dot", positions: true },
    "12-yours.js": { draw: "drawYearBody", position: "positionYearBody", group: "tourfilm-year-body", dot: "tourfilm-year-dot", positions: true },
  };

  for (const [file, spec] of Object.entries(files)) {
    it(`${file} delegates to demo-body.js with its own class names`, () => {
      const src = readFileSync(
        resolve(import.meta.dirname, `../../web/src/lib/tour/chapters/${file}`),
        "utf8",
      );
      expect(src).toMatch(/from "\.\/demo-body\.js";/u);
      expect(src).toContain(`drawDemoBody(doc, dial, days, "${spec.group}", "${spec.dot}")`);
      if (spec.positions) {
        expect(src).toContain(`positionDemoBody(group, days, "${spec.dot}")`);
      }
      // none of the four re-declare the shared scaffolding any more
      expect(src).not.toMatch(/function ease\(t\)/u);
    });
  }
});
